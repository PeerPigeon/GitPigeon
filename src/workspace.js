import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RepositoryCache } from './cache.js';

const BEGIN_EXCLUDE = '# BEGIN GitPigeon managed files';
const END_EXCLUDE = '# END GitPigeon managed files';
const INVALID_PATTERN = /[\0-\x1f\x7f*?\[\]\\]/;

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

function atomicData(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export function workspaceDigest(files) {
  const canonical = files
    .map((file) => `${file.path}\0${file.deleted ? '-' : `${file.sha256}\0${file.size}`}\n`)
    .join('');
  return digest(`gitpigeon-workspace-v1\0${canonical}`);
}

export class WorkspaceFiles {
  constructor(repository, cache = new RepositoryCache(repository.gitDir)) {
    this.repository = repository;
    this.cache = cache;
    this.trackedFile = path.join(cache.root, 'tracked-files.json');
    this.conflictDirectory = path.join(cache.root, 'conflicts');
    this.excludeFile = path.join(repository.gitDir, 'info', 'exclude');
  }

  async init() {
    if (this.repository.bare) throw new Error('Private workspace files are not supported in bare repositories');
    await this.cache.init();
    await this.syncExclude();
  }

  normalize(input) {
    const raw = String(input ?? '');
    if (!raw || INVALID_PATTERN.test(raw)) {
      throw new Error(`Private file path must be an exact path without glob characters: ${raw || '(empty)'}`);
    }
    const absolute = path.resolve(this.repository.root, raw);
    const relative = path.relative(this.repository.root, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Private file path must stay inside the repository: ${raw}`);
    }
    const normalized = relative.split(path.sep).join('/');
    if (normalized.toLowerCase() === '.git' || normalized.toLowerCase().startsWith('.git/')) {
      throw new Error('Files inside .git cannot be tracked as private workspace files');
    }
    if (normalized.split('/').some((component) => component.endsWith(' '))) {
      throw new Error(`Private file paths cannot contain trailing spaces: ${raw}`);
    }
    return normalized;
  }

  async list() {
    try {
      const value = JSON.parse(await readFile(this.trackedFile, 'utf8'));
      if (!value || value.version !== 1 || !Array.isArray(value.files)) return [];
      return [...new Set(value.files.map((file) => this.normalize(file)))].sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async track(inputs) {
    if (this.repository.bare) throw new Error('Private workspace files are not supported in bare repositories');
    if (!inputs.length) throw new Error('track requires at least one file path');
    const additions = [...new Set(inputs.map((input) => this.normalize(input)))];
    for (const file of additions) {
      if (await this.repository.isTracked(file)) {
        throw new Error(`${file} is already tracked by Git; run \`git rm --cached -- ${file}\` first`);
      }
      await this.#assertRegularFile(file);
    }
    const files = [...new Set([...(await this.list()), ...additions])].sort();
    await this.#saveList(files);
    await this.syncExclude(files);
    return additions;
  }

  async untrack(inputs) {
    if (!inputs.length) throw new Error('untrack requires at least one file path');
    const removals = new Set(inputs.map((input) => this.normalize(input)));
    const previous = await this.list();
    const files = previous.filter((file) => !removals.has(file));
    await this.#saveList(files);
    await this.syncExclude(files);
    return previous.filter((file) => removals.has(file));
  }

  async acceptRemotePaths(inputs) {
    const incoming = inputs.map((input) => this.normalize(input));
    const files = [...new Set([...(await this.list()), ...incoming])].sort();
    await this.#saveList(files);
    await this.syncExclude(files);
    return files;
  }

  async snapshot() {
    const files = [];
    for (const file of await this.list()) {
      const filename = this.#absolute(file);
      try {
        await this.#assertSafeParents(file);
        const info = await lstat(filename);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`Private workspace path must be a regular file: ${file}`);
        }
        const data = await readFile(filename);
        files.push({ path: file, deleted: false, size: data.length, sha256: digest(data), data });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        files.push({ path: file, deleted: true, size: 0, sha256: null, data: null });
      }
    }
    return { files, digest: workspaceDigest(files) };
  }

  async currentDigest(file) {
    const normalized = this.normalize(file);
    try {
      await this.#assertSafeParents(normalized);
      const info = await lstat(this.#absolute(normalized));
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      return digest(await readFile(this.#absolute(normalized)));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async apply(files, baselines, deviceId) {
    if (this.repository.bare && files.length) {
      throw new Error('Cannot restore private workspace files into a bare repository');
    }
    await this.acceptRemotePaths(files.map((file) => file.path));
    const updated = [];
    const conflicts = [];
    for (const file of files) {
      const normalized = this.normalize(file.path);
      const current = await this.currentDigest(normalized);
      const incoming = file.deleted ? null : file.sha256;
      const hasBaseline = Object.prototype.hasOwnProperty.call(baselines, normalized);
      const safe = current === incoming || (hasBaseline ? current === baselines[normalized] : current === null);
      if (!safe) {
        const conflictFile = await this.#writeConflict(normalized, file, deviceId);
        conflicts.push({ path: normalized, reason: 'locally-modified', conflictFile });
        // Record the incoming version as the comparison baseline. If the user
        // accepts the saved conflict copy, the next peer update can proceed;
        // if the local file remains different, it will continue to conflict.
        baselines[normalized] = incoming;
        continue;
      }
      if (current !== incoming) {
        if (file.deleted) {
          await rm(this.#absolute(normalized), { force: true });
        } else {
          await this.#writeReplace(this.#absolute(normalized), file.data);
        }
        updated.push(normalized);
      }
      baselines[normalized] = incoming;
    }
    return { updated, conflicts };
  }

  async syncExclude(files = null) {
    const tracked = files ?? await this.list();
    await mkdir(path.dirname(this.excludeFile), { recursive: true });
    let current = '';
    try {
      current = await readFile(this.excludeFile, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const lines = current.replace(/\r\n/g, '\n').split('\n');
    const begin = lines.indexOf(BEGIN_EXCLUDE);
    const end = lines.indexOf(END_EXCLUDE);
    if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
      throw new Error(`Malformed GitPigeon section in ${this.excludeFile}`);
    }
    const without = begin === -1 ? lines : [...lines.slice(0, begin), ...lines.slice(end + 1)];
    while (without.length && without.at(-1) === '') without.pop();
    const managed = tracked.length
      ? ['', BEGIN_EXCLUDE, ...tracked.map((file) => `/${file}`), END_EXCLUDE]
      : [];
    const next = [...without, ...managed].join('\n');
    await this.#writeReplace(this.excludeFile, Buffer.from(next ? `${next}\n` : ''));
  }

  async #assertRegularFile(file) {
    try {
      await this.#assertSafeParents(file);
      const info = await lstat(this.#absolute(file));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Private file does not exist: ${file}`);
      throw error;
    }
  }

  async #assertSafeParents(file) {
    let current = this.repository.root;
    for (const component of file.split('/').slice(0, -1)) {
      current = path.join(current, component);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error(`Private file path has an unsafe parent: ${file}`);
        }
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
    }
  }

  async #saveList(files) {
    await mkdir(this.cache.root, { recursive: true });
    await this.#writeReplace(
      this.trackedFile,
      Buffer.from(`${JSON.stringify({ version: 1, files: [...new Set(files)].sort() }, null, 2)}\n`),
    );
  }

  async #writeConflict(file, incoming, deviceId) {
    const safeDevice = String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const target = path.join(this.conflictDirectory, safeDevice, ...file.split('/'));
    if (incoming.deleted) {
      const marker = `${target}.deleted-by-peer`;
      await this.#writeReplace(marker, Buffer.from('This peer deleted the private workspace file.\n'));
      return marker;
    }
    await this.#writeReplace(target, incoming.data);
    return target;
  }

  async #writeReplace(filename, value) {
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temporary, atomicData(value), { mode: 0o600 });
    await rename(temporary, filename);
  }

  #absolute(file) {
    return path.join(this.repository.root, ...file.split('/'));
  }
}
