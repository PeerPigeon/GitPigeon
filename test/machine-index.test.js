import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIdentity } from '../src/config.js';
import {
  claimDashboardPairing,
  completeDashboardPairing,
  directoryValue,
  liveDirectoryKey,
  listMachinePigeons,
  loadMachineIndex,
  markMachinePigeonStopped,
  openDashboard,
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
  assert.deepEqual(published.pigeons, [
    { repositoryId: 'alpha-pigeon', secret: 'a'.repeat(64), name: 'alpha', watcherCount: 1, watcherServiceId },
    { repositoryId: 'beta-pigeon', secret: 'b'.repeat(64), name: 'beta', watcherCount: 1, watcherServiceId },
  ]);
  assert.equal(liveDirectoryKey(state.indexId, 340_000_000), `gitpigeon/index/v1/${state.indexId}/live/340000000`);

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
