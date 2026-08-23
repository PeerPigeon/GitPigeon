import { createHash } from 'node:crypto';
import { pairingCode } from './pairing-identity.js';
import { installNativeWebRTC } from './webrtc.js';

// Pairing over the mesh uses PeerPigeon's own encryption, which is unsea
// underneath. GitPigeon used to run a second key exchange on top: a one-time
// P-256 ECDH keypair per request, an AES-256-GCM envelope, and a `publicKey`
// field carried in the announcement. `sendEncryptedDirect` already performs an
// authenticated per-peer exchange against the peer key PeerPigeon discovered,
// so none of that belongs here.
// Overridable so a test can run watchers and browsers on a network of their
// own. Without it there is no way to exercise pairing except on the one real
// network every installed watcher is listening to.
export const DEVICE_APPROVAL_NETWORK_ID = process.env.GITPIGEON_APPROVAL_NETWORK_ID
  || 'gitpigeon-device-approval-v1';
export const DEVICE_APPROVAL_SESSION_ID = 'approved-browser-discovery-v1';
export const MESH_PAIRING_PROTOCOL = 'gitpigeon-mesh-pairing/1';
const REQUEST_ID = /^[a-f0-9]{32}$/;
const ANNOUNCE_INTERVAL_MS = 5_000;
const PAIRING_TTL_MS = 5 * 60_000;

export function deviceApprovalNodeOptions(keyPair) {
  return {
    // Crypto must be on: the grant travels through sendEncryptedDirect, which
    // throws on a node without it. The announcement itself stays public — it
    // carries no secret and every approver needs to see it.
    // A stable key pair keeps this machine's pairing code the same across
    // restarts; without one PeerPigeon mints a fresh identity every start and
    // the code printed at install would not survive the next boot.
    crypto: keyPair ? { keyPair } : {},
    networkId: DEVICE_APPROVAL_NETWORK_ID,
    sessionId: DEVICE_APPROVAL_SESSION_ID,
    // Peer formation is PeerPigeon's decision; see peerpigeon.js.
  };
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
    ...(/^[0-9a-f]{64}$/.test(String(value.indexFingerprint ?? ''))
      ? { indexFingerprint: String(value.indexFingerprint) }
      : {}),
    ...(value.diagnostics && typeof value.diagnostics === 'object' ? { diagnostics: {
      build: String(value.diagnostics.build ?? '').slice(0, 32),
      indexPeers: Number.isSafeInteger(value.diagnostics.indexPeers) ? value.diagnostics.indexPeers : null,
      publishedAgoMs: Number.isSafeInteger(value.diagnostics.publishedAgoMs) ? value.diagnostics.publishedAgoMs : null,
      ...(value.diagnostics.indexError ? { indexError: String(value.diagnostics.indexError).slice(0, 300) } : {}),
    } } : {}),
    platform: String(value.platform || 'unknown').slice(0, 32),
    arch: String(value.arch || 'unknown').slice(0, 32),
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * A public, one-way name for an index. A browser compares this against its own
 * to recognise a machine it has already taken in, without either side putting
 * the index id — let alone its secret — on an unencrypted announcement.
 */
export function indexFingerprint(indexId) {
  if (!indexId) return null;
  return createHash('sha256')
    .update('gitpigeon:index-fingerprint:v1\0')
    .update(String(indexId))
    .digest('hex');
}

export function createMeshPairingRequest({
  requestId,
  deviceName,
  platform = process.platform,
  arch = process.arch,
  indexId = null,
  diagnostics = null,
  now = Date.now(),
} = {}) {
  return {
    protocol: MESH_PAIRING_PROTOCOL,
    kind: 'request',
    requesterKind: 'native',
    requestId,
    ...(indexId ? { indexFingerprint: indexFingerprint(indexId) } : {}),
    // The machine states what its index half is doing, so a watcher whose
    // index node cannot reach anyone still says so through the mesh it can
    // reach. Carries no secrets: a build string, peer count, publish age,
    // and an error message.
    ...(diagnostics ? { diagnostics: {
      build: String(diagnostics.build ?? '').slice(0, 32),
      indexPeers: Number.isSafeInteger(diagnostics.indexPeers) ? diagnostics.indexPeers : null,
      publishedAgoMs: Number.isSafeInteger(diagnostics.publishedAgoMs) ? diagnostics.publishedAgoMs : null,
      ...(diagnostics.indexError ? { indexError: String(diagnostics.indexError).slice(0, 300) } : {}),
    } } : {}),
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

async function createNode(nodeFactory, keyPair) {
  const options = deviceApprovalNodeOptions(keyPair);
  if (nodeFactory) return nodeFactory(options);
  await installNativeWebRTC();
  const { PeerPigeonNode } = await import('peerpigeon');
  return new PeerPigeonNode(options);
}

/** The side asking to be paired. */
export async function startDeviceApprovalRequester(request, {
  logger = {},
  onGrant = () => {},
  nodeFactory,
  keyPair,
} = {}) {
  const valid = validateMeshPairingRequest(request);
  if (!valid) throw new Error('Invalid GitPigeon pairing request');
  const node = await createNode(nodeFactory, keyPair);
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
    /** The approving watcher's key, which is what the digits identify. */
    code(watcherPublicKey) {
      return pairingCode(watcherPublicKey);
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
  keyPair,
  // Offering this machine and answering browsers are the same job on the same
  // mesh, so they share one node. A second node per machine put two peers on
  // the approval mesh for every device, and with a small partial mesh the
  // browser could end up linked to one machine's pair and never see the other.
  offerDeviceName = null,
  offerIndexId = null,
  offerDiagnostics = null,
  onGrant = null,
} = {}) {
  const node = await createNode(nodeFactory, keyPair);
  const statusLines = new Map();
  const offerRequestId = keyPair?.pub
    ? createHash('sha256').update('gitpigeon:offer-id:v1\0').update(String(keyPair.pub)).digest('hex').slice(0, 32)
    : null;
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
    // A browser approving this machine's own offer, handing it an index.
    if (value?.protocol === MESH_PAIRING_PROTOCOL && value.kind === 'grant') {
      if (!onGrant || !message.encrypted || value.requestId !== offerRequestId) return;
      Promise.resolve(onGrant(value.capability))
        .catch((error) => logger.debug?.(`Pairing grant: ${error.message}`));
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
    if (request.requesterKind === 'native' && request.diagnostics) {
      const d = request.diagnostics;
      // Publish age moves every round; bucket it so only real changes log.
      const line = `${request.deviceName} build=${d.build || '?'} indexPeers=${d.indexPeers ?? '?'} published=${d.publishedAgoMs === null ? 'never' : Math.round(d.publishedAgoMs / 60_000) + 'm ago'}${d.indexError ? ` error="${d.indexError}"` : ''}`;
      if (statusLines.get(request.requestId) !== line) {
        statusLines.set(request.requestId, line);
        logger.info?.(`[watcher-status] ${line}`);
      }
    }
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
  const announceOffer = () => {
    if (closed || !offerRequestId || !offerDeviceName) return;
    try {
      node.broadcast(createMeshPairingRequest({
        requestId: offerRequestId,
        deviceName: offerDeviceName,
        indexId: offerIndexId,
        diagnostics: offerDiagnostics?.() ?? null,
      }));
    } catch (error) {
      logger.debug?.(`Watcher offer: ${error.message}`);
    }
  };
  node.on('message', receive);
  node.on('peerConnected', announceOffer);
  node.on('error', (error) => logger.debug?.(`Pairing mesh: ${error?.message ?? error}`));

  await node.start();
  announceOffer();
  // Minted fresh each round: a pairing request expires, and approvers reject
  // stale ones, so rebroadcasting one object made a machine visible only for
  // its first few minutes.
  const offerTimer = setInterval(announceOffer, ANNOUNCE_INTERVAL_MS);
  offerTimer.unref?.();

  return {
    node,
    offerRequestId,
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
    /**
     * This machine's own code. It is the same for every browser, because the
     * digits identify the watcher being approved, not the pair — so it can be
     * shown before any browser has asked.
     */
    code() {
      return pairingCode(node.getKeyPair().pub);
    },
    async codeFor() {
      return pairingCode(node.getKeyPair().pub);
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
