import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIdentity } from '../src/config.js';
import {
  adoptMachineIndexCapability,
  claimDashboardPairing,
  completeDashboardPairing,
  directoryValue,
  indexPublishersKey,
  liveDirectoryKey,
  listMachinePigeons,
  loadMachineIndex,
  markMachinePigeonStopped,
  markShareEnded,
  openDashboard,
  publisherDirectoryKey,
  publisherDirectoryValue,
  publisherRosterValue,
  registerMachinePigeon,
  unregisterMachinePigeon,
} from '../src/machine-index.js';
import { createRepository } from './helpers.js';

test('machine index securely groups active repositories for PeerPigeon publication', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-machine-index-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstRepository = await createRepository(path.join(root, 'alpha'));
  const secondRepository = await createRepository(path.join(root, 'beta'));
  const stateRoot = path.join(root, 'state');
  const firstConfig = createIdentity({
    repositoryId: 'alpha-pigeon',
    secret: 'a'.repeat(64),
    deviceId: 'alpha-device',
  });
  const secondConfig = createIdentity({
    repositoryId: 'beta-pigeon',
    secret: 'b'.repeat(64),
    deviceId: 'beta-device',
  });

  await registerMachinePigeon(firstRepository, firstConfig, { root: stateRoot });
  await registerMachinePigeon(secondRepository, secondConfig, { root: stateRoot });
  const active = await listMachinePigeons({ root: stateRoot });
  assert.deepEqual(active.map(({ name, repositoryId }) => ({ name, repositoryId })), [
    { name: 'alpha', repositoryId: 'alpha-pigeon' },
    { name: 'beta', repositoryId: 'beta-pigeon' },
  ]);

  const state = await loadMachineIndex({ root: stateRoot });
  const watcherServiceId = 'f'.repeat(32);
  const published = directoryValue(state, active, 1_700_000_000_000, watcherServiceId);
  assert.equal(published.protocol, 'gitpigeon-index/1');
  assert.equal(published.updatedAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(published.pigeons.map(({ registeredAt, ...rest }) => {
    // Every pigeon states when it was registered, so tombstones and
    // re-registrations can be ordered; the exact instant is not the point.
    assert.ok(Number.isFinite(Date.parse(registeredAt)));
    return rest;
  }), [
    { repositoryId: 'alpha-pigeon', secret: 'a'.repeat(64), name: 'alpha', watcherCount: 1, watcherServiceId },
    { repositoryId: 'beta-pigeon', secret: 'b'.repeat(64), name: 'beta', watcherCount: 1, watcherServiceId },
  ]);
  assert.equal(liveDirectoryKey(state.indexId, 340_000_000), `gitpigeon/index/v1/${state.indexId}/live/340000000`);
  assert.equal(indexPublishersKey(state.indexId), `gitpigeon/index/v1/${state.indexId}/publishers`);
  assert.equal(
    publisherDirectoryKey(state.indexId, state.publisherId),
    `gitpigeon/index/v1/${state.indexId}/publisher/${state.publisherId}`,
  );
  const roster = publisherRosterValue(state, {
    protocol: 'gitpigeon-index/1',
    kind: 'publishers',
    indexId: state.indexId,
    publishers: ['1'.repeat(32)],
  }, [], 1_700_000_000_000);
  assert.deepEqual(roster.publishers, ['1'.repeat(32), state.publisherId].sort());

  // The roster is key discovery and must only ever grow by union. Rebuilding
  // it from one unreadable copy erased every other machine's membership: they
  // kept publishing, but nobody looked their keys up any more.
  const remembered = publisherRosterValue(state, null, ['2'.repeat(32)], 1_700_000_000_000);
  assert.deepEqual(remembered.publishers, ['2'.repeat(32), state.publisherId].sort());
  const both = publisherRosterValue(state, {
    protocol: 'gitpigeon-index/1',
    kind: 'publishers',
    indexId: state.indexId,
    publishers: ['1'.repeat(32)],
  }, ['2'.repeat(32)], 1_700_000_000_000);
  assert.deepEqual(both.publishers, ['1'.repeat(32), '2'.repeat(32), state.publisherId].sort());
  const publisherPeerId = 'peer-transport-id';
  const publisher = publisherDirectoryValue(
    state,
    active,
    1_700_000_000_000,
    watcherServiceId,
    publisherPeerId,
    'Daniels-Mini',
    'pairing-pub-key',
  );
  assert.equal(publisher.kind, 'publisher-directory');
  assert.equal(publisher.publisherId, state.publisherId);
  assert.equal(publisher.serviceInstanceId, watcherServiceId);
  assert.equal(publisher.peerId, publisherPeerId);
  assert.equal(publisher.deviceName, 'Daniels-Mini');
  // Browsers derive this machine's six-digit pairing code from this key, so
  // the Watchers panel can show the same digits the CLI prints.
  assert.equal(publisher.pairingPublicKey, 'pairing-pub-key');

  assert.equal((await unregisterMachinePigeon(firstRepository, { root: stateRoot })).removed, true);
  assert.deepEqual((await listMachinePigeons({ root: stateRoot })).map(({ repositoryId }) => repositoryId), ['beta-pigeon']);
});

test('machine index entries persist while their watcher process is stopped', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-persistent-index-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(path.join(root, 'repository'));
  const stateRoot = path.join(root, 'state');
  const config = createIdentity({
    repositoryId: 'persistent-pigeon',
    secret: 'p'.repeat(64),
    deviceId: 'persistent-device',
  });

  await registerMachinePigeon(repository, config, { root: stateRoot });
  assert.equal((await listMachinePigeons({ root: stateRoot })).length, 1);
  assert.equal((await markMachinePigeonStopped(repository, { root: stateRoot })).changed, true);
  assert.equal((await listMachinePigeons({ root: stateRoot })).length, 0);

  const persisted = await listMachinePigeons({ root: stateRoot, activeOnly: false });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].pid, null);
  const state = await loadMachineIndex({ root: stateRoot });
  assert.equal(directoryValue(state, persisted).pigeons[0].watcherCount, 0);

  await registerMachinePigeon(repository, config, { root: stateRoot });
  assert.equal((await listMachinePigeons({ root: stateRoot })).length, 1);
});

test('secure browser enrollment remains available until the browser acknowledges it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-pairing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pairing = await claimDashboardPairing({ root });
  assert.equal(pairing.index.pairingMode, 'secure');
  assert.equal(pairing.rotated, false);
  assert.equal(pairing.index.pairingComplete, false);
  const retry = await claimDashboardPairing({ root });
  assert.equal(retry.index.secret, pairing.index.secret);
  await completeDashboardPairing(retry.index, { root });
  assert.equal((await loadMachineIndex({ root })).pairingComplete, true);
  assert.equal(await claimDashboardPairing({ root }), null);

  let invocation;
  const child = { unref() {} };
  assert.equal(openDashboard('https://gitpigeon.dev/#enroll=temporary', {
    platform: 'darwin',
    environment: {},
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  }), true);
  assert.equal(invocation.command, 'open');
  assert.deepEqual(invocation.args, ['https://gitpigeon.dev/#enroll=temporary']);
  assert.equal(invocation.options.shell, false);
});

test('secure enrollment rotates a legacy URL-exposed machine secret', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-pairing-migration-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacySecret = 'legacy-secret-that-was-previously-in-the-url';
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.json'), `${JSON.stringify({
    version: 1,
    indexId: 'a'.repeat(32),
    secret: legacySecret,
    pairingLaunched: true,
    entries: [],
  })}\n`);

  const pairing = await claimDashboardPairing({ root });
  assert.equal(pairing.rotated, true);
  assert.notEqual(pairing.index.secret, legacySecret);
  assert.equal(pairing.index.pairingMode, 'secure');
  assert.equal(pairing.index.pairingComplete, false);
});

test('version-2 launched state retries enrollment because it did not prove acknowledgment', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-pairing-v2-migration-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = 'secure-secret-that-must-not-rotate-during-retry';
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.json'), `${JSON.stringify({
    version: 2,
    indexId: 'b'.repeat(32),
    secret,
    pairingLaunched: true,
    pairingMode: 'secure',
    entries: [],
  })}\n`);

  const pairing = await claimDashboardPairing({ root });
  assert.equal(pairing.rotated, false);
  assert.equal(pairing.index.secret, secret);
  assert.equal(pairing.index.pairingComplete, false);
});

test('an approved fresh device adopts the shared encrypted index without replacing registered repositories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-adopt-index-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adopted = await adoptMachineIndexCapability({
    indexId: 'c'.repeat(32),
    secret: 'approved-index-secret-that-is-long-enough',
  }, { root });
  assert.equal(adopted.indexId, 'c'.repeat(32));
  assert.equal(adopted.secret, 'approved-index-secret-that-is-long-enough');
  assert.equal(adopted.pairingComplete, false);

  const repository = await createRepository(path.join(root, 'repository'));
  await registerMachinePigeon(repository, createIdentity({
    repositoryId: 'adopted-pigeon',
    secret: 'd'.repeat(64),
    deviceId: 'adopted-device',
  }), { root });
  await assert.rejects(
    adoptMachineIndexCapability({ indexId: 'e'.repeat(32), secret: 'e'.repeat(43) }, { root }),
    /different GitPigeon index/,
  );
});

test('an unwatched repository is stated as removed, not just omitted', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { registerMachinePigeon, unregisterMachinePigeon, loadMachineIndex, directoryValue } =
    await import('../src/machine-index.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-tombstone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = { root: path.join(root, 'repo'), gitDir: path.join(root, 'repo/.git') };
  const config = {
    repositoryId: 'c'.repeat(32),
    secret: 'z'.repeat(43),
    deviceId: 'd'.repeat(32),
    name: 'test',
  };
  await registerMachinePigeon(repository, config, { root, pid: null });
  await unregisterMachinePigeon(repository, { root });

  // Browsers keep a cached directory copy so an offline machine does not
  // blank the dashboard — which means simple omission can never remove a
  // repository. Removal has to be said out loud, and survive restarts.
  const state = await loadMachineIndex({ root });
  assert.equal(state.entries.length, 0);
  assert.equal(state.removed.length, 1);
  assert.equal(state.removed[0].repositoryId, 'c'.repeat(32));

  const value = directoryValue(state, []);
  assert.equal(value.removed.length, 1);
  assert.equal(value.removed[0].repositoryId, 'c'.repeat(32));

  // The service re-registers entries to refresh PIDs on every start; that
  // must NOT resurrect a removed repository or clear its tombstone —
  // restarting the watcher used to undo every unwatch.
  await registerMachinePigeon(repository, config, { root, pid: null });
  const still = await loadMachineIndex({ root });
  assert.equal(still.entries.length, 0);
  assert.equal(still.removed.length, 1);

  // Only a person's explicit `git pigeon init` overrides the tombstone.
  await registerMachinePigeon(repository, config, { root, pid: null, fresh: true });
  const back = await loadMachineIndex({ root });
  const republished = directoryValue(back, back.entries);
  assert.equal(republished.removed, undefined);
  assert.equal(republished.pigeons.length, 1);
});

test('unregistering one duplicate clone does not tombstone the surviving registration', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { registerMachinePigeon, unregisterMachinePigeon, loadMachineIndex } =
    await import('../src/machine-index.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-duplicate-clone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    repositoryId: 'e'.repeat(32),
    secret: 'z'.repeat(43),
    deviceId: 'd'.repeat(32),
    name: 'test',
  };
  await registerMachinePigeon({ root: path.join(root, 'test') }, config, { root, pid: null });
  await registerMachinePigeon({ root: path.join(root, 'test-2') }, config, { root, pid: null });

  // Dropping one path while another still registers the repository is a
  // rename or de-duplication, not a removal. Tombstoning it anyway outdated
  // the surviving registration and the fleet deleted a repository every
  // machine still wanted.
  await unregisterMachinePigeon({ root: path.join(root, 'test-2') }, { root });
  const state = await loadMachineIndex({ root });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].repository, path.join(root, 'test'));
  assert.deepEqual(state.removed, []);

  // Dropping the last path is a removal and states one.
  await unregisterMachinePigeon({ root: path.join(root, 'test') }, { root });
  const removed = await loadMachineIndex({ root });
  assert.equal(removed.entries.length, 0);
  assert.equal(removed.removed.length, 1);
  assert.equal(removed.removed[0].repositoryId, 'e'.repeat(32));
});

test('a repository can be tombstoned by ID alone to clear orphaned directory records', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { registerMachinePigeon, tombstoneMachinePigeon, loadMachineIndex } =
    await import('../src/machine-index.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-tombstone-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // A record orphaned by a retired or re-paired machine lists a repository no
  // machine still watches. Nothing can unwatch it by name — there is no clone
  // or registration left anywhere — so the ID is the only handle.
  const orphaned = await tombstoneMachinePigeon('o'.repeat(32), { root, now: 1_700_000_000_000 });
  assert.equal(orphaned.unregistered, 0);
  assert.deepEqual(orphaned.state.removed, [
    { repositoryId: 'o'.repeat(32), removedAt: '2023-11-14T22:13:20.000Z' },
  ]);

  // When the ID is still registered locally, tombstoning removes the entry
  // too; a tombstone alongside a live local entry converges to removal anyway.
  const repository = { root: path.join(root, 'repo'), gitDir: path.join(root, 'repo/.git') };
  await registerMachinePigeon(repository, {
    repositoryId: 'r'.repeat(32),
    secret: 'z'.repeat(43),
    deviceId: 'd'.repeat(32),
    name: 'test',
  }, { root, pid: null });
  const registered = await tombstoneMachinePigeon('r'.repeat(32), { root });
  assert.equal(registered.unregistered, 1);
  assert.equal((await loadMachineIndex({ root })).entries.length, 0);

  await assert.rejects(tombstoneMachinePigeon('!bad', { root }), /Invalid GitPigeon repository ID/);
});

test('shares travel with every holder, carry their creation time, and end as a stated fact', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-share-record-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 'state');
  const repository = await createRepository(path.join(root, 'shared'));
  const key = 'S'.repeat(43);
  const adopted = {
    ...createIdentity({ repositoryId: 'shared-pigeon', secret: 'c'.repeat(64), deviceId: 'gamma-device' }),
    share: { key, ownerPublicKey: 'owner-public-key-of-another-machine', role: 'mirror', adopted: true, createdAt: '2026-09-01T10:00:00.000Z' },
  };
  // An adopter declares the share too — the link outlives the owner's record.
  await registerMachinePigeon(repository, adopted, { root: stateRoot, pid: process.pid });
  let state = await loadMachineIndex({ root: stateRoot });
  let record = publisherDirectoryValue(state, await listMachinePigeons({ root: stateRoot, activeOnly: false }), Date.now());
  assert.deepEqual(record.pigeons[0].share, {
    key,
    ownerPublicKey: 'owner-public-key-of-another-machine',
    createdAt: '2026-09-01T10:00:00.000Z',
    adopted: true,
  });
  assert.equal(record.sharesEnded, undefined);

  // A lock is stated, and travels in the record.
  await markShareEnded('shared-pigeon', key, { root: stateRoot, now: Date.parse('2026-09-02T12:00:00.000Z') });
  state = await loadMachineIndex({ root: stateRoot });
  assert.deepEqual(state.sharesEnded, [{ repositoryId: 'shared-pigeon', key, endedAt: '2026-09-02T12:00:00.000Z' }]);
  record = publisherDirectoryValue(state, await listMachinePigeons({ root: stateRoot, activeOnly: false }), Date.parse('2026-09-02T12:00:01.000Z'));
  assert.deepEqual(record.sharesEnded, [{ repositoryId: 'shared-pigeon', key, endedAt: '2026-09-02T12:00:00.000Z' }]);

  // Re-sharing at the usual link retracts the ending.
  const owner = { ...adopted, share: { key, ownerPublicKey: 'owner-public-key-of-another-machine', role: 'owner', createdAt: '2026-09-01T10:00:00.000Z' } };
  await registerMachinePigeon(repository, owner, { root: stateRoot, pid: process.pid });
  state = await loadMachineIndex({ root: stateRoot });
  assert.deepEqual(state.sharesEnded, []);
  record = publisherDirectoryValue(state, await listMachinePigeons({ root: stateRoot, activeOnly: false }), Date.now());
  assert.equal(record.pigeons[0].share.adopted, undefined);
  assert.equal(record.sharesEnded, undefined);
});
