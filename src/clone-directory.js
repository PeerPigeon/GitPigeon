import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { machineIndexRoot } from './machine-index.js';

// Where this machine puts the repositories it clones — from a dashboard's
// Clone button, a share link, an approved index, or `git pigeon clone`.
//
// It used to be an environment variable or ~/Documents/GitPigeon, and an
// environment variable reaches exactly one process: the shell that exported
// it. The watcher service, the gitpigeon:// URL handler and the CLI are three
// different processes, and only one of them ever saw it. The directory is a
// machine setting, stated once with `git pigeon clone-dir`, read by every
// path that clones.
const SETTINGS_FILE = 'settings.json';

export function defaultCloneDirectory(environment = process.env) {
  return path.resolve(environment.GITPIGEON_CLONE_DIR ?? path.join(homedir(), 'Documents', 'GitPigeon'));
}

export async function readSettings({ root = machineIndexRoot() } = {}) {
  try {
    const value = JSON.parse(await readFile(path.join(root, SETTINGS_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

async function writeSettings(value, { root = machineIndexRoot() } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, SETTINGS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** The directory new clones land in: the stated setting, else the default. */
export async function cloneDirectory({ root = machineIndexRoot(), environment = process.env } = {}) {
  const settings = await readSettings({ root });
  const stated = typeof settings.cloneDirectory === 'string' ? settings.cloneDirectory.trim() : '';
  return stated ? path.resolve(stated) : defaultCloneDirectory(environment);
}

/**
 * State the clone directory (created if missing, so a typo fails here and
 * not at the first clone), or clear it with null to return to the default.
 */
export async function setCloneDirectory(directory, { root = machineIndexRoot() } = {}) {
  const settings = await readSettings({ root });
  if (directory === null) {
    delete settings.cloneDirectory;
    await writeSettings(settings, { root });
    return null;
  }
  const stated = String(directory ?? '').trim();
  if (!stated) throw new Error('The clone directory must be a folder path.');
  const resolved = path.resolve(stated);
  if (resolved === path.resolve('/')) throw new Error('The clone directory must be a folder path.');
  await mkdir(resolved, { recursive: true });
  settings.cloneDirectory = resolved;
  await writeSettings(settings, { root });
  return resolved;
}
