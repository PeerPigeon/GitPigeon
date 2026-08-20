import { NETWORK_ID, storagePrefix } from './constants.js';
import { productionSignalingServers } from './relay-policy.js';
import { installNativeWebRTC } from './webrtc.js';

const PEERPIGEON_START_TIMEOUT_MS = 15_000;

async function startPeerPigeonNode(node, label) {
  let timer;
  try {
    await Promise.race([
      node.start(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} did not finish PeerPigeon startup within ${PEERPIGEON_START_TIMEOUT_MS / 1_000} seconds`));
        }, PEERPIGEON_START_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connectPeerPigeon(config, logger = {}) {
  await installNativeWebRTC();
  let PeerPigeonNode;
  let defaultSignalingServers;
  try {
    ({ PeerPigeonNode, DEFAULT_SIGNALING_SERVERS: defaultSignalingServers } = await import('peerpigeon'));
  } catch (error) {
    throw new Error(`PeerPigeon is not installed. Run your package manager install first. (${error.message})`);
  }
  if (typeof PeerPigeonNode !== 'function') {
    throw new Error('The pinned PeerPigeon build does not export PeerPigeonNode');
  }

  const prefix = `${storagePrefix(config.repositoryId)}/`;
  const options = {
    crypto: false,
    networkId: NETWORK_ID,
    sessionId: config.repositoryId,
    minPeers: 1,
    maxPeers: 4,
    tolerantPeers: 1,
    autoDiscover: true,
    autoConnect: true,
    signalingServers: productionSignalingServers(defaultSignalingServers),
    storage: {
      userId: config.deviceId,
      sessionId: `${NETWORK_ID}:${config.repositoryId}`,
      syncSecret: config.secret,
      dbName: `gitpigeon-${config.repositoryId}`,
      syncFilter: (_space, key) => String(key).startsWith(prefix),
    },
  };
  // Leave signaling unset by default so PeerPigeon independently selects a
  // nearby relay and FreeRTC federates peers sharing this Network + Room.
  if (config.signalingServer) options.signalingServer = config.signalingServer;
  const node = new PeerPigeonNode(options);
  const roomLabel = `repository ${config.repositoryId.slice(0, 10)}`;
  node.mesh.on('identity:ready', ({ clientId } = {}) => {
    logger.debug?.(`[${roomLabel}] identity ready as ${String(clientId ?? 'unknown').slice(0, 12)}`);
  });
  node.mesh.on('signaling:connected', ({ clientId, signalingServer } = {}) => {
    logger.debug?.(`[${roomLabel}] signaling connected through ${signalingServer ?? 'a federated relay'} as ${String(clientId ?? 'unknown').slice(0, 12)}`);
  });
  node.mesh.on('signaling:disconnected', () => logger.debug?.(`[${roomLabel}] signaling disconnected`));
  node.mesh.on('signaling:log', ({ message } = {}) => logger.debug?.(`[${roomLabel}] ${message}`));
  node.mesh.on('peer:discovered', (peerId) => logger.debug?.(`[${roomLabel}] discovered ${String(peerId).slice(0, 12)}`));
  // PeerPigeon and FreeRTC own signaling recovery, federation, and redial.
  // Calling recoverAfterInactivity from GitPigeon while a negotiation is in
  // progress tears down the healthy transport and creates a reconnect loop.
  node.on('error', (error) => logger.error?.(error));
  node.on('peerConnected', (peerId) => logger.debug?.(`[${roomLabel}] peer connected: ${peerId}`));
  node.on('peerDisconnected', (peerId) => logger.debug?.(`[${roomLabel}] peer disconnected: ${peerId}`));
  try {
    await startPeerPigeonNode(node, roomLabel);
  } catch (error) {
    try { await node.destroy(); } catch { /* preserve the startup error */ }
    throw error;
  }
  if (!node.storage) {
    await node.destroy();
    throw new Error('PeerPigeon storage did not initialize');
  }
  return {
    node,
    storage: node.storage,
    async waitForPeer({ timeoutMs = 0 } = {}) {
      if (node.getConnectedPeers().length > 0) return node.getConnectedPeers()[0];
      return await new Promise((resolve, reject) => {
        let timer = null;
        const connected = (peerId) => {
          if (timer) clearTimeout(timer);
          node.off('peerConnected', connected);
          resolve(peerId);
        };
        node.on('peerConnected', connected);
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            node.off('peerConnected', connected);
            reject(new Error('No GitPigeon repository peer connected before the timeout'));
          }, timeoutMs);
        }
      });
    },
    async close() {
      await node.destroy();
    },
  };
}
