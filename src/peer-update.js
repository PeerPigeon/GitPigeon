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
// Offers are events: on start and on every peer connect. This re-offer is a
// backstop for a peer that missed both, not the mechanism.
const OFFER_INTERVAL_MS = 10 * 60_000;
// An offer older than this no longer says its peer is online.
const OFFER_FRESH_MS = 5 * 60_000;
// How long a peer with no route is left alone before its offer is tried again.
const UNROUTABLE_MEMORY_MS = 2 * 60_000;
// Measured on the real mesh: encrypted direct messages deliver up to 32 KiB,
// silently vanish from 48 KiB, and overflow the crypto layer's stack from
// 128 KiB. 192 KiB slices meant every serve attempt died and every fetch
// stalled out at 45s. 16 KiB matches DEFAULT_CHUNK_SIZE and its documented
// headroom for PeerPigeon's encryption and gossip envelopes. The server
// picks the slice size, so older pullers are fixed by this end alone.
const CHUNK_BYTES = 16 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const FETCH_STALL_MS = 45_000;
const FETCH_RETRY_MS = 2_500;
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
// One responder per node, however many sessions share it. The machine index
// service and every repository session ride the SAME node; attaching a
// responder per caller meant every fetch request was answered once per
// responder — the puller received each offset in duplicate, its offset
// advanced twice per write, and the assembled executable failed its digest.
const respondingNodes = new WeakSet();

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
  if (node && respondingNodes.has(node)) {
    return { stop: async () => {} };
  }
  if (node) respondingNodes.add(node);
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
      lastChunkAt: Date.now(),
    };
    logger.info?.(`Fetching GitPigeon ${version} from a peer on the mesh`);
    // A lost chunk must never wedge the fetch: the next chunk was only ever
    // requested on receiving the previous one, so one dropped message
    // stalled the transfer forever — and the machine-wide fetch flag stayed
    // locked, silently ignoring every later offer. Re-ask on silence, give
    // up only after a real stall.
    fetching.retryTimer = setInterval(() => {
      const job = fetching;
      if (!job) return;
      if (Date.now() - job.lastChunkAt > FETCH_STALL_MS) {
        abandonFetch('stalled: no chunk for 45s').catch(() => {});
        return;
      }
      if (Date.now() - job.lastChunkAt > FETCH_RETRY_MS) {
        requestChunk().catch(() => {});
      }
    }, FETCH_RETRY_MS);
    fetching.retryTimer.unref?.();
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
    if (fetching.retryTimer) clearInterval(fetching.retryTimer);
    logger.info?.(`Peer update abandoned: ${reason}`);
    await fetching.handle.close().catch(() => {});
    await rm(fetching.temporary, { force: true }).catch(() => {});
    fetching = null;
    activeFetchGlobal = false;
  };

  const finishFetch = async () => {
    const job = fetching;
    if (job.retryTimer) clearInterval(job.retryTimer);
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

  // Offers heard recently, by the peer that made them: what the mesh can
  // hand us without GitHub.
  const offers = new Map();
  // Try the newest offered build from every peer that offers it, newest
  // version first, skipping peers with no route; a peer that cannot be
  // reached is remembered as such so the next offer from it is not tried
  // again for a while. Resolves 'started', 'in-progress', 'none' (nothing
  // newer offered) or 'no-route' (offered, but by nobody reachable) — the
  // last is what makes a GitHub download necessary.
  const fetchNewestOffered = async () => {
    if (fetching) return 'in-progress';
    const candidates = freshOffers()
      .filter((offer) => isNewerVersion(offer.version, currentVersion) && !(offer.unroutableUntil > Date.now()))
      .sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0));
    if (candidates.length === 0) return freshOffers().some((offer) => isNewerVersion(offer.version, currentVersion)) ? 'no-route' : 'none';
    for (const offer of candidates) {
      try {
        await beginFetch(offer.peerId, offer);
        return 'started';
      } catch (error) {
        await abandonFetch(error.message).catch(() => {});
        if (!/No route to peer/i.test(String(error?.message ?? error))) {
          logger.info?.(`Peer update failed to start: ${error.message}`);
          continue;
        }
        offer.unroutableUntil = Date.now() + UNROUTABLE_MEMORY_MS;
        logger.debug?.(`Peer update: no route to ${String(offer.peerId).slice(0, 12)} offering ${offer.version}; trying the next peer`);
      }
    }
    return 'no-route';
  };
  const startFetch = () => {
    fetchNewestOffered().catch((error) => logger.debug?.(`Peer update: ${error?.message ?? error}`));
  };
  const receive = (message) => {
    if (closed || message?.local) return;
    const value = decode(message.data);
    if (!value || value.protocol !== PEER_UPDATE_PROTOCOL) return;
    // A broadcast's fromPeerId is the hop that relayed it; the offer came
    // from the envelope's sender, and that is the peer to fetch from.
    // Fetching from the hop was "No route to peer" and an abandoned update.
    const origin = String(message.message?.sender ?? message.message?.from ?? '');
    const peerId = value.kind === 'offer' && origin ? origin : String(message.fromPeerId ?? '');
    if (value.kind === 'offer') {
      if (!VERSION.test(String(value.version ?? '')) || !DIGEST.test(String(value.sha256 ?? ''))) return;
      if (value.platform !== platform || value.arch !== arch) return;
      if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_EXECUTABLE_BYTES) return;
      const previous = offers.get(peerId);
      offers.set(peerId, { ...value, peerId, at: Date.now(), unroutableUntil: previous?.unroutableUntil ?? 0 });
      if (!isNewerVersion(value.version, currentVersion)) return;
      if (fetching) return;
      startFetch();
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
      // Claim this offset before the first await: a duplicate chunk for the
      // same offset arriving while the write is in flight passed the check
      // above too, and both handlers advancing the offset skipped a slice —
      // the assembled executable then failed its digest. The synchronous
      // claim makes the duplicate fail the offset check instead.
      const job = fetching;
      const data = Buffer.from(String(value.payload ?? ''), 'base64');
      const offset = job.offset;
      if (offset + data.length > job.size) {
        abandonFetch('peer sent more than it offered').catch(() => {});
        return;
      }
      job.offset += data.length;
      job.lastChunkAt = Date.now();
      (async () => {
        if (data.length > 0) {
          await job.handle.write(data, 0, data.length, offset);
        }
        // The fetch may have been abandoned while the write was in flight.
        if (fetching !== job) return;
        if (job.offset >= job.size || data.length === 0) {
          await finishFetch();
          return;
        }
        await requestChunk();
      })().catch(async (error) => {
        logger.info?.(`Peer update failed: ${error.message}`);
        if (fetching === job) await abandonFetch(error.message).catch(() => {});
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

  const freshOffers = () => {
    const now = Date.now();
    for (const [peerId, offer] of offers) if (now - offer.at > OFFER_FRESH_MS) offers.delete(peerId);
    return [...offers.values()];
  };
  return {
    isFetching() {
      return fetching !== null;
    },
    /** Whether any other watcher has offered a build lately — other watchers are online. */
    peersOffering() {
      return freshOffers().length > 0;
    },
    /** The newest build a peer has offered lately, or null. */
    newestOffer() {
      let best = null;
      for (const offer of freshOffers()) if (!best || isNewerVersion(offer.version, best.version)) best = offer;
      return best;
    },
    /** Fetch the newest offered build now from any reachable peer offering it. */
    async fetchNewest() {
      return await fetchNewestOffered();
    },
    async stop() {
      if (closed) return;
      closed = true;
      if (node) respondingNodes.delete(node);
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
export async function pullPeerUpdateOnce({ node, root, currentVersion, standalone, logger = {}, timeoutMs = 60_000 } = {}) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
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
    // The deadline applies to finding an offer, never to a transfer that is
    // making progress — a large executable takes minutes, and giving up at
    // the deadline mid-download abandoned working fetches.
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (updater.isFetching()) return;
      if (Date.now() >= deadline) finish({ updated: false, timedOut: true });
    }, 1_000);
    timer.unref?.();
  });
}
