import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { productionSignalingServers } from './relay-policy.js';
import { installNativeWebRTC } from './webrtc.js';

export const INDEX_PROTOCOL = 'gitpigeon-index/1';
export const INDEX_NETWORK_ID = 'gitpigeon-index-v1';
export const INDEX_HEARTBEAT_MS = 3_000;
export const INDEX_STALE_MS = 12_000;
export const INDEX_PRESENCE_BUCKET_MS = 5_000;

const STATE_VERSION = 3;
const INDEX_ID = /^[a-f0-9]{32}$/;
const SECRET = /^[a-zA-Z0-9_-]{32,256}$/;
const DEVICE = /^[a-zA-Z0-9_-]{8,128}$/;
const LOCK_STALE_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function repositorySnapshotHint(entry, serviceInstanceId, machineIndexId) {
  try {
    const root = path.join(entry.repository, '.git', 'gitpigeon');
    const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    const head = state?.heads?.[entry.deviceId];
    if (!head || head.repositoryId !== entry.repositoryId || head.deviceId !== entry.deviceId
      || !/^[a-f0-9]{64}$/.test(String(head.snapshotId ?? ''))) return null;
    const manifest = JSON.parse(await readFile(path.join(root, 'manifests', `${head.snapshotId}.json`), 'utf8'));
    if (manifest?.protocol !== 'gitpigeon/1' || manifest.repositoryId !== entry.repositoryId
      || manifest.snapshotId !== head.snapshotId || manifest.deviceId !== entry.deviceId) return null;
    return {
      devices: [entry.deviceId],
      heads: [head],
      manifests: [manifest],
      selectedHead: head,
      selectedManifest: manifest,
      repositoryName: entry.name,
      serviceInstanceIds: serviceInstanceId ? [serviceInstanceId] : [],
      serviceInstances: serviceInstanceId ? [{ serviceInstanceId, machineIndexId }] : [],
      browserInstanceIds: [],
    };
  } catch {
    return null;
  }
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
  if (!value || ![1, 2, STATE_VERSION].includes(value.version)
    || !INDEX_ID.test(String(value.indexId)) || !SECRET.test(String(value.secret))) {
    throw new Error('Invalid GitPigeon machine index');
  }
  const entries = Array.isArray(value.entries) ? value.entries.map(validEntry).filter(Boolean) : [];
  return {
    version: STATE_VERSION,
    indexId: String(value.indexId),
    secret: String(value.secret),
    // Version 2 recorded pairingLaunched before the browser acknowledged its
    // grant. It cannot prove enrollment completed, so migrate it to pending and
    // let the next `git pigeon init` retry without rotating the capability.
    pairingComplete: value.version === STATE_VERSION && value.pairingComplete === true,
    pairingMode: value.version === 1 ? 'legacy' : value.pairingMode === 'secure' ? 'secure' : 'legacy',
    entries,
  };
}

function freshState() {
  return {
    version: STATE_VERSION,
    indexId: randomBytes(16).toString('hex'),
    secret: randomBytes(32).toString('base64url'),
    pairingComplete: false,
    pairingMode: 'secure',
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

export async function markMachinePigeonsStopped({
  root = machineIndexRoot(),
  pid = process.pid,
} = {}) {
  return await withLock(root, async () => {
    const value = await readState(root);
    let changed = false;
    value.entries = value.entries.map((entry) => {
      if (entry.pid !== pid) return entry;
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

export function liveDirectoryKey(indexId, bucket) {
  return `gitpigeon/index/v1/${indexId}/live/${bucket}`;
}

export function directoryValue(index, entries, now = Date.now(), serviceInstanceId = null) {
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
        ...(active && serviceInstanceId ? { watcherServiceId: serviceInstanceId } : {}),
        ...(entry.signalingServer ? { signalingServer: entry.signalingServer } : {}),
        ...(entry.snapshot ? { snapshot: entry.snapshot } : {}),
      });
    } else {
      current.watcherCount += active;
      if (!current.snapshot && entry.snapshot) current.snapshot = entry.snapshot;
    }
  }
  return {
    protocol: INDEX_PROTOCOL,
    indexId: index.indexId,
    updatedAt: new Date(now).toISOString(),
    pigeons: [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function claimDashboardPairing({
  root = machineIndexRoot(),
  force = false,
  rotate = false,
} = {}) {
  return await withLock(root, async () => {
    const value = await readState(root);
    if (value.pairingComplete && value.pairingMode === 'secure' && !force) return null;
    const rotated = rotate || value.pairingMode === 'legacy';
    if (rotated) value.secret = randomBytes(32).toString('base64url');
    value.pairingMode = 'secure';
    value.pairingComplete = false;
    await writeState(root, value);
    return { index: value, rotated, root };
  });
}

export async function completeDashboardPairing(index, { root = machineIndexRoot() } = {}) {
  return await withLock(root, async () => {
    const value = await readState(root);
    if (value.indexId !== index?.indexId || value.secret !== index?.secret) {
      throw new Error('This browser enrollment was superseded by a newer GitPigeon pairing');
    }
    value.pairingMode = 'secure';
    value.pairingComplete = true;
    await writeState(root, value);
    return value;
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

async function connectMachineDirectory(index, logger = {}, {
  root = machineIndexRoot(),
  heartbeatMs = INDEX_HEARTBEAT_MS,
  serviceInstanceId = null,
  onClose = async () => {},
} = {}) {
  await installNativeWebRTC();
  const { PeerPigeonNode, DEFAULT_SIGNALING_SERVERS } = await import('peerpigeon');
  const prefix = `gitpigeon/index/v1/${index.indexId}/`;
  const node = new PeerPigeonNode({
    crypto: false,
    networkId: INDEX_NETWORK_ID,
    sessionId: index.indexId,
    minPeers: 1,
    maxPeers: 4,
    tolerantPeers: 1,
    autoDiscover: true,
    autoConnect: true,
    signalingServers: productionSignalingServers(DEFAULT_SIGNALING_SERVERS),
    storage: {
      userId: `index-service-${index.indexId}`,
      sessionId: `${INDEX_NETWORK_ID}:${index.indexId}`,
      syncSecret: index.secret,
      dbName: `gitpigeon-index-${index.indexId}`,
      syncFilter: (_space, key) => String(key).startsWith(prefix),
    },
  });
  const roomLabel = `index ${index.indexId.slice(0, 10)}`;
  node.mesh.on('identity:ready', ({ clientId } = {}) => {
    logger.debug?.(`[${roomLabel}] identity ready as ${String(clientId ?? 'unknown').slice(0, 12)}`);
  });
  node.mesh.on('signaling:connected', ({ clientId, signalingServer } = {}) => {
    logger.debug?.(`[${roomLabel}] signaling connected through ${signalingServer ?? 'a federated relay'} as ${String(clientId ?? 'unknown').slice(0, 12)}`);
  });
  node.mesh.on('signaling:disconnected', () => logger.debug?.(`[${roomLabel}] signaling disconnected`));
  node.mesh.on('signaling:log', ({ message } = {}) => logger.debug?.(`[${roomLabel}] ${message}`));
  node.mesh.on('peer:discovered', (peerId) => logger.debug?.(`[${roomLabel}] discovered ${String(peerId).slice(0, 12)}`));
  let lastRecoveryAt = 0;
  const recover = (reason) => {
    if (node.getConnectedPeers().length > 0 || Date.now() - lastRecoveryAt < 5_000) return;
    lastRecoveryAt = Date.now();
    logger.debug?.(`[${roomLabel}] recovery: ${node.getDiscoveredPeers().length} discovered, ${node.getActiveSignalingPeers().length} active on relay`);
    node.recoverAfterInactivity(reason);
  };
  node.on('error', (error) => {
    logger.error?.(error);
    recover('GitPigeon native index connection error');
  });
  let closed = false;
  let ready = false;
  let needsReconcile = true;
  let publishQueue = Promise.resolve();
  let lastDirectoryFingerprint = null;
  let lastLiveBucket = null;
  const publish = ({ reconcile = false } = {}) => {
    const operation = publishQueue.then(async () => {
      if (closed || !ready) return;
      if (node.getConnectedPeers().length === 0) return;
      const storage = node.storage;
      if (!storage) return;
      if (reconcile || needsReconcile) {
        // Node storage is memory-backed while the browser keeps its IndexedDB
        // record across native process restarts. Import that higher version
        // before the first write or the browser will reject the live update as
        // stale. This must run only after PeerPigeonStorage.init() completes.
        const retrieved = await storage.retrieve('public', directoryKey(index.indexId), { timeoutMs: 2_000 });
        // retrieve() resolves after the first peer responds, but other paired
        // browsers may answer with a higher persisted version. Let all of
        // those responses merge before advancing the record locally.
        await sleep(1_000);
        const settled = await storage.get('public', directoryKey(index.indexId));
        logger.debug?.(`Index directory reconciled at version ${settled?.version ?? retrieved?.version ?? 'none'}`);
        needsReconcile = false;
      }
      const current = await loadMachineIndex({ root });
      const entries = await Promise.all(current.entries.map(async (entry) => ({
        ...entry,
        snapshot: await repositorySnapshotHint(entry, serviceInstanceId, current.indexId),
      })));
      const value = directoryValue(current, entries, Date.now(), serviceInstanceId);
      const fingerprint = JSON.stringify(value.pigeons);
      const directoryChanged = fingerprint !== lastDirectoryFingerprint;
      let record = null;
      if (directoryChanged) {
        record = await storage.put(
          'public',
          directoryKey(current.indexId),
          value,
        );
        lastDirectoryFingerprint = fingerprint;
        logger.debug?.(`Index directory published at version ${record?.version ?? 'unknown'} with ${current.entries.length} ${current.entries.length === 1 ? 'repository' : 'repositories'}`);
      }
      if (serviceInstanceId) {
        const bucket = Math.floor(Date.now() / INDEX_PRESENCE_BUCKET_MS);
        if (directoryChanged || bucket !== lastLiveBucket) {
          await storage.put('public', liveDirectoryKey(current.indexId, bucket), {
            ...value,
            kind: 'live-directory',
            watcherServiceId: serviceInstanceId,
          });
          lastLiveBucket = bucket;
        }
      }
    });
    publishQueue = operation.catch(() => {});
    return operation;
  };
  node.on('peerConnected', (peerId) => {
    logger.debug?.(`[${roomLabel}] peer connected: ${peerId}`);
    if (ready) publish().catch((error) => logger.error?.(error));
  });
  node.on('peerDisconnected', (peerId) => {
    logger.debug?.(`[${roomLabel}] peer disconnected: ${peerId}`);
  });
  try {
    await node.start();
  } catch (error) {
    await node.destroy().catch(() => {});
    throw error;
  }
  if (!node.storage) {
    await node.destroy();
    throw new Error('PeerPigeon index storage did not initialize');
  }
  recover('GitPigeon native initial federated index discovery');
  node.storage.subscribeKey('public', directoryKey(index.indexId));
  ready = true;
  if (node.getConnectedPeers().length > 0) {
    publish({ reconcile: true }).catch((error) => logger.error?.(error));
  }
  const timer = setInterval(() => {
    recover('GitPigeon native index peer retry');
    publish().catch((error) => logger.error?.(error));
  }, heartbeatMs);
  return {
    index,
    node,
    async close() {
      if (closed) return;
      clearInterval(timer);
      await publishQueue;
      await onClose();
      try {
        const current = await loadMachineIndex({ root });
        if (node.getConnectedPeers().length > 0) {
          await node.storage?.put(
            'public',
            directoryKey(current.indexId),
            directoryValue(current, current.entries, Date.now(), serviceInstanceId),
          );
        }
      } catch (error) {
        logger.error?.(error);
      }
      closed = true;
      await node.destroy();
    },
  };
}

export async function connectMachineIndex(repository, config, logger = {}, options = {}) {
  const root = options.root ?? machineIndexRoot();
  const index = await registerMachinePigeon(repository, config, { root });
  return await connectMachineDirectory(index, logger, {
    ...options,
    root,
    onClose: async () => {
      await markMachinePigeonStopped(repository, { root });
      await options.onClose?.();
    },
  });
}

export async function connectMachineIndexService(logger = {}, options = {}) {
  const root = options.root ?? machineIndexRoot();
  const index = await loadMachineIndex({ root });
  return await connectMachineDirectory(index, logger, { ...options, root });
}
