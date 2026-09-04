import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandStart, commandStop, materializeGrantedRepositories } from '../src/cli.js';
import { createIdentity } from '../src/config.js';
import { listMachinePigeons, loadMachineIndex, registerMachinePigeon } from '../src/machine-index.js';
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
  // behaviour never took effect. The check is ORDERED, not an inequality:
  // the auto-updater legitimately moves the service ahead of an old
  // /usr/local/bin shim, and treating "different" as "stale" made that shim
  // kill the newer healthy service on every invocation.
  assert.match(source, /buildVersion: GITPIGEON_VERSION/);
  assert.match(source, /const stale = current\.running && isNewerVersion\(GITPIGEON_VERSION, current\.buildVersion\)/);
  assert.match(source, /if \(current\.running && current\.compatible && !stale\) return/);
});

test('the version command prints the running build and nothing else', async () => {
  const { main } = await import('../src/cli.js');
  const { GITPIGEON_VERSION } = await import('../src/version.js');
  const lines = [];
  const original = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    for (const spelling of ['version', '--version', '-version', '-V', '-v']) {
      lines.length = 0;
      await main([spelling]);
      assert.deepEqual(lines, [GITPIGEON_VERSION]);
    }
  } finally {
    console.log = original;
  }
});

test("two different repositories with one name never get a -2 folder: the second nests under its id", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gitpigeon-clone-name-test-"));
  const stateRoot = path.join(root, "state");
  const cloneRoot = path.join(root, "repositories");
  t.after(() => rm(root, { recursive: true, force: true }));
  const capabilities = [
    { repositoryId: "aaaaaaaaaaaa1111", secret: "a".repeat(43), name: "test" },
    { repositoryId: "bbbbbbbbbbbb2222", secret: "b".repeat(43), name: "test" },
  ];
  const added = await materializeGrantedRepositories(capabilities, { root: stateRoot, base: cloneRoot });
  const { realpath } = await import("node:fs/promises");
  const real = await realpath(cloneRoot);
  const roots = (await Promise.all(added.map((item) => realpath(item.repository.root)))).sort();
  assert.deepEqual(roots, [
    path.join(real, "bbbbbbbbbbbb", "test"),
    path.join(real, "test"),
  ]);
  assert.ok(roots.every((value) => !/-\d+$/.test(value)), "no clone folder carries a numeric suffix");
  // The folder basename is the repository's name on BOTH, and so is the
  // stored name every watcher publishes.
  for (const item of added) {
    assert.equal(path.basename(item.repository.root), "test");
    assert.equal(item.config.name, "test");
  }
  const entries = await listMachinePigeons({ root: stateRoot, activeOnly: false });
  assert.deepEqual(entries.map((entry) => entry.name), ["test", "test"]);
});

test('update, install and doctor say when the git-pigeon on PATH is a frozen copy', async () => {
  const { reportCommandOnPath } = await import('../src/cli.js');
  const lines = [];
  const print = (value) => lines.push(String(value));
  const frozen = await reportCommandOnPath({
    print,
    standalone: false,
    root: '/state',
    inspect: async () => ({ path: '/usr/local/bin/git-pigeon', shim: '/home/me/.local/bin/git-pigeon', script: false, chases: false, frozen: true }),
  });
  assert.equal(frozen.frozen, true);
  assert.match(lines.join('\n'), /runs \/usr\/local\/bin\/git-pigeon, a frozen copy/);
  assert.match(lines.join('\n'), /sudo install -m 0755 '\/home\/me\/.local\/bin\/git-pigeon' '\/usr\/local\/bin\/git-pigeon'/);

  lines.length = 0;
  await reportCommandOnPath({
    print,
    standalone: false,
    root: '/state',
    inspect: async () => ({ path: null, shim: '/home/me/.local/bin/git-pigeon', script: false, chases: false, frozen: false }),
  });
  assert.match(lines.join('\n'), /not on this shell's PATH\. Add \/home\/me\/.local\/bin to PATH/);

  lines.length = 0;
  await reportCommandOnPath({
    print,
    standalone: false,
    root: '/state',
    inspect: async () => ({ path: '/home/me/.local/bin/git-pigeon', shim: '/home/me/.local/bin/git-pigeon', script: true, chases: true, frozen: false }),
  });
  assert.deepEqual(lines, []);
});

test('start drops a registration whose clone vanished from disk, without tombstoning the repository', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-start-vanished-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kept = await createRepository(path.join(root, 'kept'));
  const deleted = await createRepository(path.join(root, 'GitPigeon-2'));
  const stateRoot = path.join(root, 'state');
  await registerMachinePigeon(kept, createIdentity({
    repositoryId: 'vanished-kept',
    secret: 'a'.repeat(64),
    deviceId: 'vanished-device-kept',
  }), { root: stateRoot, pid: null });
  await registerMachinePigeon(deleted, createIdentity({
    repositoryId: 'vanished-deleted',
    secret: 'b'.repeat(64),
    deviceId: 'vanished-device-deleted',
  }), { root: stateRoot, pid: null });
  // The person removed the folder — rm -rf — and never ran unwatch.
  await rm(deleted.root, { recursive: true, force: true });
  const loaded = [];
  const printed = [];
  const original = console.log;
  console.log = (value) => printed.push(String(value));
  try {
    await commandStart([], {
      indexRoot: stateRoot,
      startService: async () => ({ started: true }),
      waitForRepository: async (_indexRoot, repository) => { loaded.push(repository); },
    });
  } finally {
    console.log = original;
  }
  // Only the surviving clone is waited on; the vanished one is no longer registered.
  assert.deepEqual(loaded, [kept.root]);
  const remaining = await listMachinePigeons({ root: stateRoot, activeOnly: false });
  assert.deepEqual(remaining.map((entry) => entry.repositoryId), ['vanished-kept']);
  // A deleted folder is not a fleet-wide removal: no tombstone, other machines keep it.
  const index = await loadMachineIndex({ root: stateRoot, create: false });
  assert.deepEqual(index.removed ?? [], []);
  assert.ok(printed.some((line) => /no longer exists; dropped it from this machine's index/.test(line)), printed.join('\n'));
});
