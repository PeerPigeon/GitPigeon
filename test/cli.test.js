import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandStop } from '../src/cli.js';
import { createIdentity } from '../src/config.js';
import { listMachinePigeons, registerMachinePigeon } from '../src/machine-index.js';
import { createRepository } from './helpers.js';

function startFixtureProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function stopFixtureProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGKILL'); } catch { /* already exited */ }
  await once(child, 'exit').catch(() => {});
}

async function waitForExit(child) {
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
}

test('stop terminates discovered watcher processes even when the index is empty', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-stop-empty-index-test-'));
  const child = startFixtureProcess();
  t.after(async () => {
    await stopFixtureProcess(child);
    await rm(root, { recursive: true, force: true });
  });

  await commandStop([], {
    indexRoot: path.join(root, 'state'),
    findWatcherPids: async () => [child.pid],
  });
  await waitForExit(child);
  assert.notEqual(child.signalCode, null);
});

test('stop marks registered repositories inactive without removing the persistent index', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-stop-persistent-index-test-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const repository = await createRepository(path.join(root, 'repository'));
  const stateRoot = path.join(root, 'state');
  const config = createIdentity({
    repositoryId: 'stop-persistent-pigeon',
    secret: 's'.repeat(64),
    deviceId: 'stop-persistent-device',
  });
  await registerMachinePigeon(repository, config, { root: stateRoot, pid: process.pid });

  await commandStop([], { indexRoot: stateRoot, findWatcherPids: async () => [] });

  const entries = await listMachinePigeons({ root: stateRoot, activeOnly: false });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].repository, repository.root);
  assert.equal(entries[0].pid, null);
});
