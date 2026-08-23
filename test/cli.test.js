import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandStart, commandStop, materializeGrantedRepositories } from '../src/cli.js';
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

test('start launches the machine-wide service and waits for every persistent repository', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-start-persistent-index-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await createRepository(path.join(root, 'first'));
  const second = await createRepository(path.join(root, 'second'));
  const stateRoot = path.join(root, 'state');
  await registerMachinePigeon(first, createIdentity({
    repositoryId: 'start-persistent-first',
    secret: 'a'.repeat(64),
    deviceId: 'start-persistent-device-first',
  }), { root: stateRoot, pid: null });
  await registerMachinePigeon(second, createIdentity({
    repositoryId: 'start-persistent-second',
    secret: 'b'.repeat(64),
    deviceId: 'start-persistent-device-second',
  }), { root: stateRoot, pid: null });
  let serviceOptions;
  const loaded = [];

  await commandStart(['--poll', '750ms'], {
    verbose: true,
    indexRoot: stateRoot,
    startService: async (options) => {
      serviceOptions = options;
      return { started: true };
    },
    waitForRepository: async (indexRoot, repository) => {
      assert.equal(indexRoot, stateRoot);
      loaded.push(repository);
    },
  });

  assert.deepEqual(serviceOptions, { root: stateRoot, pollMs: 750, verbose: true });
  assert.deepEqual(loaded.sort(), [first.root, second.root].sort());
});

test('start launches the watcher on an empty index so a paired machine is a peer', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-start-empty-index-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let started = false;
  // The service joins the encrypted index with or without repositories.
  // Refusing here left a freshly paired machine invisible in the browser, with
  // no way to confirm it short of registering a repository first.
  await commandStart([], {
    indexRoot: path.join(root, 'state'),
    startService: async () => {
      started = true;
      return { started: true, pid: 4242 };
    },
  });
  assert.equal(started, true);
});

test('restart stops the service even when the index is empty', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-restart-empty-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const order = [];
  // Without this, `git pigeon restart` reported success on an empty index
  // without restarting, so a service holding stale state kept running.
  await commandStart([], {
    restart: true,
    indexRoot: path.join(root, 'state'),
    stopService: async () => { order.push('stop'); },
    startService: async () => { order.push('start'); return { started: true, pid: 4242 }; },
  });
  assert.deepEqual(order, ['stop', 'start']);
});

test('restart replaces the watcher and reports the completed restart', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-restart-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(path.join(root, 'repository'));
  const stateRoot = path.join(root, 'state');
  await registerMachinePigeon(repository, createIdentity({
    repositoryId: 'restart-persistent-repository',
    secret: 'r'.repeat(64),
    deviceId: 'restart-persistent-device',
  }), { root: stateRoot, pid: null });
  const calls = [];
  const messages = [];
  t.mock.method(console, 'log', (message) => messages.push(message));

  await commandStart([], {
    indexRoot: stateRoot,
    restart: true,
    stopService: async (indexRoot) => { calls.push(`stop:${indexRoot}`); },
    startService: async ({ root: indexRoot }) => {
      calls.push(`start:${indexRoot}`);
      return { started: true };
    },
    waitForRepository: async (indexRoot, repositoryRoot) => {
      calls.push(`wait:${indexRoot}:${repositoryRoot}`);
    },
  });

  assert.deepEqual(calls, [
    `stop:${stateRoot}`,
    `start:${stateRoot}`,
    `wait:${stateRoot}:${repository.root}`,
  ]);
  assert.deepEqual(messages, [
    'GitPigeon restarted the machine-wide background service and is watching 1 repository.',
  ]);
});

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
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
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

test("approved enrollment materializes every shared repository in the native index", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gitpigeon-enrollment-index-test-"));
  const stateRoot = path.join(root, "state");
  const cloneRoot = path.join(root, "repositories");
  t.after(() => rm(root, { recursive: true, force: true }));
  const capabilities = [
    { repositoryId: "shared-repository-one", secret: "a".repeat(43), name: "First repository" },
    { repositoryId: "shared-repository-two", secret: "b".repeat(43), name: "Second repository" },
  ];
  const added = await materializeGrantedRepositories(capabilities, { root: stateRoot, base: cloneRoot });
  assert.equal(added.length, 2);
  const entries = await listMachinePigeons({ root: stateRoot, activeOnly: false });
  assert.deepEqual(entries.map((entry) => entry.repositoryId).sort(), [
    "shared-repository-one",
    "shared-repository-two",
  ]);
  assert.equal((await materializeGrantedRepositories(capabilities, { root: stateRoot, base: cloneRoot })).length, 0);
});

test('a service from an older build is not treated as already running', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/daemon.js', import.meta.url), 'utf8');

  // A running service keeps serving its own code. The protocol number only
  // changes when the wire changes, so without a build check a new release
  // installed and the previous process carried on serving indefinitely — new
  // behaviour never took effect.
  assert.match(source, /buildVersion: GITPIGEON_VERSION/);
  assert.match(source, /const stale = current\.running && current\.buildVersion !== GITPIGEON_VERSION/);
  assert.match(source, /if \(current\.running && current\.compatible && !stale\) return/);
});
