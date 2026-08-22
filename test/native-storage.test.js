import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withFreshStorageModule(root) {
  // Each case needs its own module instance because the shim installs one
  // process-wide `indexedDB`, exactly like the browser global it replaces.
  const module = await import(`../src/native-storage.js?case=${encodeURIComponent(root)}`);
  await module.installNativeStorage(root);
  return module;
}

test('native PeerPigeon storage keeps record versions across a watcher restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-native-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => { delete globalThis.indexedDB; });

  const { PeerPigeonStorage } = await import('peerpigeon');
  const module = await withFreshStorageModule(root);

  const first = new PeerPigeonStorage({ userId: 'device-aaaaaaaa', dbName: 'gitpigeon-test' });
  await first.init();
  await first.put('public', 'gitpigeon/v1/head', { snapshotId: 'one' });
  const original = await first.get('public', 'gitpigeon/v1/head');
  await module.flushNativeStorage();
  await first.close();

  const second = new PeerPigeonStorage({ userId: 'device-aaaaaaaa', dbName: 'gitpigeon-test' });
  await second.init();
  const restored = await second.get('public', 'gitpigeon/v1/head');
  assert.deepEqual(restored?.value, { snapshotId: 'one' });
  assert.equal(restored?.version, original?.version);

  const advanced = await second.put('public', 'gitpigeon/v1/head', { snapshotId: 'two' });
  assert.notEqual(advanced.version, original.version);
  await second.close();
});

test('immutable frozen chunks stay out of the durable native database', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-native-storage-frozen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => { delete globalThis.indexedDB; });

  const { PeerPigeonStorage } = await import('peerpigeon');
  const module = await withFreshStorageModule(root);

  const storage = new PeerPigeonStorage({ userId: 'device-aaaaaaaa', dbName: 'gitpigeon-frozen' });
  await storage.init();
  await storage.put('frozen', 'gitpigeon/v1/chunk/abc', { data: 'x'.repeat(1024) });
  await storage.put('public', 'gitpigeon/v1/registry', { devices: ['device-aaaaaaaa'] });
  await module.flushNativeStorage();
  await storage.close();

  const { readFile } = await import('node:fs/promises');
  const persisted = JSON.parse(await readFile(path.join(root, 'storage', 'gitpigeon-frozen.json'), 'utf8'));
  const spaces = persisted.records.map((record) => record.space);
  assert.ok(spaces.includes('public'));
  assert.ok(!spaces.includes('frozen'));
});

test('two devices sharing a repository keep separate durable databases', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-native-storage-devices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => { delete globalThis.indexedDB; });

  const { PeerPigeonStorage } = await import('peerpigeon');
  const module = await withFreshStorageModule(root);

  // Two clones of one repository can run on the same machine. Before the
  // database name was scoped by device they shared one record map, and each
  // clone saw the other's local writes instead of its own.
  const repositoryId = 'a'.repeat(32);
  const first = new PeerPigeonStorage({ userId: 'device-aaaaaaaa', dbName: `gitpigeon-${repositoryId}-device-aaaaaaaa` });
  const second = new PeerPigeonStorage({ userId: 'device-bbbbbbbb', dbName: `gitpigeon-${repositoryId}-device-bbbbbbbb` });
  await first.init();
  await second.init();

  await first.put('public', `gitpigeon/v1/${repositoryId}/head`, { deviceId: 'device-aaaaaaaa' });
  await second.put('public', `gitpigeon/v1/${repositoryId}/head`, { deviceId: 'device-bbbbbbbb' });

  assert.deepEqual((await first.get('public', `gitpigeon/v1/${repositoryId}/head`))?.value, { deviceId: 'device-aaaaaaaa' });
  assert.deepEqual((await second.get('public', `gitpigeon/v1/${repositoryId}/head`))?.value, { deviceId: 'device-bbbbbbbb' });

  await module.flushNativeStorage();
  await first.close();
  await second.close();
});
