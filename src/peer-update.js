import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { isNewerVersion } from './auto-update.js';

const execFileAsync = promisify(execFile);

/**
 * Watchers update each other over the mesh they already share.
 *
 * The index room is encrypted to paired members, and any member can already
 * open a terminal on the others — so distributing builds between them adds
 * convenience, not trust. A watcher running a newer build than a peer offers
 * it; the peer pulls it chunk by chunk, verifies the announced digest, runs
 * the binary once to prove it executes, installs it beside its other updates
 * and restarts. GitHub releases stop being the only channel — two machines
 * on one LAN converge on the newest build either of them has, including a
 * build that never left the LAN.
 */
export const PEER_UPDATE_PROTOCOL = 'gitpigeon-peer-update/1';
const OFFER_INTERVAL_MS = 60_000;
const CHUNK_BYTES = 96 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^[a-f0-9]{64}$/;

async function digestFile(filename) {
  const hash = createHash('sha256');
  const handle = await open(filename, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

// One fetch machine-wide, however many rooms carry offers.
let activeFetchGlobal = false;

export function startPeerUpdates({
  node,
  root,
  currentVersion,
  executable = process.execPath,
  standalone,
  logger = {},
  onUpdate = () => {},
  platform = process.platform,
  arch = process.arch,
} = {}) {
  let closed = false;
  let offering = null;
  let fetching = null;

  const decode = (value) => {
    if (typeof value === 'object' && value !== null) return value;
    if (typeof value !== 'string' || value.length > 300_000) return null;
    try { return JSON.parse(value); } catch { return null; }
  };

  // What this watcher can offer: its own executable, described once.
  const describeSelf = async () => {
    if (!standalone) return null;
    const details = await stat(executable);
    if (!details.isFile() || details.size > MAX_EXECUTABLE_BYTES) return null;
    return {
      version: currentVersion,
      platform,
      arch,
      size: details.size,
      sha256: await digestFile(executable),
    };
  };

  const announce = () => {
    if (closed || !offering) return;
    try {
      node.broadcast({ protocol: PEER_UPDATE_PROTOCOL, kind: 'offer', ...offering });
    } catch (error) {
      logger.debug?.(`Peer update offer: ${error?.message ?? error}`);
    }
  };

  const beginFetch = async (peerId, offer) => {
    if (fetching || activeFetchGlobal) return;
    activeFetchGlobal = true;
    const version = String(offer.version);
    const directory = path.join(path.resolve(root), 'updates', version);
    const target = path.join(directory, platform === 'win32' ? 'git-pigeon.exe' : 'git-pigeon');
    const temporary = `${target}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'w', 0o755);
    fetching = {
      peerId,
      version,
      sha256: offer.sha256,
      size: offer.size,
      target,
      temporary,
      handle,
      offset: 0,
      startedAt: Date.now(),
    };
    logger.info?.(`Fetching GitPigeon ${version} from a peer on the mesh`);
    await requestChunk();
  };

  const requestChunk = async () => {
    if (!fetching || closed) return;
    await node.sendEncryptedDirect(fetching.peerId, JSON.stringify({
      protocol: PEER_UPDATE_PROTOCOL,
      kind: 'fetch',
      version: fetching.version,
      offset: fetching.offset,
    }));
  };

  const abandonFetch = async (reason) => {
    if (!fetching) return;
    logger.info?.(`Peer update abandoned: ${reason}`);
    await fetching.handle.close().catch(() => {});
    await rm(fetching.temporary, { force: true }).catch(() => {});
    fetching = null;
    activeFetchGlobal = false;
  };

  const finishFetch = async () => {
    const job = fetching;
    fetching = null;
    activeFetchGlobal = false;
    await job.handle.close();
    const digest = await digestFile(job.temporary);
    if (digest !== job.sha256) {
      await rm(job.temporary, { force: true });
      throw new Error('peer executable digest mismatch');
    }
    await chmod(job.temporary, 0o755);
    // The binary must prove it executes before anything points at it.
    await execFileAsync(job.temporary, ['--help'], { timeout: 20_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    await rm(job.target, { force: true });
    await rename(job.temporary, job.target);
    const current = path.join(path.resolve(root), 'updates', 'current.json');
    const record = `${JSON.stringify({
      version: 1,
      releaseVersion: job.version,
      executable: job.target,
      sha256: job.sha256,
      installedAt: new Date().toISOString(),
      channel: 'peer',
    }, null, 2)}\n`;
    const stage = `${current}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(stage, record, { mode: 0o600 });
    await rename(stage, current);
    logger.info?.(`GitPigeon ${job.version} was fetched from a peer, verified and installed; restarting the watcher`);
    await onUpdate({ version: job.version, executable: job.target, sha256: job.sha256 });
  };

  const receive = (message) => {
    if (closed || message?.local) return;
    const value = decode(message.data);
    if (!value || value.protocol !== PEER_UPDATE_PROTOCOL) return;
    const peerId = String(message.fromPeerId ?? '');
    if (value.kind === 'offer') {
      if (!VERSION.test(String(value.version ?? '')) || !DIGEST.test(String(value.sha256 ?? ''))) return;
      if (value.platform !== platform || value.arch !== arch) return;
      if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_EXECUTABLE_BYTES) return;
      if (!isNewerVersion(value.version, currentVersion)) return;
      if (fetching) return;
      beginFetch(peerId, value).catch((error) => {
        logger.info?.(`Peer update failed to start: ${error.message}`);
        abandonFetch(error.message).catch(() => {});
      });
      return;
    }
    if (value.kind === 'fetch') {
      // Serve a slice of our own executable. Membership in this encrypted
      // room is the authorization; the requester verifies the digest.
      if (!offering || !message.encrypted) return;
      const offset = Number(value.offset);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > offering.size) return;
      (async () => {
        const handle = await open(executable, 'r');
        try {
          const length = Math.min(CHUNK_BYTES, offering.size - offset);
          const buffer = Buffer.alloc(length);
          if (length > 0) await handle.read(buffer, 0, length, offset);
          await node.sendEncryptedDirect(peerId, JSON.stringify({
            protocol: PEER_UPDATE_PROTOCOL,
            kind: 'chunk',
            version: offering.version,
            offset,
            size: offering.size,
            payload: buffer.toString('base64'),
          }));
        } finally {
          await handle.close();
        }
      })().catch((error) => logger.debug?.(`Peer update serve: ${error?.message ?? error}`));
      return;
    }
    if (value.kind === 'chunk') {
      if (!fetching || !message.encrypted || peerId !== fetching.peerId) return;
      if (value.version !== fetching.version || Number(value.offset) !== fetching.offset) return;
      (async () => {
        if (Date.now() - fetching.startedAt > FETCH_TIMEOUT_MS) {
          await abandonFetch('timed out');
          return;
        }
        const data = Buffer.from(String(value.payload ?? ''), 'base64');
        if (fetching.offset + data.length > fetching.size) {
          await abandonFetch('peer sent more than it offered');
          return;
        }
        if (data.length > 0) {
          await fetching.handle.write(data, 0, data.length, fetching.offset);
          fetching.offset += data.length;
        }
        if (fetching.offset >= fetching.size || data.length === 0) {
          await finishFetch();
          return;
        }
        await requestChunk();
      })().catch(async (error) => {
        logger.info?.(`Peer update failed: ${error.message}`);
        await abandonFetch(error.message).catch(() => {});
      });
    }
  };

  const onPeer = () => announce();
  node.on('message', receive);
  node.on('peerConnected', onPeer);
  const timer = setInterval(announce, OFFER_INTERVAL_MS);
  timer.unref?.();

  describeSelf()
    .then((description) => {
      offering = description;
      if (description) logger.debug?.(`Offering GitPigeon ${description.version} to mesh peers`);
      announce();
    })
    .catch((error) => logger.debug?.(`Peer update describe: ${error?.message ?? error}`));

  return {
    async stop() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      node.off('message', receive);
      node.off('peerConnected', onPeer);
      await abandonFetch('stopping').catch(() => {});
    },
  };
}

/**
 * Pull a newer build from a mesh peer once, then resolve. Used by
 * `git pigeon update` — the same offer/fetch/verify path the running service
 * uses continuously, run for a bounded window on demand.
 */
export async function pullPeerUpdateOnce({ node, root, currentVersion, standalone, logger = {}, timeoutMs = 30_000 } = {}) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      updater.stop().catch(() => {});
      resolve(value);
    };
    const updater = startPeerUpdates({
      node,
      root,
      currentVersion,
      standalone,
      logger,
      onUpdate: (update) => finish({ updated: true, ...update }),
    });
    const timer = setTimeout(() => finish({ updated: false, timedOut: true }), timeoutMs);
    timer.unref?.();
  });
}
