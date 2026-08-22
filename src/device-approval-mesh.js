import {
  DEVICE_GRANT_PROTOCOL,
  openDeviceGrant,
  sealDeviceGrant,
  validateDeviceEnrollmentRequest,
} from './device-grants.js';
import { installNativeWebRTC } from './webrtc.js';

// This discovery room used to open one PartialMesh per candidate relay and
// re-announce on all of them every second, duplicating the relay federation and
// health-check failover FreeRTC already performs. One node is enough.
//
// Announcements also move from `mesh.broadcast`, which only reaches direct
// data-channel neighbours, to PeerPigeon gossip, which floods the room. An
// unapproved device is now visible to every approved browser present rather
// than only to the ones it happened to dial.
export const DEVICE_APPROVAL_NETWORK_ID = 'gitpigeon-device-approval-v1';
export const DEVICE_APPROVAL_SESSION_ID = 'approved-browser-discovery-v1';
const ANNOUNCE_INTERVAL_MS = 5_000;

function validApprovalEnvelope(value, request) {
  return value?.protocol === DEVICE_GRANT_PROTOCOL
    && value.purpose === 'enrollment'
    && value.requestId === request.requestId
    && value.recipientPublicKey === request.publicKey;
}

function decode(value) {
  if (typeof value === 'object' && value !== null) return value;
  if (typeof value !== 'string' || value.length > 60_000) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function deviceApprovalNodeOptions() {
  return {
    // Requests are public by design and grants are separately encrypted to the
    // requesting device's key, so this room needs no shared secret.
    crypto: false,
    networkId: DEVICE_APPROVAL_NETWORK_ID,
    sessionId: DEVICE_APPROVAL_SESSION_ID,
    minPeers: 1,
    maxPeers: 5,
    tolerantPeers: 0,
    autoDiscover: true,
    autoConnect: true,
  };
}

export async function startDeviceApprovalRequester(identity, requestValue, {
  logger = {},
  onGrant = () => {},
  nodeFactory,
} = {}) {
  const request = validateDeviceEnrollmentRequest(requestValue);
  if (!request) throw new Error('Invalid GitPigeon device approval request');

  let PeerPigeonNode;
  if (!nodeFactory) {
    await installNativeWebRTC();
    ({ PeerPigeonNode } = await import('peerpigeon'));
  }
  let closed = false;
  const options = deviceApprovalNodeOptions();
  const node = nodeFactory ? nodeFactory(options) : new PeerPigeonNode(options);

  const receive = (message) => {
    if (closed || message?.local) return;
    const envelope = decode(message?.data);
    if (!validApprovalEnvelope(envelope, request)) return;
    try {
      const grant = openDeviceGrant(identity, envelope, { purpose: 'enrollment' });
      Promise.resolve(onGrant(envelope, grant))
        .catch((error) => logger.debug?.(`Device approval mesh grant: ${error.message}`));
    } catch (error) {
      logger.debug?.(`Ignored invalid PeerPigeon device approval: ${error.message}`);
    }
  };
  const announce = () => {
    if (closed) return;
    try {
      node.broadcast(request);
    } catch (error) {
      logger.debug?.(`Device approval mesh announcement: ${error.message}`);
    }
  };

  node.mesh.on('identity:ready', ({ clientId } = {}) => {
    logger.debug?.(`[device approval] identity ready as ${String(clientId ?? 'unknown').slice(0, 12)}`);
  });
  node.mesh.on('signaling:connected', ({ signalingServer } = {}) => {
    logger.debug?.(`[device approval] signaling connected through ${signalingServer ?? 'a federated relay'}`);
  });
  node.mesh.on('peer:discovered', (peerId) => {
    logger.debug?.(`[device approval] discovered ${String(peerId ?? 'unknown').slice(0, 12)}`);
  });
  node.on('message', receive);
  node.on('peerConnected', announce);
  node.on('error', (error) => logger.debug?.(`Device approval mesh: ${error?.message ?? error}`));

  await node.start();
  announce();
  const timer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  timer.unref?.();

  return {
    node,
    nodes: [node],
    request,
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


/**
 * The approving side of the same discovery room.
 *
 * Until now only browsers could approve a pairing, so the very first browser on
 * a machine had nothing to ask: it told the user to "open an already-approved
 * GitPigeon browser" when none existed. A watcher host can answer that request
 * directly, which is what `git pigeon pair` uses.
 */
export async function startDeviceApprovalResponder({
  logger = {},
  onRequest = () => {},
  nodeFactory,
  requestStaleMs = 20_000,
} = {}) {
  let PeerPigeonNode;
  if (!nodeFactory) {
    await installNativeWebRTC();
    ({ PeerPigeonNode } = await import('peerpigeon'));
  }
  const options = deviceApprovalNodeOptions();
  const node = nodeFactory ? nodeFactory(options) : new PeerPigeonNode(options);
  const requests = new Map();
  let closed = false;

  const receive = (message) => {
    if (closed || message?.local || !message?.fromPeerId) return;
    const request = validateDeviceEnrollmentRequest(decode(message.data));
    if (!request) return;
    const known = requests.get(request.requestId);
    if (known) {
      // Update in place. Replacing the object would leave an in-flight approve()
      // holding a stale record whose lastSeenAt never advances, so a requester
      // that is still asking would read as having accepted the grant.
      known.request = request;
      known.peerId = String(message.fromPeerId);
      known.lastSeenAt = Date.now();
    } else {
      requests.set(request.requestId, {
        request,
        peerId: String(message.fromPeerId),
        lastSeenAt: Date.now(),
      });
    }
    if (!known) {
      Promise.resolve(onRequest(request)).catch((error) => logger.debug?.(error.message));
    }
  };

  node.mesh.on('identity:ready', ({ clientId } = {}) => {
    logger.debug?.(`[device pairing] identity ready as ${String(clientId ?? 'unknown').slice(0, 12)}`);
  });
  node.mesh.on('signaling:connected', ({ signalingServer } = {}) => {
    logger.debug?.(`[device pairing] signaling connected through ${signalingServer ?? 'a federated relay'}`);
  });
  node.on('message', receive);
  node.on('error', (error) => logger.debug?.(`Device pairing mesh: ${error?.message ?? error}`));

  await node.start();

  return {
    node,
    /** Live requests, oldest first, with expired and silent ones dropped. */
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
     * Encrypt a capability to one requester's one-time key and deliver it.
     *
     * A direct send is fire-and-forget, so this does not return until the
     * requester stops re-announcing itself — which is what happens the moment
     * it accepts a grant. Until then the grant is resent, because tearing the
     * node down right after a send drops the message before it leaves.
     */
    async approve(requestId, capability, {
      confirmMs = 15_000,
      resendMs = 1_500,
      quietMs = 3_000,
    } = {}) {
      const record = requests.get(String(requestId));
      if (!record) throw new Error('That pairing request is no longer being advertised');
      const envelope = sealDeviceGrant(
        record.request.publicKey,
        record.request.requestId,
        capability,
        { purpose: 'enrollment' },
      );
      const send = () => {
        if (!node.sendDirect(record.peerId, envelope)) {
          throw new Error(`${record.request.deviceName} is no longer reachable`);
        }
      };
      send();
      let lastSentAt = Date.now();
      const deadline = lastSentAt + confirmMs;
      let confirmed = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (closed) break;
        // The requester announces itself on a short timer while it waits, so a
        // gap in those announcements means it has taken the grant and stopped.
        if (Date.now() - record.lastSeenAt >= quietMs) {
          confirmed = true;
          break;
        }
        if (Date.now() - lastSentAt >= resendMs) {
          send();
          lastSentAt = Date.now();
        }
      }
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
