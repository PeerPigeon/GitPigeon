import assert from 'node:assert/strict';
import test from 'node:test';
import { installNativeWebRTC } from '../src/webrtc.js';

test('installs a browser-compatible WebRTC runtime for native PeerPigeon', async () => {
  await installNativeWebRTC();
  assert.equal(typeof globalThis.RTCPeerConnection, 'function');
  assert.equal(typeof globalThis.RTCSessionDescription, 'function');
  assert.equal(typeof globalThis.RTCIceCandidate, 'function');
  assert.equal(typeof globalThis.WebSocket, 'function');

  const connection = new globalThis.RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 4 });
  assert.equal(connection.connectionState, 'new');
  await connection.close();
});
