import {
  DEVICE_GRANT_PROTOCOL,
  openDeviceGrant,
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
