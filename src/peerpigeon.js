import { repositoryCrypto } from './channel.js';
import { NETWORK_ID, repositoryRoomTopology, storagePrefix } from './constants.js';
import { machineIndexRoot } from './machine-index.js';
import { installNativeStorage } from './native-storage.js';
import { installNativeWebRTC } from './webrtc.js';

async function startPeerPigeonNode(node, label) {
  // PeerPigeon owns its bounded startup and recovery. Do not stack a second
  // GitPigeon timer on top of its connection state machine.
  await node.start();
}

export async function connectPeerPigeon(config, logger = {}, { stateRoot = machineIndexRoot() } = {}) {
  await installNativeWebRTC();
  // PeerPigeon Storage persists itself once Node has the `indexedDB` global it
  // already looks for. Without this the watcher restarts every record at
  // version 1 and browsers reject its writes as stale.
  await installNativeStorage(stateRoot);
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
    // PeerPigeon room crypto replaces the three hand-rolled AES-256-GCM
    // framings GitPigeon used to carry over an intentionally unencrypted node.
    crypto: repositoryCrypto(config.repositoryId, config.secret),
    networkId: NETWORK_ID,
    sessionId: config.repositoryId,
    // Keep small repository rooms fully meshed. A minimum of one makes every
    // browser stop dialing as soon as it reaches this watcher, producing a
    // star in which browsers cannot see one another.
    ...repositoryRoomTopology(),
    tolerantPeers: 0,
    autoDiscover: true,
    autoConnect: true,
    storage: {
      userId: config.deviceId,
      sessionId: `${NETWORK_ID}:${config.repositoryId}`,
      syncSecret: config.secret,
      // The database is this device's local replica. Two clones of the same
      // repository can live on one machine, so the name is scoped by device as
      // well; a shared name would let them overwrite each other's records now
      // that native storage is durable rather than per-instance memory.
      dbName: `gitpigeon-${config.repositoryId}-${config.deviceId}`,
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
  node.on('error', (error) => {
    if (/^Negotiation stalled\b/.test(String(error?.message ?? error ?? ''))) {
      logger.debug?.(error?.message ?? error);
      return;
    }
    logger.error?.(error);
  });
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
