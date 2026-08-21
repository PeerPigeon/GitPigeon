import {
  DEVICE_GRANT_PROTOCOL,
  openDeviceGrant,
  validateDeviceEnrollmentRequest,
} from './device-grants.js';
import { productionSignalingServers } from './relay-policy.js';
import { installNativeWebRTC } from './webrtc.js';

export const DEVICE_APPROVAL_NETWORK_ID = 'gitpigeon-device-approval-v1';
export const DEVICE_APPROVAL_SESSION_ID = 'approved-browser-discovery-v1';

function decode(value) {
  if (typeof value !== 'string' || value.length > 60_000) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function validApprovalEnvelope(value, request) {
  return value?.protocol === DEVICE_GRANT_PROTOCOL
    && value.purpose === 'enrollment'
    && value.requestId === request.requestId
    && value.recipientPublicKey === request.publicKey;
}

export async function startDeviceApprovalRequester(identity, requestValue, {
  logger = {},
  onGrant = () => {},
  nodeFactory,
  signalingServers,
} = {}) {
  const request = validateDeviceEnrollmentRequest(requestValue);
  if (!request) throw new Error('Invalid GitPigeon device approval request');

  let PartialMesh;
  if (!nodeFactory) {
    await installNativeWebRTC();
    const peerpigeon = await import('peerpigeon');
    PartialMesh = peerpigeon.PartialMesh;
    signalingServers = signalingServers
      ?? productionSignalingServers(peerpigeon.DEFAULT_SIGNALING_SERVERS);
  }
  let closed = false;
  const announcing = new Set();
  const receive = ({ data } = {}) => {
    if (closed) return;
    const envelope = decode(data);
    if (!validApprovalEnvelope(envelope, request)) return;
    try {
      const grant = openDeviceGrant(identity, envelope, { purpose: 'enrollment' });
      Promise.resolve(onGrant(envelope, grant)).catch((error) => logger.debug?.(`Device approval mesh grant: ${error.message}`));
    } catch (error) {
      logger.debug?.(`Ignored invalid PeerPigeon device approval: ${error.message}`);
    }
  };
  const announce = (mesh) => {
    if (closed || announcing.has(mesh)) return;
    announcing.add(mesh);
    try {
      mesh.broadcast(JSON.stringify(request));
    } catch (error) {
      logger.debug?.(`Device approval mesh announcement: ${error.message}`);
    } finally {
      announcing.delete(mesh);
    }
  };
  const relays = [...new Set((signalingServers ?? []).map(String).filter(Boolean))];
  const candidates = relays.length ? relays : [null];
  const records = candidates.map((signalingServer) => {
    const options = {
      networkId: DEVICE_APPROVAL_NETWORK_ID,
      sessionId: DEVICE_APPROVAL_SESSION_ID,
      minPeers: 1,
      maxPeers: 5,
      tolerantPeers: 0,
      autoDiscover: true,
      autoConnect: true,
      ...(signalingServer ? {
        automaticSignalingServer: false,
        signalingServer,
        signalingServers: [signalingServer],
      } : {}),
    };
    const mesh = nodeFactory ? nodeFactory(options) : new PartialMesh(options);
    const peerConnected = () => announce(mesh);
    mesh.on('identity:ready', ({ clientId } = {}) => {
      logger.debug?.(`[device approval] identity ready as ${String(clientId ?? 'unknown').slice(0, 12)}`);
    });
    mesh.on('signaling:connected', ({ signalingServer: connectedRelay } = {}) => {
      logger.debug?.(`[device approval] signaling connected through ${connectedRelay ?? signalingServer ?? 'a federated relay'}`);
    });
    mesh.on('peer:discovered', (peerId) => {
      logger.debug?.(`[device approval] discovered ${String(peerId ?? 'unknown').slice(0, 12)}`);
    });
    mesh.on('peer:data', receive);
    mesh.on('peer:connected', peerConnected);
    mesh.on('peer:error', ({ error } = {}) => logger.debug?.(`Device approval mesh: ${error?.message ?? error}`));
    return { mesh, peerConnected };
  });
  const starts = await Promise.allSettled(records.map(async (record) => {
    await record.mesh.init();
    announce(record.mesh);
    return record;
  }));
  const active = starts.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index].status === 'rejected') records[index].mesh.destroy();
  }
  if (!active.length) throw starts[0]?.reason ?? new Error('No PeerPigeon approval relay is available');
  const timer = setInterval(() => {
    for (const { mesh } of active) announce(mesh);
  }, 1_000);
  return {
    node: active[0].mesh,
    nodes: active.map(({ mesh }) => mesh),
    request,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const { mesh, peerConnected } of active) {
        mesh.off?.('peer:data', receive);
        mesh.off?.('peer:connected', peerConnected);
        mesh.destroy();
      }
    },
  };
}
