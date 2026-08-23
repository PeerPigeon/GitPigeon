import { createHash } from 'node:crypto';
import { installNativeWebRTC } from './webrtc.js';

// Pairing over the mesh uses PeerPigeon's own encryption, which is unsea
// underneath. GitPigeon used to run a second key exchange on top: a one-time
// P-256 ECDH keypair per request, an AES-256-GCM envelope, and a `publicKey`
// field carried in the announcement. `sendEncryptedDirect` already performs an
// authenticated per-peer exchange against the peer key PeerPigeon discovered,
// so none of that belongs here.
export const DEVICE_APPROVAL_NETWORK_ID = 'gitpigeon-device-approval-v1';
export const DEVICE_APPROVAL_SESSION_ID = 'approved-browser-discovery-v1';
export const MESH_PAIRING_PROTOCOL = 'gitpigeon-mesh-pairing/1';
const REQUEST_ID = /^[a-f0-9]{32}$/;
const ANNOUNCE_INTERVAL_MS = 5_000;
const PAIRING_TTL_MS = 5 * 60_000;

export function deviceApprovalNodeOptions() {
  return {
    // Crypto must be on: the grant travels through sendEncryptedDirect, which
    // throws on a node without it. The announcement itself stays public — it
    // carries no secret and every approver needs to see it.
    crypto: {},
    networkId: DEVICE_APPROVAL_NETWORK_ID,
    sessionId: DEVICE_APPROVAL_SESSION_ID,
    minPeers: 1,
    maxPeers: 5,
    tolerantPeers: 0,
    autoDiscover: true,
    autoConnect: true,
  };
}

/**
 * Six digits both sides derive from the requester's PeerPigeon public key —
 * the same key unsea encrypts the grant to. Nothing extra crosses the mesh:
 * the requester reads its own key, the approver reads the key PeerPigeon
 * discovered for that peer, and a human checks they agree before a capability
 * is released. A mismatch means the grant would go to a different key.
 */
export function pairingCode(browserPublicKey, watcherPublicKey) {
  const browser = String(browserPublicKey ?? '');
  const watcher = String(watcherPublicKey ?? '');
  if (!browser || !watcher) throw new Error('A pairing code requires both peers\' public keys');
  // Both keys, so the digits identify this pair and not just the browser.
  // Deriving from the browser alone made every machine show the same code, so
  // confirming it said nothing about which machine was being approved.
  const digest = createHash('sha256')
    .update('gitpigeon:pair-code:v3\0')
    .update(browser)
    .update('\0')
    .update(watcher)
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function validateMeshPairingRequest(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return null;
  if (value.protocol !== MESH_PAIRING_PROTOCOL || value.kind !== 'request') return null;
  const requestId = String(value.requestId ?? '');
  const issuedAt = Date.parse(String(value.issuedAt ?? ''));
  const expiresAt = Date.parse(String(value.expiresAt ?? ''));
  if (!REQUEST_ID.test(requestId)) return null;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt || expiresAt - issuedAt > PAIRING_TTL_MS + 1_000
    || now > expiresAt || issuedAt - now > 60_000) return null;
  return {
    protocol: MESH_PAIRING_PROTOCOL,
    kind: 'request',
    requesterKind: value.requesterKind === 'browser' ? 'browser' : 'native',
    requestId,
    deviceName: String(value.deviceName || 'New device').trim().slice(0, 120),
    platform: String(value.platform || 'unknown').slice(0, 32),
    arch: String(value.arch || 'unknown').slice(0, 32),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function createMeshPairingRequest({
  requestId,
  deviceName,
  platform = process.platform,
  arch = process.arch,
  now = Date.now(),
} = {}) {
  return {
    protocol: MESH_PAIRING_PROTOCOL,
    kind: 'request',
    requesterKind: 'native',
    requestId,
    deviceName: String(deviceName || 'New device').trim().slice(0, 120),
    platform: String(platform).slice(0, 32),
    arch: String(arch).slice(0, 32),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
  };
}

function decode(value) {
  if (typeof value === 'object' && value !== null) return value;
  if (typeof value !== 'string' || value.length > 200_000) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function createNode(nodeFactory) {
  if (nodeFactory) return nodeFactory(deviceApprovalNodeOptions());
  await installNativeWebRTC();
  const { PeerPigeonNode } = await import('peerpigeon');
  return new PeerPigeonNode(deviceApprovalNodeOptions());
}

/** The side asking to be paired. */
export async function startDeviceApprovalRequester(request, {
  logger = {},
  onGrant = () => {},
  nodeFactory,
} = {}) {
  const valid = validateMeshPairingRequest(request);
  if (!valid) throw new Error('Invalid GitPigeon pairing request');
  const node = await createNode(nodeFactory);
  let closed = false;

  const receive = (message) => {
    if (closed || message?.local || !message?.encrypted) return;
    const value = decode(message.data);
    if (!value || value.protocol !== MESH_PAIRING_PROTOCOL || value.kind !== 'grant') return;
    if (value.requestId !== valid.requestId) return;
    // PeerPigeon decrypted this to our key, so no second unwrap is needed.
    Promise.resolve(onGrant(value.capability))
      .catch((error) => logger.debug?.(`Pairing grant: ${error.message}`));
  };
  const announce = () => {
    if (closed) return;
    try { node.broadcast(valid); } catch (error) { logger.debug?.(`Pairing announcement: ${error.message}`); }
  };

  node.mesh.on('identity:ready', ({ clientId } = {}) => {
    logger.debug?.(`[pairing] identity ready as ${String(clientId ?? 'unknown').slice(0, 12)}`);
  });
  node.on('message', receive);
  node.on('peerConnected', announce);
  node.on('error', (error) => logger.debug?.(`Pairing mesh: ${error?.message ?? error}`));

  await node.start();
  announce();
  const timer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  timer.unref?.();

  return {
    node,
    request: valid,
    /** This peer's own PeerPigeon key, paired with the approver's. */
    code(watcherPublicKey) {
      return pairingCode(node.getKeyPair().pub, watcherPublicKey);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      node.off('message', receive);
      node.off('peerConnected', announce);
      await node.destroy();
    },
  };
}

/** The side approving a pairing, used by `git pigeon pair`. */
export async function startDeviceApprovalResponder({
  logger = {},
  onRequest = () => {},
  onAdopt = null,
  nodeFactory,
  requestStaleMs = 20_000,
  keyTimeoutMs = 8_000,
} = {}) {
  const node = await createNode(nodeFactory);
  const requests = new Map();
  // Peers this machine has already handed a capability to. Only they may ask
  // it to join an index, so a stranger cannot redirect this machine.
  const granted = new Set();
  let closed = false;

  const receive = (message) => {
    if (closed || message?.local || !message?.fromPeerId) return;
    const value = decode(message.data);
    // The only thing that means the capability was actually taken.
    if (value?.protocol === MESH_PAIRING_PROTOCOL && value.kind === 'accepted') {
      const acked = requests.get(String(value.requestId ?? ''));
      if (acked) acked.accepted = true;
      return;
    }
    // A browser this machine already offered itself to, asking it to join the
    // index it settled on, so a set of machines ends up together.
    if (value?.protocol === MESH_PAIRING_PROTOCOL && value.kind === 'adopt') {
      if (!onAdopt || !message.encrypted || !granted.has(String(message.fromPeerId))) return;
      Promise.resolve(onAdopt(value.capability))
        .catch((error) => logger.debug?.(`Adopt request: ${error.message}`));
      return;
    }
    const request = validateMeshPairingRequest(value);
    if (!request) return;
    const known = requests.get(request.requestId);
    if (known) {
      // Update in place: an in-flight approve() holds this record and reads
      // lastSeenAt to tell whether the requester is still asking.
      known.request = request;
      known.peerId = String(message.fromPeerId);
      known.lastSeenAt = Date.now();
      return;
    }
    requests.set(request.requestId, {
      request,
      peerId: String(message.fromPeerId),
      lastSeenAt: Date.now(),
      accepted: false,
    });
    Promise.resolve(onRequest(request)).catch((error) => logger.debug?.(error.message));
  };

  node.mesh.on('identity:ready', ({ clientId } = {}) => {
    logger.debug?.(`[pairing] identity ready as ${String(clientId ?? 'unknown').slice(0, 12)}`);
  });
  node.mesh.on('signaling:connected', ({ signalingServer } = {}) => {
    logger.debug?.(`[pairing] signaling connected through ${signalingServer ?? 'a federated relay'}`);
  });
  node.on('message', receive);
  node.on('error', (error) => logger.debug?.(`Pairing mesh: ${error?.message ?? error}`));

  await node.start();

  return {
    node,
    pending() {
      const now = Date.now();
      for (const [requestId, record] of requests) {
        const expired = Date.parse(record.request.expiresAt) <= now;
        if (expired || now - record.lastSeenAt > requestStaleMs) requests.delete(requestId);
      }
      return [...requests.values()]
        .sort((left, right) => left.request.issuedAt.localeCompare(right.request.issuedAt))
        .map(({ request }) => request);
    },
    /** The requester's PeerPigeon key, as discovered by this node. */
    async codeFor(requestId) {
      const record = requests.get(String(requestId));
      if (!record) throw new Error('That pairing request is no longer being advertised');
      const known = node.getPublicKey(record.peerId)
        ?? await node.waitForPeerKey(record.peerId, keyTimeoutMs);
      return pairingCode(known.pub, node.getKeyPair().pub);
    },
    /**
     * Hand a capability to one requester. PeerPigeon encrypts it to that peer's
     * key with unsea; nothing here wraps it a second time.
     *
     * A direct send is fire-and-forget, so this resends until the requester
     * stops re-announcing, which is what it does once it accepts.
     */
    async approve(requestId, capability, {
      confirmMs = 15_000,
      resendMs = 1_500,
      quietMs = 3_000,
    } = {}) {
      const record = requests.get(String(requestId));
      if (!record) throw new Error('That pairing request is no longer being advertised');
      const grant = JSON.stringify({
        protocol: MESH_PAIRING_PROTOCOL,
        kind: 'grant',
        requestId: record.request.requestId,
        // Without this the browser cannot derive the same per-pair code.
        watcherPublicKey: node.getKeyPair().pub,
        capability,
      });
      granted.add(record.peerId);
      const send = () => node.sendEncryptedDirect(record.peerId, grant);
      await send();
      let lastSentAt = Date.now();
      const deadline = lastSentAt + confirmMs;
      // Silence is not acceptance. A browser that was closed or reloaded stops
      // announcing exactly like one that accepted, and treating that as
      // success left machines believing they were paired to a browser that had
      // never stored anything — and then refusing to pair with any other.
      while (Date.now() < deadline && !record.accepted) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (closed) break;
        if (Date.now() - lastSentAt >= resendMs) {
          await send().catch((error) => logger.debug?.(`Pairing resend: ${error.message}`));
          lastSentAt = Date.now();
        }
      }
      const confirmed = Boolean(record.accepted);
      requests.delete(record.request.requestId);
      return { request: record.request, confirmed };
    },
    async close() {
      if (closed) return;
      closed = true;
      node.off('message', receive);
      await node.destroy();
    },
  };
}
