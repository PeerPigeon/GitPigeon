import assert from 'node:assert/strict';
import test from 'node:test';
import { PeerPigeonStorage } from 'peerpigeon';

class GossipBus {
  constructor() {
    this.peers = new Set();
  }
  peer(id) {
    const peer = new FakeGossip(this, id);
    this.peers.add(peer);
    return peer;
  }
}

class FakeGossip {
  constructor(bus, id) {
    this.bus = bus;
    this.id = id;
    this.listeners = new Set();
  }
  on(event, callback) {
    if (event === 'messageReceived') this.listeners.add(callback);
  }
  off(event, callback) {
    if (event === 'messageReceived') this.listeners.delete(callback);
  }
  broadcast(data) {
    for (const peer of this.bus.peers) {
      if (peer === this) continue;
      for (const callback of peer.listeners) {
        queueMicrotask(() => callback({
          message: { data },
          local: false,
          fromPeer: this.id,
        }));
      }
    }
    return `${this.id}-${Date.now()}`;
  }
}

test('pinned PeerPigeon storage encrypts and retrieves an immutable record', async (t) => {
  const bus = new GossipBus();
  const shared = {
    sessionId: 'gitpigeon-v1:storage-test',
    syncSecret: 'a-shared-secret-that-is-long-enough-for-the-test',
  };
  const source = new PeerPigeonStorage({
    ...shared,
    userId: 'device-source',
    gossip: bus.peer('source'),
  });
  const target = new PeerPigeonStorage({
    ...shared,
    userId: 'device-target',
    gossip: bus.peer('target'),
  });
  await source.init();
  await target.init();
  t.after(async () => {
    await source.close();
    await target.close();
  });

  await source.put('frozen', 'gitpigeon/v1/storage-test/chunk/abc', {
    encoding: 'base64',
    data: 'cGlnZW9u',
  });
  const retrieved = await target.retrieve(
    'frozen',
    'gitpigeon/v1/storage-test/chunk/abc',
    { timeoutMs: 1_000 },
  );

  assert.deepEqual(retrieved?.value, { encoding: 'base64', data: 'cGlnZW9u' });
});

