import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { installNativeWebRTC } from './webrtc.js';

export const INDEX_PROTOCOL = 'gitpigeon-index/1';
export const INDEX_NETWORK_ID = 'gitpigeon-index-v1';
export const INDEX_HEARTBEAT_MS = 3_000;
export const INDEX_STALE_MS = 12_000;

const STATE_VERSION = 1;
const INDEX_ID = /^[a-f0-9]{32}$/;
const SECRET = /^[a-zA-Z0-9_-]{32,256}$/;
const DEVICE = /^[a-zA-Z0-9_-]{8,128}$/;
const LOCK_STALE_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function machineIndexRoot(environment = process.env, platform = process.platform) {
  if (environment.GITPIGEON_STATE_DIR) return path.resolve(environment.GITPIGEON_STATE_DIR);
  if (platform === 'win32') {
    return path.join(environment.LOCALAPPDATA ?? environment.APPDATA ?? homedir(), 'GitPigeon');
  }
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'GitPigeon');
  return path.join(environment.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'gitpigeon');
}

function statePaths(root) {
  return {
    state: path.join(root, 'index.json'),
    lock: path.join(root, 'index.lock'),
  };
}

function validEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const repository = String(value.repository ?? '');
  const repositoryId = String(value.repositoryId ?? '');
  const secret = String(value.secret ?? '');
  const deviceId = String(value.deviceId ?? '');
  const name = String(value.name ?? '').trim().slice(0, 200);
  const pid = value.pid === null || value.pid === undefined ? null : Number(value.pid);
  const signalingServer = value.signalingServer ? String(value.signalingServer) : undefined;
  if (!path.isAbsolute(repository) || repository.length > 4_096) return null;
  if (!DEVICE.test(repositoryId) || !SECRET.test(secret) || !DEVICE.test(deviceId) || !name) return null;
  if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) return null;
  if (signalingServer && !/^wss?:\/\//i.test(signalingServer)) return null;
  return { repository, repositoryId, secret, deviceId, name, pid, ...(signalingServer ? { signalingServer } : {}) };
}

function validateState(value) {
  if (!value || value.version !== STATE_VERSION || !INDEX_ID.test(String(value.indexId)) || !SECRET.test(String(value.secret))) {
    throw new Error('Invalid GitPigeon machine index');
  }
  const entries = Array.isArray(value.entries) ? value.entries.map(validEntry).filter(Boolean) : [];
  return {
    version: STATE_VERSION,
    indexId: String(value.indexId),
    secret: String(value.secret),
    pairingLaunched: value.pairingLaunched === true,
    entries,
  };
}

function freshState() {
  return {
    version: STATE_VERSION,
    indexId: randomBytes(16).toString('hex'),
    secret: randomBytes(32).toString('base64url'),
    pairingLaunched: false,
    entries: [],
  };
}

async function readState(root, { create = true } = {}) {
  const { state } = statePaths(root);
  try {
    return validateState(JSON.parse(await readFile(state, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) throw error;
    return freshState();
  }
}

async function writeState(root, value) {
  const { state } = statePaths(root);
  const temporary = `${state}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(validateState(value), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, state);
}

async function withLock(root, operation) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const { lock } = statePaths(root);
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await rm(lock, { force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const details = await stat(lock);
        if (Date.now() - details.mtimeMs > LOCK_STALE_MS) await rm(lock, { force: true });
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out updating the GitPigeon machine index at ${root}`);
      await sleep(25);
    }
  }
}

export async function loadMachineIndex({ root = machineIndexRoot(), create = true } = {}) {
  if (!create) return await readState(root, { create: false });
  return await withLock(root, async () => {
    const value = await readState(root);
    await writeState(root, value);
    return value;
  });
}

export async function registerMachinePigeon(repository, config, { root = machineIndexRoot(), pid = process.pid } = {}) {
  return await withLock(root, async () => {
    const value = await readState(root);
    const entry = validEntry({
      repository: repository.root,
      repositoryId: config.repositoryId,
      secret: config.secret,
      deviceId: config.deviceId,
      name: path.basename(repository.root),
      pid,
      signalingServer: config.signalingServer,
    });
    if (!entry) throw new Error('Could not register this repository with the encrypted GitPigeon index');
    value.entries = [...value.entries.filter((item) => item.repository !== repository.root), entry];
    await writeState(root, value);
    return value;
  });
}

export async function unregisterMachinePigeon(repository, { root = machineIndexRoot() } = {}) {
  return await withLock(root, async () => {
    const value = await readState(root);
    const previous = value.entries.length;
    value.entries = value.entries.filter((item) => item.repository !== repository.root);
    await writeState(root, value);
    return { removed: value.entries.length !== previous, state: value };
  });
}

export async function markMachinePigeonStopped(repository, {
  root = machineIndexRoot(),
  pid = process.pid,
} = {}) {
  return await withLock(root, async () => {
    const value = await readState(root);
    let changed = false;
    value.entries = value.entries.map((entry) => {
      if (entry.repository !== repository.root || entry.pid !== pid) return entry;
      changed = true;
      return { ...entry, pid: null };
    });
    await writeState(root, value);
    return { changed, state: value };
  });
}

export async function clearMachinePigeons({ root = machineIndexRoot() } = {}) {
  return await withLock(root, async () => {
    const value = await readState(root);
    value.entries = [];
    await writeState(root, value);
    return value;
  });
}

export function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function listMachinePigeons({ root = machineIndexRoot(), activeOnly = true } = {}) {
  let value;
  try {
    value = await readState(root, { create: false });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return value.entries
    .filter((entry) => !activeOnly || processIsRunning(entry.pid))
    .sort((left, right) => left.name.localeCompare(right.name) || left.repository.localeCompare(right.repository));
}

export function directoryKey(indexId) {
  return `gitpigeon/index/v1/${indexId}/directory`;
}

export function directoryValue(index, entries, now = Date.now()) {
  const grouped = new Map();
  for (const entry of entries) {
    const active = processIsRunning(entry.pid) ? 1 : 0;
    const current = grouped.get(entry.repositoryId);
    if (!current) {
      grouped.set(entry.repositoryId, {
        repositoryId: entry.repositoryId,
        secret: entry.secret,
        name: entry.name,
        watcherCount: active,
        ...(entry.signalingServer ? { signalingServer: entry.signalingServer } : {}),
      });
    } else {
      current.watcherCount += active;
    }
  }
  return {
    protocol: INDEX_PROTOCOL,
    indexId: index.indexId,
    updatedAt: new Date(now).toISOString(),
    pigeons: [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function pairingUrl(index, baseUrl = 'https://gitpigeon.dev/') {
  const capability = `${index.indexId}.${index.secret}`;
  const url = new URL(baseUrl);
  url.hash = `pair=${encodeURIComponent(capability)}`;
  return url.toString();
}

export async function claimPairingUrl({ root = machineIndexRoot(), baseUrl } = {}) {
  return await withLock(root, async () => {
    const value = await readState(root);
    if (value.pairingLaunched) return null;
    value.pairingLaunched = true;
    await writeState(root, value);
    return pairingUrl(value, baseUrl);
  });
}

export function openDashboard(url, {
  platform = process.platform,
  environment = process.env,
  spawnImpl = spawn,
} = {}) {
  if (!url || environment.GITPIGEON_NO_BROWSER === '1') return false;
  let command;
  let args;
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawnImpl(command, args, { detached: true, windowsHide: true, shell: false, stdio: 'ignore' });
  child.unref?.();
  return true;
}

export async function connectMachineIndex(repository, config, logger = {}, {
  root = machineIndexRoot(),
  heartbeatMs = INDEX_HEARTBEAT_MS,
} = {}) {
  await installNativeWebRTC();
  const index = await registerMachinePigeon(repository, config, { root });
  const { PeerPigeonNode } = await import('peerpigeon');
  const prefix = `gitpigeon/index/v1/${index.indexId}/`;
  const node = new PeerPigeonNode({
    networkId: INDEX_NETWORK_ID,
    sessionId: index.indexId,
    minPeers: 1,
    maxPeers: 8,
    tolerantPeers: 2,
    autoDiscover: true,
    autoConnect: true,
    storage: {
      userId: `index-${config.deviceId}`,
      sessionId: `${INDEX_NETWORK_ID}:${index.indexId}`,
      syncSecret: index.secret,
      dbName: `gitpigeon-index-${index.indexId}`,
      syncFilter: (_space, key) => String(key).startsWith(prefix),
    },
  });
  node.on('error', (error) => logger.error?.(error));
  let closed = false;
  let publishQueue = Promise.resolve();
  const publish = ({ reconcile = false } = {}) => {
    const operation = publishQueue.then(async () => {
      if (closed) return;
      const storage = node.storage;
      if (!storage) return;
      if (reconcile) {
        await storage.retrieve('public', directoryKey(index.indexId), { timeoutMs: 750 });
      }
      const current = await loadMachineIndex({ root });
      await storage.put('public', directoryKey(current.indexId), directoryValue(current, current.entries));
    });
    publishQueue = operation.catch(() => {});
    return operation;
  };
  node.on('peerConnected', () => { publish({ reconcile: true }).catch((error) => logger.error?.(error)); });
  try {
    await node.start();
  } catch (error) {
    await markMachinePigeonStopped(repository, { root }).catch(() => {});
    await node.destroy().catch(() => {});
    throw error;
  }
  if (!node.storage) {
    await markMachinePigeonStopped(repository, { root }).catch(() => {});
    await node.destroy();
    throw new Error('PeerPigeon index storage did not initialize');
  }
  node.storage.subscribeKey('public', directoryKey(index.indexId));
  await publish({ reconcile: true });
  const timer = setInterval(() => { publish().catch((error) => logger.error?.(error)); }, heartbeatMs);
  return {
    index,
    node,
    async close() {
      if (closed) return;
      clearInterval(timer);
      await publishQueue;
      await markMachinePigeonStopped(repository, { root });
      try {
        const current = await loadMachineIndex({ root });
        await node.storage?.put('public', directoryKey(current.indexId), directoryValue(current, current.entries));
      } catch (error) {
        logger.error?.(error);
      }
      closed = true;
      await node.destroy();
    },
  };
}
