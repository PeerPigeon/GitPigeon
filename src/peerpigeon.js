import { NETWORK_ID, storagePrefix } from './constants.js';
import { installNativeWebRTC } from './webrtc.js';

export async function connectPeerPigeon(config, logger = {}) {
  await installNativeWebRTC();
  let PeerPigeonNode;
  try {
    ({ PeerPigeonNode } = await import('peerpigeon'));
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
  let lastRecoveryAt = Date.now();
  const recover = (reason) => {
    if (node.getConnectedPeers().length > 0 || Date.now() - lastRecoveryAt < 20_000) return;
    lastRecoveryAt = Date.now();
    logger.debug?.(`[${roomLabel}] recovery: ${node.getDiscoveredPeers().length} discovered, ${node.getActiveSignalingPeers().length} active on relay`);
    node.recoverAfterInactivity(reason);
  };
  node.on('error', (error) => {
    logger.error?.(error);
    recover('GitPigeon native repository connection error');
  });
  node.on('peerConnected', (peerId) => logger.debug?.(`[${roomLabel}] peer connected: ${peerId}`));
  node.on('peerDisconnected', (peerId) => logger.debug?.(`[${roomLabel}] peer disconnected: ${peerId}`));
  try {
    await node.start();
  } catch (error) {
    try { await node.destroy(); } catch { /* preserve the startup error */ }
    throw error;
  }
  if (!node.storage) {
    await node.destroy();
    throw new Error('PeerPigeon storage did not initialize');
  }
  const recoveryTimer = setInterval(() => {
    recover('GitPigeon native repository peer retry');
  }, 1_000);
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
      clearInterval(recoveryTimer);
      await node.destroy();
    },
  };
}
