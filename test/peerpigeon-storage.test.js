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

function wait(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test('restarted publisher reconciles a newer PeerPigeon record before updating it', async (t) => {
  const bus = new GossipBus();
  const shared = {
    sessionId: 'gitpigeon-index-v1:restart-test',
    syncSecret: 'a-restart-secret-that-is-long-enough-for-the-test',
  };
  const browser = new PeerPigeonStorage({
    ...shared,
    userId: 'browser-index-peer',
    gossip: bus.peer('browser'),
  });
  await browser.init();
  const key = 'gitpigeon/index/v1/restart-test/directory';
  for (let revision = 1; revision <= 4; revision += 1) {
    await browser.put('public', key, { watcherCount: 0, revision });
  }
  browser.subscribeKey('public', key);

  const restarted = new PeerPigeonStorage({
    ...shared,
    userId: 'native-index-peer',
    gossip: bus.peer('native'),
  });
  await restarted.init();
  restarted.subscribeKey('public', key);
  t.after(async () => {
    await restarted.close();
    await browser.close();
  });

  await restarted.put('public', key, { watcherCount: 1, revision: 1 });
  await wait();
  assert.equal((await browser.get('public', key))?.value.watcherCount, 0);

  const reconciled = await restarted.retrieve('public', key, { timeoutMs: 1_000 });
  assert.equal(reconciled?.value.revision, 4);
  await restarted.put('public', key, { watcherCount: 1, revision: 5 });
  await wait();

  const live = await browser.get('public', key);
  assert.equal(live?.value.watcherCount, 1);
  assert.equal(live?.value.revision, 5);
});
