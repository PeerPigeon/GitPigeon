import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chunkKey, presenceKey } from '../src/constants.js';
import { RepositorySynchronizer } from '../src/protocol.js';
import { WorkspaceFiles } from '../src/workspace.js';
import { createRepository } from './helpers.js';

class FakeNetwork {
  constructor() {
    this.records = new Map();
    this.stores = new Set();
    this.puts = [];
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
    this.network.puts.push({ id: this.id, space, key });
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
  const cachedChunks = await readdir(path.join(source.gitDir, 'gitpigeon', 'chunks'));
  for (const chunk of cachedChunks) {
    const cached = await readFile(path.join(source.gitDir, 'gitpigeon', 'chunks', chunk));
    assert.equal(cached.includes(Buffer.from('TOKEN=one')), false);
    assert.equal(cached.subarray(0, 6).toString('ascii'), 'GPCH1\0');
  }
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

test('restart re-seeds cached chunks before publishing a fresh presence lease', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-presence-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createRepository(path.join(root, 'source'), 'presence ordering');
  const network = new FakeNetwork();
  const config = {
    version: 1,
    repositoryId: '0123456789abc123',
    secret: 'abcdefghijklmnopqrstuvwxyz_1234567890-ABCDE',
    deviceId: 'device-presence-a',
    createdAt: new Date().toISOString(),
  };
  const initial = new RepositorySynchronizer({
    repository: source,
    storage: network.store('initial'),
    config,
    presenceHeartbeatMs: 0,
  });
  await initial.start();
  const head = (await initial.status()).heads[config.deviceId];
  const manifest = JSON.parse(await readFile(path.join(source.gitDir, 'gitpigeon', 'manifests', `${head.snapshotId}.json`), 'utf8'));
  await initial.stop();

  network.puts = [];
  const restartedStorage = network.store('restarted');
  const restarted = new RepositorySynchronizer({
    repository: source,
    storage: restartedStorage,
    config,
    presenceHeartbeatMs: 0,
  });
  await restarted.start({ publish: false });

  const presence = presenceKey(config.repositoryId, config.deviceId);
  const presenceIndex = network.puts.findIndex((event) => event.id === 'restarted' && event.key === presence);
  assert.notEqual(presenceIndex, -1);
  for (const descriptor of manifest.chunks) {
    const key = chunkKey(config.repositoryId, descriptor.sha256);
    const chunkIndex = network.puts.findIndex((event) => event.id === 'restarted' && event.key === key);
    assert.notEqual(chunkIndex, -1);
    assert.ok(chunkIndex < presenceIndex, `${descriptor.sha256.slice(0, 10)} was seeded after presence`);
    assert.ok(await restartedStorage.get('frozen', key));
  }
  const lease = await restartedStorage.get('public', presence);
  assert.equal(lease?.value.snapshotId, head.snapshotId);
  await restarted.stop();
});

test('syncs private workspace files independently of Git and preserves concurrent edits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-private-files-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createRepository(path.join(root, 'source'));
  const target = await createRepository(path.join(root, 'target'));
  await writeFile(path.join(source.root, '.env'), 'TOKEN=one\n');
  await new WorkspaceFiles(source).track(['.env']);

  const network = new FakeNetwork();
  const common = {
    version: 1,
    repositoryId: 'fedcba9876543210',
    secret: 'abcdefghijklmnopqrstuvwxyz_1234567890-ABCDE',
    createdAt: new Date().toISOString(),
  };
  const a = new RepositorySynchronizer({
    repository: source,
    storage: network.store('private-a'),
    config: { ...common, deviceId: 'device-private-a' },
  });
  const b = new RepositorySynchronizer({
    repository: target,
    storage: network.store('private-b'),
    config: { ...common, deviceId: 'device-private-b' },
  });
  await a.start();
  await b.start({ publish: false });
  await b.refresh();

  assert.equal(await readFile(path.join(target.root, '.env'), 'utf8'), 'TOKEN=one\n');
  assert.deepEqual(await new WorkspaceFiles(target).list(), ['.env']);
  assert.equal((await target.git(['check-ignore', '.env'])).stdout.trim(), '.env');

  const refsBefore = await source.refsDigest();
  await writeFile(path.join(source.root, '.env'), 'TOKEN=two\n');
  await a.publishLocal();
  await b.refresh();
  assert.equal(await source.refsDigest(), refsBefore);
  assert.equal(await readFile(path.join(target.root, '.env'), 'utf8'), 'TOKEN=two\n');

  await writeFile(path.join(target.root, '.env'), 'TOKEN=local-target\n');
  await writeFile(path.join(source.root, '.env'), 'TOKEN=three\n');
  await a.publishLocal();
  const conflictResult = await b.refresh();
  assert.equal(await readFile(path.join(target.root, '.env'), 'utf8'), 'TOKEN=local-target\n');
  assert.deepEqual(conflictResult.fileConflicts.map(({ path: file }) => file), ['.env']);
  assert.equal(
    await readFile(path.join(target.gitDir, 'gitpigeon', 'conflicts', 'device-private-a', '.env'), 'utf8'),
    'TOKEN=three\n',
  );

  await writeFile(path.join(target.root, '.env'), 'TOKEN=three\n');
  await b.publishLocal();
  await a.refresh();
  await rm(path.join(source.root, '.env'));
  await a.publishLocal();
  await b.refresh();
  await assert.rejects(access(path.join(target.root, '.env')), { code: 'ENOENT' });

  await b.stop();
  await a.stop();
});

test('syncs live working-tree CRUD before commit and preserves concurrent code edits', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-live-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createRepository(path.join(root, 'source'), 'base\n');
  const target = await createRepository(path.join(root, 'target'));
  const network = new FakeNetwork();
  const common = {
    version: 1,
    repositoryId: '0123456789abcdee',
    secret: 'abcdefghijklmnopqrstuvwxyz_1234567890-ABCDE',
    createdAt: new Date().toISOString(),
  };
  const a = new RepositorySynchronizer({
    repository: source,
    storage: network.store('live-a'),
    config: { ...common, deviceId: 'device-live-aaaa' },
  });
  const b = new RepositorySynchronizer({
    repository: target,
    storage: network.store('live-b'),
    config: { ...common, deviceId: 'device-live-bbbb' },
  });
  await a.start();
  await b.start({ publish: false });
  await b.refresh();

  // Update and create propagate immediately without moving a Git ref.
  const refsBefore = await source.refsDigest();
  await writeFile(path.join(source.root, 'file.txt'), 'live update\n');
  await writeFile(path.join(source.root, 'new.js'), 'export const live = true;\n');
  await a.publishLocal();
  await b.refresh();
  assert.equal(await source.refsDigest(), refsBefore);
  assert.equal(await readFile(path.join(target.root, 'file.txt'), 'utf8'), 'live update\n');
  assert.equal(await readFile(path.join(target.root, 'new.js'), 'utf8'), 'export const live = true;\n');

  // A rename is a live delete plus create, and deleting both tracked and
  // untracked files is reflected on the other device.
  await rename(path.join(source.root, 'new.js'), path.join(source.root, 'moved.js'));
  await a.publishLocal();
  await b.refresh();
  await assert.rejects(access(path.join(target.root, 'new.js')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(target.root, 'moved.js'), 'utf8'), 'export const live = true;\n');
  await rm(path.join(source.root, 'moved.js'));
  await rm(path.join(source.root, 'file.txt'));
  await a.publishLocal();
  await b.refresh();
  await assert.rejects(access(path.join(target.root, 'moved.js')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(target.root, 'file.txt')), { code: 'ENOENT' });

  // Turning the live overlay into a commit first removes the received overlay,
  // allowing the normal Git fast-forward to proceed with a clean worktree.
  await writeFile(path.join(source.root, 'file.txt'), 'now committed\n');
  await source.git(['add', '-A']);
  await source.git(['commit', '-m', 'commit live changes']);
  await a.publishLocal();
  await b.refresh();
  assert.equal(await readFile(path.join(target.root, 'file.txt'), 'utf8'), 'now committed\n');
  assert.equal((await target.git(['status', '--porcelain=v1'])).stdout, '');
  assert.equal(
    (await target.git(['rev-parse', 'HEAD'])).stdout.trim(),
    (await source.git(['rev-parse', 'HEAD'])).stdout.trim(),
  );

  // Concurrent local code is never overwritten; the peer's version is saved
  // beside GitPigeon's metadata for an explicit resolution.
  await writeFile(path.join(target.root, 'file.txt'), 'local target edit\n');
  await writeFile(path.join(source.root, 'file.txt'), 'incoming peer edit\n');
  await a.publishLocal();
  const conflictResult = await b.refresh();
  assert.equal(await readFile(path.join(target.root, 'file.txt'), 'utf8'), 'local target edit\n');
  assert.deepEqual(conflictResult.liveConflicts.map(({ path: file }) => file), ['file.txt']);
  assert.equal(
    await readFile(path.join(target.gitDir, 'gitpigeon', 'live-conflicts', 'device-live-aaaa', 'file.txt'), 'utf8'),
    'incoming peer edit\n',
  );

  await b.stop();
  await a.stop();
});

test('publishes deletion of the final live file before the first commit', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-unborn-live-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createRepository(path.join(root, 'source'));
  const target = await createRepository(path.join(root, 'target'));
  const network = new FakeNetwork();
  const common = {
    version: 1,
    repositoryId: '0123456789abcddd',
    secret: 'abcdefghijklmnopqrstuvwxyz_1234567890-ABCDE',
    createdAt: new Date().toISOString(),
  };
  const a = new RepositorySynchronizer({
    repository: source,
    storage: network.store('unborn-a'),
    config: { ...common, deviceId: 'device-unborn-a' },
  });
  const b = new RepositorySynchronizer({
    repository: target,
    storage: network.store('unborn-b'),
    config: { ...common, deviceId: 'device-unborn-b' },
  });
  await writeFile(path.join(source.root, 'first.js'), 'console.log("live");\n');
  await a.start();
  await b.start({ publish: false });
  await b.refresh();
  assert.equal(await readFile(path.join(target.root, 'first.js'), 'utf8'), 'console.log("live");\n');

  await rm(path.join(source.root, 'first.js'));
  await a.publishLocal();
  await b.refresh();
  await assert.rejects(access(path.join(target.root, 'first.js')), { code: 'ENOENT' });

  await b.stop();
  await a.stop();
});
