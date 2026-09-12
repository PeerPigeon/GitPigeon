// Keep tooling artifacts out of cloud storage.
//
// A repository that lives in iCloud Drive, Dropbox, OneDrive or Google Drive
// drags every `node_modules`, `.venv`, `dist` and `target` it ever grows into
// the cloud: hundreds of thousands of files nobody wants backed up, uploaded
// on every install and downloaded onto every other machine. GitPigeon never
// syncs those trees itself, and the cloud client should not either.
//
// Each provider has its own way of being told to skip a folder:
//   - Any macOS File Provider domain (iCloud Drive on macOS 14+, and Dropbox,
//     OneDrive, Google Drive and Box under ~/Library/CloudStorage) honours the
//     `com.apple.fileprovider.ignore#P` extended attribute. Verified with
//     `fileproviderctl evaluate`: the item reports isExcludedFromSync = 1 and
//     its children leave the provider's item list.
//   - Dropbox additionally documents `com.dropbox.ignored` (an xattr on macOS
//     and Linux, an NTFS alternate data stream on Windows), which also covers
//     the legacy non-File-Provider client.
//   - OneDrive and iCloud on Windows, and the legacy OneDrive and Google Drive
//     clients on macOS, have no per-folder marker. Those are reported so the
//     person can move the repository, not silently left syncing.
//
// Markers vanish with the directory (`rm -rf node_modules && npm install`),
// so the repository watcher re-applies them whenever an artifact directory
// shows activity, and a periodic sweep catches anything the watcher missed.
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Regenerable trees: dependencies, build output, caches. Never `.git`, and
// never another VCS's metadata — those are data, not tooling.
export const TOOLING_DIRECTORIES = new Set([
  'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build', 'out', 'target',
  'coverage', '.cache', '__pycache__', '.next', '.nuxt', '.turbo', '.vinext',
  '.wrangler', '.gitpigeon-build',
]);

export const FILE_PROVIDER_IGNORE_XATTR = 'com.apple.fileprovider.ignore#P';
export const FILE_PROVIDER_DOMAIN_XATTR = 'com.apple.file-provider-domain-id';
export const DROPBOX_IGNORE_XATTR = 'com.dropbox.ignored';
export const DROPBOX_IGNORE_XATTR_LINUX = 'user.com.dropbox.ignored';
export const DROPBOX_IGNORE_STREAM = 'com.dropbox.ignored';

const WALK_LIMIT = 200_000;
const SWEEP_WALK_LIMIT = 5_000_000;
const REMARK_DELAY_MS = 1_000;

export function isToolingDirectory(name) {
  return TOOLING_DIRECTORIES.has(String(name ?? '').toLowerCase());
}

// The first tooling directory on a repository-relative path, or null.
// `packages/web/node_modules/pkg/index.js` -> `packages/web/node_modules`.
export function toolingDirectoryOf(relativePath) {
  const parts = String(relativePath ?? '').replaceAll('\\', '/').split('/').filter(Boolean);
  const index = parts.findIndex((part) => isToolingDirectory(part));
  return index === -1 ? null : parts.slice(0, index + 1).join('/');
}

function providerFromDomain(domain) {
  const value = String(domain).toLowerCase();
  if (value.includes('clouddocs') || value.includes('icloud')) return 'icloud';
  if (value.includes('dropbox')) return 'dropbox';
  if (value.includes('onedrive')) return 'onedrive';
  if (value.includes('google') || value.includes('drivefs')) return 'google-drive';
  if (value.includes('box')) return 'box';
  return 'file-provider';
}

export function providerLabel(provider) {
  return {
    icloud: 'iCloud Drive',
    dropbox: 'Dropbox',
    onedrive: 'OneDrive',
    'google-drive': 'Google Drive',
    box: 'Box',
    'file-provider': 'cloud storage',
  }[provider] ?? 'cloud storage';
}

function isInside(directory, root) {
  const relative = path.relative(root, directory);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function dropboxRoots({ homedir, env, platform, read }) {
  const info = platform === 'win32'
    ? path.join(env.APPDATA ?? path.join(homedir, 'AppData', 'Roaming'), 'Dropbox', 'info.json')
    : path.join(homedir, '.dropbox', 'info.json');
  try {
    const parsed = JSON.parse(await read(info, 'utf8'));
    return Object.values(parsed ?? {})
      .map((account) => account?.path)
      .filter((value) => typeof value === 'string' && value);
  } catch {
    return [];
  }
}

/**
 * Which cloud client, if any, syncs `directory`, and how it can be told to
 * skip a folder. Returns null when the directory is not cloud-synced.
 *
 * @returns {Promise<null | {
 *   provider: string,
 *   root: string,
 *   markers: Array<'file-provider' | 'dropbox-xattr' | 'dropbox-xattr-linux' | 'dropbox-stream'>,
 * }>}
 */
export async function detectCloudStorage(directory, {
  platform = process.platform,
  homedir = os.homedir(),
  env = process.env,
  run = execFileAsync,
  read = readFile,
} = {}) {
  let resolved = path.resolve(directory);
  try {
    resolved = await realpath(resolved);
  } catch {
    // A directory that does not resolve is still judged by its path.
  }

  if (platform === 'darwin') {
    // The domain attribute sits on the synced root (~/Documents when Desktop &
    // Documents sync is on, ~/Library/CloudStorage/<Provider-account>, or the
    // iCloud container itself) — not on every descendant. One xattr call
    // over every ancestor: matches print `path: value`, misses print nothing.
    const ancestors = [];
    for (let current = resolved; ; current = path.dirname(current)) {
      ancestors.push(current);
      if (path.dirname(current) === current) break;
    }
    let stdout = '';
    try {
      ({ stdout } = await run('xattr', ['-p', FILE_PROVIDER_DOMAIN_XATTR, ...ancestors], { encoding: 'utf8' }));
    } catch (error) {
      stdout = String(error?.stdout ?? '');
    }
    let match = null;
    for (const line of String(stdout).split('\n')) {
      const separator = line.lastIndexOf(': ');
      if (separator === -1) continue;
      const root = line.slice(0, separator);
      const domain = line.slice(separator + 2).trim();
      if (!ancestors.includes(root) || !domain) continue;
      if (!match || root.length > match.root.length) match = { root, domain };
    }
    if (match) {
      const provider = providerFromDomain(match.domain);
      const markers = ['file-provider'];
      if (provider === 'dropbox') markers.push('dropbox-xattr');
      return { provider, root: match.root, markers };
    }
    for (const root of await dropboxRoots({ homedir, env, platform, read })) {
      if (isInside(resolved, path.resolve(root))) return { provider: 'dropbox', root, markers: ['dropbox-xattr'] };
    }
    for (const [provider, name] of [['onedrive', 'OneDrive'], ['google-drive', 'Google Drive'], ['box', 'Box']]) {
      const root = path.join(homedir, name);
      if (isInside(resolved, root)) return { provider, root, markers: [] };
    }
    return null;
  }

  if (platform === 'win32') {
    for (const root of await dropboxRoots({ homedir, env, platform, read })) {
      if (isInside(resolved, path.resolve(root))) return { provider: 'dropbox', root, markers: ['dropbox-stream'] };
    }
    for (const variable of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const root = env[variable];
      if (root && isInside(resolved, path.resolve(root))) return { provider: 'onedrive', root, markers: [] };
    }
    const icloud = path.join(homedir, 'iCloudDrive');
    if (isInside(resolved, icloud)) return { provider: 'icloud', root: icloud, markers: [] };
    return null;
  }

  for (const root of await dropboxRoots({ homedir, env, platform, read })) {
    if (isInside(resolved, path.resolve(root))) return { provider: 'dropbox', root, markers: ['dropbox-xattr-linux'] };
  }
  return null;
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function readMarker(marker, directory, run) {
  try {
    if (marker === 'file-provider' || marker === 'dropbox-xattr') {
      const name = marker === 'file-provider' ? FILE_PROVIDER_IGNORE_XATTR : DROPBOX_IGNORE_XATTR;
      const { stdout } = await run('xattr', ['-p', name, directory], { encoding: 'utf8' });
      return String(stdout).trim() === '1';
    }
    if (marker === 'dropbox-xattr-linux') {
      const { stdout } = await run('getfattr', ['--only-values', '-n', DROPBOX_IGNORE_XATTR_LINUX, directory], { encoding: 'utf8' });
      return String(stdout).trim() === '1';
    }
    if (marker === 'dropbox-stream') {
      const script = `Get-Content -LiteralPath ${powershellLiteral(directory)} -Stream ${DROPBOX_IGNORE_STREAM}`;
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return String(stdout).trim() === '1';
    }
  } catch {
    // Absent marker, or a tool that could not read it: write it.
  }
  return false;
}

async function writeMarker(marker, directory, run) {
  if (marker === 'file-provider' || marker === 'dropbox-xattr') {
    const name = marker === 'file-provider' ? FILE_PROVIDER_IGNORE_XATTR : DROPBOX_IGNORE_XATTR;
    await run('xattr', ['-w', name, '1', directory]);
    return;
  }
  if (marker === 'dropbox-xattr-linux') {
    await run('setfattr', ['-n', DROPBOX_IGNORE_XATTR_LINUX, '-v', '1', directory]);
    return;
  }
  if (marker === 'dropbox-stream') {
    const script = `Set-Content -LiteralPath ${powershellLiteral(directory)} -Stream ${DROPBOX_IGNORE_STREAM} -Value 1`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    return;
  }
  throw new Error(`Unknown cloud storage marker: ${marker}`);
}

/**
 * Mark one directory as excluded from cloud sync. Idempotent: an existing
 * marker is left alone (rewriting it would only stir the file watcher).
 * Returns true when at least one marker was newly written.
 */
export async function excludeDirectoryFromCloudSync(directory, markers, { run = execFileAsync } = {}) {
  let written = false;
  for (const marker of markers) {
    if (await readMarker(marker, directory, run)) continue;
    await writeMarker(marker, directory, run);
    written = true;
  }
  return written;
}

/**
 * Every tooling directory in a working tree, repository-relative with `/`
 * separators. Does not descend into `.git` or into a tooling directory
 * itself — one marker on `node_modules` covers everything beneath it.
 */
export async function findToolingDirectories(root, { list = readdir, limit = WALK_LIMIT } = {}) {
  const found = [];
  let visited = 0;
  const walk = async (directory, prefix) => {
    if (visited > limit) return;
    let entries;
    try {
      entries = await list(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > limit) return;
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === '.Trash') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isToolingDirectory(entry.name)) {
        found.push(relative);
        continue;
      }
      await walk(path.join(directory, entry.name), relative);
    }
  };
  await walk(root, '');
  return found.sort();
}

async function existingDirectories(candidates, stat) {
  const found = [];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) found.push(candidate);
    } catch {
      // Not on this machine.
    }
  }
  return found;
}

/**
 * Every cloud-synced folder on this machine, whether or not a GitPigeon
 * repository lives in it: synced Desktop and Documents, the iCloud Drive
 * container, everything under ~/Library/CloudStorage, Dropbox, OneDrive.
 * A `node_modules` in an unmanaged project churns the cloud client just as
 * hard as one in a watched repository.
 */
export async function cloudSyncedRoots({
  platform = process.platform,
  homedir = os.homedir(),
  env = process.env,
  run = execFileAsync,
  read = readFile,
  stat = lstat,
  list = readdir,
} = {}) {
  const roots = [];
  const seen = new Set();
  const add = (entry) => {
    const key = path.resolve(entry.root);
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ ...entry, root: key });
  };
  const dropbox = await dropboxRoots({ homedir, env, platform, read });

  if (platform === 'darwin') {
    const candidates = [path.join(homedir, 'Desktop'), path.join(homedir, 'Documents')];
    try {
      for (const entry of await list(path.join(homedir, 'Library', 'CloudStorage'), { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(homedir, 'Library', 'CloudStorage', entry.name));
      }
    } catch {
      // No File Provider clients installed.
    }
    const present = await existingDirectories(candidates, stat);
    let stdout = '';
    if (present.length) {
      try {
        ({ stdout } = await run('xattr', ['-p', FILE_PROVIDER_DOMAIN_XATTR, ...present], { encoding: 'utf8' }));
      } catch (error) {
        stdout = String(error?.stdout ?? '');
      }
    }
    for (const line of String(stdout).split('\n')) {
      const separator = line.lastIndexOf(': ');
      if (separator === -1) continue;
      const root = line.slice(0, separator);
      const domain = line.slice(separator + 2).trim();
      if (!present.includes(root) || !domain) continue;
      const provider = providerFromDomain(domain);
      add({ provider, root, markers: provider === 'dropbox' ? ['file-provider', 'dropbox-xattr'] : ['file-provider'] });
    }
    for (const root of await existingDirectories([path.join(homedir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')], stat)) {
      add({ provider: 'icloud', root, markers: ['file-provider'] });
    }
    for (const root of await existingDirectories(dropbox, stat)) add({ provider: 'dropbox', root, markers: ['dropbox-xattr'] });
    for (const [provider, name] of [['onedrive', 'OneDrive'], ['google-drive', 'Google Drive'], ['box', 'Box']]) {
      for (const root of await existingDirectories([path.join(homedir, name)], stat)) add({ provider, root, markers: [] });
    }
    return roots;
  }

  if (platform === 'win32') {
    for (const root of await existingDirectories(dropbox, stat)) add({ provider: 'dropbox', root, markers: ['dropbox-stream'] });
    for (const variable of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      if (env[variable]) for (const root of await existingDirectories([env[variable]], stat)) add({ provider: 'onedrive', root, markers: [] });
    }
    for (const root of await existingDirectories([path.join(homedir, 'iCloudDrive')], stat)) add({ provider: 'icloud', root, markers: [] });
    return roots;
  }

  for (const root of await existingDirectories(dropbox, stat)) add({ provider: 'dropbox', root, markers: ['dropbox-xattr-linux'] });
  return roots;
}

/**
 * Walk every cloud-synced folder on this machine and exclude each tooling
 * directory found. Idempotent; safe to run on a timer.
 */
export async function sweepCloudStorage({
  log = null,
  roots = null,
  platform = process.platform,
  homedir = os.homedir(),
  env = process.env,
  run = execFileAsync,
  read = readFile,
  stat = lstat,
  list = readdir,
  limit = SWEEP_WALK_LIMIT,
} = {}) {
  const targets = roots ?? await cloudSyncedRoots({ platform, homedir, env, run, read, stat, list });
  const report = [];
  for (const target of targets) {
    const label = providerLabel(target.provider);
    const directories = await findToolingDirectories(target.root, { list, limit });
    const entry = { root: target.root, provider: target.provider, found: directories.length, marked: [], failed: [] };
    report.push(entry);
    if (!target.markers.length) {
      if (directories.length) {
        log?.warn?.(`${label} has no per-folder exclusion, so ${directories.length} tooling ${directories.length === 1 ? 'directory' : 'directories'} under ${target.root} will be uploaded.`);
      }
      continue;
    }
    for (const relative of directories) {
      const absolute = path.join(target.root, ...relative.split('/'));
      try {
        const info = await stat(absolute);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (await excludeDirectoryFromCloudSync(absolute, target.markers, { run })) entry.marked.push(relative);
      } catch (error) {
        entry.failed.push({ path: relative, error: error.message });
      }
    }
    if (entry.marked.length) {
      const shown = entry.marked.slice(0, 5).join(', ');
      const more = entry.marked.length > 5 ? ` and ${entry.marked.length - 5} more` : '';
      log?.info?.(`${label}: excluded ${entry.marked.length} tooling ${entry.marked.length === 1 ? 'directory' : 'directories'} under ${target.root} from cloud sync (${shown}${more})`);
    }
    if (entry.failed.length) {
      log?.warn?.(`${label}: could not exclude ${entry.failed.length} under ${target.root}, first: ${entry.failed[0].path}: ${entry.failed[0].error}`);
    }
  }
  return report;
}

/**
 * Per-repository guard: detects the cloud client once, marks every existing
 * tooling directory, and re-marks any that the watcher sees activity in.
 */
export class CloudSyncGuard {
  constructor(root, {
    log = null,
    platform = process.platform,
    homedir = os.homedir(),
    env = process.env,
    run = execFileAsync,
    read = readFile,
    list = readdir,
    stat = lstat,
    remarkDelayMs = REMARK_DELAY_MS,
  } = {}) {
    this.root = root;
    this.log = log;
    this.options = { platform, homedir, env, run, read };
    this.list = list;
    this.stat = stat;
    this.remarkDelayMs = remarkDelayMs;
    this.detection = undefined;
    this.pending = new Set();
    this.timer = null;
    this.closed = false;
    this.failed = new Set();
    this.warned = false;
  }

  async detect() {
    if (this.detection === undefined) {
      this.detection = detectCloudStorage(this.root, this.options).catch((error) => {
        this.log?.debug?.(`Cloud storage detection for ${this.root}: ${error.message}`);
        return null;
      });
    }
    return await this.detection;
  }

  /** Marks every tooling directory currently on disk. Returns the ones newly marked. */
  async protectAll() {
    const cloud = await this.detect();
    if (!cloud) return [];
    const directories = await findToolingDirectories(this.root, { list: this.list });
    return await this.#mark(cloud, directories);
  }

  /** A watcher event under `relativePath`: re-mark its tooling directory soon. */
  noteChange(relativePath) {
    if (this.closed) return;
    const directory = toolingDirectoryOf(relativePath);
    if (!directory) return;
    this.pending.add(directory);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((error) => this.log?.debug?.(`Cloud storage guard: ${error.message}`));
    }, this.remarkDelayMs);
    this.timer.unref?.();
  }

  async flush() {
    const directories = [...this.pending];
    this.pending.clear();
    if (!directories.length) return [];
    const cloud = await this.detect();
    if (!cloud) return [];
    return await this.#mark(cloud, directories);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  async #mark(cloud, directories) {
    const label = providerLabel(cloud.provider);
    if (!cloud.markers.length) {
      if (directories.length && !this.warned) {
        this.warned = true;
        this.log?.warn?.(
          `${label} has no per-folder exclusion, so ${directories.join(', ')} under ${this.root} `
          + 'will be uploaded. Move the repository outside the synced folder to keep tooling artifacts out of the cloud.',
        );
      }
      return [];
    }
    const marked = [];
    for (const relative of directories) {
      const absolute = path.join(this.root, ...relative.split('/'));
      try {
        // Only a real directory is marked: an event for a deleted tree is not
        // an invitation to recreate it, and a symlink (the old `.nosync`
        // trick) already keeps its target elsewhere.
        const info = await this.stat(absolute);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      try {
        if (await excludeDirectoryFromCloudSync(absolute, cloud.markers, { run: this.options.run })) {
          marked.push(relative);
          this.failed.delete(relative);
        }
      } catch (error) {
        if (!this.failed.has(relative)) {
          this.failed.add(relative);
          this.log?.warn?.(`Could not exclude ${relative} from ${label} sync: ${error.message}`);
        }
      }
    }
    if (marked.length) this.log?.info?.(`${label}: excluded ${marked.join(', ')} from cloud sync in ${this.root}`);
    return marked;
  }
}
