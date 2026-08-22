import { installNativeWebRTC } from '/Users/danielraeder/Documents/Claude/gitpigeon.dev/GitPigeon/src/webrtc.js';
await installNativeWebRTC();
const { PeerPigeonNode } = await import('peerpigeon');

const [relayA, relayB, label] = process.argv.slice(2);
const sessionId = 'fedtest' + 'a'.repeat(25);
const mk = (relay, name) => {
  const node = new PeerPigeonNode({
    crypto: false, networkId: 'gitpigeon-fedtest-v1', sessionId,
    minPeers: 1, maxPeers: 5, tolerantPeers: 0, autoDiscover: true, autoConnect: true,
    ...(relay ? { automaticSignalingServer: false, signalingServer: relay, signalingServers: [relay] } : {}),
  });
  node.mesh.on('signaling:connected', ({ signalingServer }) => console.log(`${name} signaling: ${signalingServer}`));
  node.mesh.on('peer:discovered', (p) => console.log(`${name} discovered ${String(p).slice(0,12)}`));
  node.on('peerConnected', (p) => console.log(`${name} CONNECTED ${String(p).slice(0,12)}`));
  return node;
};
const a = mk(relayA, 'A');
const b = mk(relayB, 'B');
await Promise.all([a.start(), b.start()]);
console.log(`--- ${label} --- waiting 40s ---`);
await new Promise((r) => setTimeout(r, 40000));
console.log(`RESULT ${label}: A peers=${a.getConnectedPeers().length} global=${a.getGlobalPeers().length} | B peers=${b.getConnectedPeers().length} global=${b.getGlobalPeers().length}`);
await a.destroy(); await b.destroy();
process.exit(0);
