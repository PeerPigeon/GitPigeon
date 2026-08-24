import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RepositoryCache } from './cache.js';

const INVALID_PATTERN = /[\0-\x1f\x7f*?\[\]\\]/;
const SKIP_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', '.venv', 'venv', 'dist',
  'build', 'out', 'target', 'coverage', '.cache', '__pycache__', '.next',
  '.nuxt', '.turbo', '.vinext', '.wrangler', '.gitpigeon-build',
]);
const SKIP_FILES = new Set(['.ds_store', 'thumbs.db']);
export const LIVE_FILE_LIMIT = Infinity;

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function liveWorkspaceDigest(files) {
  const canonical = files
    .map((file) => [
      file.path,
      file.deleted ? '-' : `${file.sha256}\0${file.size}`,
      file.baseSha256 ?? '-',
      file.executable ? 'x' : '-',
    ].join('\0'))
    .join('\n');
  return digest(`gitpigeon-live-workspace-v1\0${canonical}`);
}

export class LiveWorkspace {
  constructor(repository, cache = new RepositoryCache(repository.gitDir), {
    fileLimit = LIVE_FILE_LIMIT,
  } = {}) {
    this.repository = repository;
    this.cache = cache;
    this.fileLimit = fileLimit;
    this.conflictDirectory = path.join(cache.root, 'live-conflicts');
  }

  async init() {
    if (this.repository.bare) return;
    await this.cache.init();
  }

  normalize(input) {
    const raw = String(input ?? '');
    if (!raw || INVALID_PATTERN.test(raw)) {
      throw new Error(`Live file path must be an exact path without glob characters: ${raw || '(empty)'}`);
    }
    const absolute = path.resolve(this.repository.root, raw);
    const relative = path.relative(this.repository.root, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Live file path must stay inside the repository: ${raw}`);
    }
    const normalized = relative.split(path.sep).join('/');
    if (normalized.toLowerCase() === '.git' || normalized.toLowerCase().startsWith('.git/')) {
      throw new Error('Files inside .git cannot be synchronized as live workspace files');
    }
    if (normalized.split('/').some((component) => component.endsWith(' '))) {
      throw new Error(`Live file paths cannot contain trailing spaces: ${raw}`);
    }
    return normalized;
  }

  async snapshot({ privatePaths = [] } = {}) {
    if (this.repository.bare) return { files: [], digest: liveWorkspaceDigest([]), skipped: [] };
    const privateFiles = new Set(privatePaths.map((file) => this.normalize(file)));
    const files = [];
    const skipped = [];
    for (const input of await this.repository.workingTreeFiles()) {
      let file;
      try {
        file = this.normalize(input);
      } catch {
        continue;
      }
      if (privateFiles.has(file) || this.#shouldSkip(file)) continue;
      const baseData = await this.repository.headFile(file);
      const baseSha256 = baseData === null ? null : digest(baseData);
      try {
        await this.#assertSafeParents(file);
        const info = await lstat(this.#absolute(file));
        if (!info.isFile() || info.isSymbolicLink()) {
          skipped.push({ path: file, reason: 'not-a-regular-file' });
          continue;
        }
        if (Number.isFinite(this.fileLimit) && info.size > this.fileLimit) {
          skipped.push({ path: file, reason: 'too-large' });
          continue;
        }
        const data = await readFile(this.#absolute(file));
        const sha256 = digest(data);
        if (sha256 === baseSha256) continue;
        files.push({
          path: file,
          deleted: false,
          size: data.length,
          sha256,
          baseSha256,
          executable: Boolean(info.mode & 0o111),
          data,
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (baseSha256 !== null) {
          files.push({
            path: file,
            deleted: true,
            size: 0,
            sha256: null,
            baseSha256,
            executable: false,
            data: null,
          });
        }
      }
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { files, digest: liveWorkspaceDigest(files), skipped };
  }

  async currentDigest(input) {
    const file = this.normalize(input);
    try {
      await this.#assertSafeParents(file);
      const info = await lstat(this.#absolute(file));
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      return digest(await readFile(this.#absolute(file)));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  get trashDirectory() {
    return path.join(this.repository.gitDir, 'gitpigeon', 'trash');
  }

  async #trashIndex() {
    try {
      const raw = JSON.parse(await readFile(path.join(this.trashDirectory, 'index.json'), 'utf8'));
      return Array.isArray(raw) ? raw.filter((entry) => entry && typeof entry.path === 'string'
        && typeof entry.trashedAt === 'string' && typeof entry.storedAs === 'string') : [];
    } catch {
      return [];
    }
  }

  async #writeTrashIndex(entries) {
    await mkdir(this.trashDirectory, { recursive: true });
    await writeFile(path.join(this.trashDirectory, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
  }

  /**
   * The sync engine never hard-deletes: a retracted or deleted file moves to
   * the quarantine, indexed by original path and time. One buggy retraction
   * already deleted a live file on every machine — quarantine turns that
   * class of bug into a non-event, and honest deletions into reversible ones.
   */
  async quarantine(file) {
    const normalized = this.normalize(file);
    const absolute = this.#absolute(normalized);
    const trashedAt = new Date().toISOString();
    const storedAs = path.join(trashedAt.replaceAll(':', '-'), ...normalized.split('/'));
    const target = path.join(this.trashDirectory, storedAs);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(absolute, target);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const entries = await this.#trashIndex();
    entries.push({ path: normalized, trashedAt, storedAs });
    await this.#writeTrashIndex(entries.slice(-500));
    return { path: normalized, trashedAt };
  }

  /** Everything in quarantine, with content, for publishing. */
  async trashSnapshot() {
    const entries = await this.#trashIndex();
    const files = [];
    for (const entry of entries.slice(-200)) {
      try {
        const data = await readFile(path.join(this.trashDirectory, entry.storedAs));
        if (data.length > 8 * 1024 * 1024) continue;
        files.push({
          path: entry.path,
          trashedAt: entry.trashedAt,
          size: data.length,
          sha256: digest(data),
          data,
        });
      } catch { /* pruned or unreadable */ }
    }
    return files;
  }

  /** Adopt tombstones published by other machines; append-only, by content. */
  async mirrorTrash(incoming) {
    const entries = await this.#trashIndex();
    const known = new Set(entries.map((entry) => `${entry.path}\0${entry.trashedAt}`));
    let changed = false;
    for (const file of incoming) {
      const key = `${file.path}\0${file.trashedAt}`;
      if (known.has(key) || !file.data) continue;
      const storedAs = path.join(String(file.trashedAt).replaceAll(':', '-'), ...String(file.path).split('/'));
      const target = path.join(this.trashDirectory, storedAs);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.data));
      entries.push({ path: file.path, trashedAt: file.trashedAt, storedAs });
      known.add(key);
      changed = true;
    }
    if (changed) await this.#writeTrashIndex(entries.slice(-500));
    return changed;
  }

  /** Bring a tombstoned file back into the working tree. */
  async restoreFromTrash(file, trashedAt = null) {
    const normalized = this.normalize(file);
    const entries = await this.#trashIndex();
    const matches = entries
      .filter((entry) => entry.path === normalized && (!trashedAt || entry.trashedAt === trashedAt))
      .sort((left, right) => right.trashedAt.localeCompare(left.trashedAt));
    const chosen = matches[0];
    if (!chosen) throw new Error(`Nothing tombstoned at ${normalized}`);
    let destination = this.#absolute(normalized);
    try {
      await lstat(destination);
      destination = `${destination}.restored-${Date.now()}`;
    } catch { /* the path is free */ }
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(path.join(this.trashDirectory, chosen.storedAs), destination);
    await this.#writeTrashIndex(entries.filter((entry) => entry !== chosen));
    return { path: normalized, restoredTo: path.relative(this.repository.root, destination) };
  }

  /** Quarantine retention: entries older than thirty days are truly gone. */
  async pruneTrash(maxAgeMs = 30 * 24 * 60 * 60_000) {
    const entries = await this.#trashIndex();
    const keep = [];
    for (const entry of entries) {
      if (Date.now() - Date.parse(entry.trashedAt) > maxAgeMs) {
        await rm(path.join(this.trashDirectory, entry.storedAs), { force: true }).catch(() => {});
      } else {
        keep.push(entry);
      }
    }
    if (keep.length !== entries.length) await this.#writeTrashIndex(keep);
  }

  async prepare(files, baselines, { restoreAll = false, except = new Set() } = {}) {
    const incoming = new Set(files.map((file) => this.normalize(file.path)));
    // `except` paths are never retraction targets: a path owned by a live
    // realtime session is deliberately absent from the incoming set, and
    // treating that absence as "the remote retracted it" DELETED the very
    // file the session was editing — on every machine.
    const targets = Object.keys(baselines)
      .map((file) => this.normalize(file))
      .filter((file) => (restoreAll || !incoming.has(file)) && !except.has(file))
      .sort();
    const restored = [];
    const conflicts = [];
    for (const file of targets) {
      const current = await this.currentDigest(file);
      if (current !== baselines[file] || await this.repository.hasStagedChanges(file)) {
        conflicts.push({ path: file, reason: 'locally-modified', conflictFile: null });
        continue;
      }
      const baseData = await this.repository.headFile(file);
      const baseSha256 = baseData === null ? null : digest(baseData);
      if (current !== baseSha256) {
        if (baseData === null) await this.quarantine(file);
        else await this.repository.restoreWorkingTreeFile(file);
        restored.push(file);
      }
      delete baselines[file];
    }
    return { restored, conflicts };
  }

  async apply(files, baselines, deviceId) {
    if (this.repository.bare && files.length) {
      throw new Error('Cannot restore live workspace files into a bare repository');
    }
    const updated = [];
    const conflicts = [];
    for (const incoming of files) {
      const file = this.normalize(incoming.path);
      const current = await this.currentDigest(file);
      const next = incoming.deleted ? null : incoming.sha256;
      const hasBaseline = Object.prototype.hasOwnProperty.call(baselines, file);
      const staged = await this.repository.hasStagedChanges(file);
      let cleanHead = false;
      if (incoming.baseSha256 !== null && !staged) {
        const head = await this.repository.headFile(file);
        cleanHead = head !== null
          && digest(head) === incoming.baseSha256
          && !await this.repository.hasWorkingTreeChanges(file);
      }
      const safe = current === next
        || (!staged && current === incoming.baseSha256)
        || cleanHead
        || (hasBaseline && current === baselines[file]);
      if (!safe) {
        const conflictFile = await this.#writeConflict(file, incoming, deviceId);
        conflicts.push({ path: file, reason: 'locally-modified', conflictFile });
        baselines[file] = next;
        continue;
      }
      if (current !== next) {
        if (incoming.deleted) await this.quarantine(file);
        else await this.#writeReplace(this.#absolute(file), incoming.data, incoming.executable ? 0o755 : 0o644);
        updated.push(file);
      }
      baselines[file] = next;
    }
    return { updated, conflicts };
  }

  #shouldSkip(file) {
    const parts = file.split('/');
    const name = parts.at(-1);
    if (parts.slice(0, -1).some((part) => SKIP_DIRECTORIES.has(part.toLowerCase()))) return true;
    if (SKIP_FILES.has(name.toLowerCase())) return true;
    return /\.(?:log|tmp|pyc|pyo|tsbuildinfo)$/i.test(name);
  }

  async #assertSafeParents(file) {
    let current = this.repository.root;
    for (const component of file.split('/').slice(0, -1)) {
      current = path.join(current, component);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error(`Live file path has an unsafe parent: ${file}`);
        }
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
    }
  }

  async #writeConflict(file, incoming, deviceId) {
    const safeDevice = String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const target = path.join(this.conflictDirectory, safeDevice, ...file.split('/'));
    if (incoming.deleted) {
      const marker = `${target}.deleted-by-peer`;
      await this.#writeReplace(marker, Buffer.from('This peer deleted the live workspace file.\n'));
      return marker;
    }
    await this.#writeReplace(target, incoming.data, incoming.executable ? 0o755 : 0o644);
    return target;
  }

  async #writeReplace(filename, data, mode = 0o644) {
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, Buffer.from(data), { mode });
      await rename(temporary, filename);
    } catch (error) {
      // Never leave a failed write's temp file behind in the repository.
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  #absolute(file) {
    return path.join(this.repository.root, ...file.split('/'));
  }
}
