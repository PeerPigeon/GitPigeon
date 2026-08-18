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
    networkId: NETWORK_ID,
    sessionId: config.repositoryId,
    minPeers: 1,
    maxPeers: 8,
    tolerantPeers: 2,
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
  if (config.signalingServer) options.signalingServer = config.signalingServer;

  const node = new PeerPigeonNode(options);
  node.on('error', (error) => logger.error?.(error));
  node.on('peerConnected', (peerId) => logger.debug?.(`Peer connected: ${peerId}`));
  node.on('peerDisconnected', (peerId) => logger.debug?.(`Peer disconnected: ${peerId}`));
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
  return {
    node,
    storage: node.storage,
    async close() {
      await node.destroy();
    },
  };
}
