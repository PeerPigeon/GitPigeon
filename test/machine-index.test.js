import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIdentity } from '../src/config.js';
import {
  claimPairingUrl,
  directoryValue,
  listMachinePigeons,
  loadMachineIndex,
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
  const published = directoryValue(state, active, 1_700_000_000_000);
  assert.equal(published.protocol, 'gitpigeon-index/1');
  assert.equal(published.updatedAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(published.pigeons, [
    { repositoryId: 'alpha-pigeon', secret: 'a'.repeat(64), name: 'alpha', watcherCount: 1 },
    { repositoryId: 'beta-pigeon', secret: 'b'.repeat(64), name: 'beta', watcherCount: 1 },
  ]);

  assert.equal((await unregisterMachinePigeon(firstRepository, { root: stateRoot })).removed, true);
  assert.deepEqual((await listMachinePigeons({ root: stateRoot })).map(({ repositoryId }) => repositoryId), ['beta-pigeon']);
});

test('pairing is claimed once and opens without a shell', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-pairing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = await claimPairingUrl({ root });
  assert.match(url, /^https:\/\/gitpigeon\.dev\/#pair=[a-f0-9]{32}\.[a-zA-Z0-9_-]{32,256}$/);
  assert.equal(await claimPairingUrl({ root }), null);

  let invocation;
  const child = { unref() {} };
  assert.equal(openDashboard(url, {
    platform: 'darwin',
    environment: {},
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  }), true);
  assert.equal(invocation.command, 'open');
  assert.deepEqual(invocation.args, [url]);
  assert.equal(invocation.options.shell, false);
});
