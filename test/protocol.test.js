import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RepositorySynchronizer } from '../src/protocol.js';
import { createRepository } from './helpers.js';

class FakeNetwork {
  constructor() {
    this.records = new Map();
    this.stores = new Set();
  }
  store(id) {
    const store = new FakeStorage(this, id);
    this.stores.add(store);
    return store;
  }
}

class FakeStorage {
  constructor(network, id) {
    this.network = network;
    this.id = id;
    this.local = new Map();
    this.subscriptions = new Set();
    this.listeners = new Set();
  }
  pk(space, key) { return `${space}:${key}`; }
  subscribeKey(space, key) {
    const pk = this.pk(space, key);
    this.subscriptions.add(pk);
    return () => this.subscriptions.delete(pk);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async get(space, key) { return this.local.get(this.pk(space, key)) ?? null; }
  async retrieve(space, key) {
    this.subscribeKey(space, key);
    const record = this.network.records.get(this.pk(space, key)) ?? null;
    if (record) this.local.set(this.pk(space, key), record);
    return record;
  }
  async put(space, key, value) {
    const pk = this.pk(space, key);
    if (space === 'frozen' && this.network.records.has(pk)) {
      const existing = this.network.records.get(pk);
      this.local.set(pk, existing);
      return existing;
    }
    const record = { space, key, value, ownerId: null, version: Date.now() };
    this.local.set(pk, record);
    this.network.records.set(pk, record);
    for (const store of this.network.stores) {
      if (store === this || !store.subscriptions.has(pk)) continue;
      store.local.set(pk, record);
      for (const listener of store.listeners) {
        listener({ origin: 'remote', op: 'upsert', record, space, key, actorId: this.id });
      }
    }
    return record;
  }
}

test('publishes and retrieves a repository through PeerPigeon storage semantics', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-protocol-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createRepository(path.join(root, 'source'), 'peer-to-peer');
  const target = await createRepository(path.join(root, 'target'));
  const network = new FakeNetwork();
  const common = {
    version: 1,
    repositoryId: '0123456789abcdef',
    secret: 'abcdefghijklmnopqrstuvwxyz_1234567890-ABCDE',
    createdAt: new Date().toISOString(),
  };
  const a = new RepositorySynchronizer({
    repository: source,
    storage: network.store('a'),
    config: { ...common, deviceId: 'device-aaaaaaaa' },
  });
  const b = new RepositorySynchronizer({
    repository: target,
    storage: network.store('b'),
    config: { ...common, deviceId: 'device-bbbbbbbb' },
  });
  await a.start();
  await b.start({ publish: false });
  await b.refresh();

  assert.equal(await readFile(path.join(target.root, 'file.txt'), 'utf8'), 'peer-to-peer');
  assert.equal(
    (await target.git(['rev-parse', 'main'])).stdout.trim(),
    (await source.git(['rev-parse', 'main'])).stdout.trim(),
  );
  await b.stop();
  await a.stop();
});

