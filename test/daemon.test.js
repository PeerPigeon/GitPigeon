import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWatchServiceControl,
  isGitPigeonWatcherCommand,
  listGitPigeonWatcherPids,
  startWatchService,
  stopWatchService,
  watcherPidsFromProcessRows,
  waitForWatchServiceRepository,
  watchServiceStatus,
} from '../src/daemon.js';

test('finds only GitPigeon foreground watcher processes', async () => {
  assert.equal(isGitPigeonWatcherCommand('/usr/bin/node /repo/bin/git-pigeon.js watch --foreground --daemon-child=secret'), true);
  assert.equal(isGitPigeonWatcherCommand('node C:\\repo\\bin\\git-pigeon.js watch --foreground'), true);
  assert.equal(isGitPigeonWatcherCommand('/usr/bin/node /repo/bin/git-pigeon.js stop'), false);
  assert.deepEqual(watcherPidsFromProcessRows([
    { pid: 10, command: '/usr/bin/node /repo/bin/git-pigeon.js watch --foreground' },
    { pid: 11, command: '/usr/bin/node /repo/bin/git-pigeon.js status' },
    { pid: 10, command: '/usr/bin/node /repo/bin/git-pigeon.js watch --foreground' },
  ], 99), [10]);

  assert.deepEqual(await listGitPigeonWatcherPids({
    platform: 'linux',
    run: async () => ({ stdout: '  21 /usr/bin/node /repo/bin/git-pigeon.js watch --foreground\n  22 node other.js\n' }),
  }), [21]);
  assert.deepEqual(await listGitPigeonWatcherPids({
    platform: 'win32',
    run: async () => ({ stdout: JSON.stringify([
      { ProcessId: 31, CommandLine: 'node C:\\repo\\bin\\git-pigeon.js watch --foreground' },
      { ProcessId: 32, CommandLine: 'node C:\\repo\\bin\\git-pigeon.js list' },
    ]) }),
  }), [31]);
});

test('service control reports status and stops through its authenticated heartbeat channel', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-service-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = 'a'.repeat(64);
  let control;
  let closeError;
  control = await createWatchServiceControl(root, token, () => {
    control.close().catch((error) => { closeError = error; });
  });
  await control.ready();

  const status = await watchServiceStatus(root);
  assert.equal(status.running, true);
  assert.equal(status.compatible, true);
  assert.equal(status.pid, process.pid);
  const repository = path.join(root, 'repository');
  const pending = waitForWatchServiceRepository(root, repository);
  await control.setRepositoryState([repository]);
  assert.equal((await pending).activeRepositories[0], repository);
  assert.deepEqual(await stopWatchService(root), { stopped: true });
  assert.equal(closeError, undefined);
  assert.equal((await watchServiceStatus(root)).running, false);
});

test('simultaneous starts create exactly one machine-wide watcher service', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-service-process-test-'));
  const stateRoot = path.join(root, 'state');
  const fixture = path.join(root, 'service.mjs');
  const daemonUrl = new URL('../src/daemon.js', import.meta.url).href;
  await writeFile(fixture, `
    import { createWatchServiceControl } from ${JSON.stringify(daemonUrl)};
    const value = (name) => process.argv.find((item) => item.startsWith(name + '='))?.slice(name.length + 1);
    const token = value('--service-child');
    const root = value('--state-dir');
    let stop;
    const stopped = new Promise((resolve) => { stop = resolve; });
    const control = await createWatchServiceControl(root, token, stop);
    await control.ready();
    await stopped;
    await control.close();
  `);
  t.after(async () => {
    try { await stopWatchService(stateRoot); } catch { /* best effort cleanup */ }
    await rm(root, { recursive: true, force: true });
  });

  const options = { root: stateRoot, entrypoint: fixture, findWatcherPids: async () => [] };
  const [left, right] = await Promise.all([
    startWatchService(options),
    startWatchService(options),
  ]);
  assert.equal([left.started, right.started].filter(Boolean).length, 1);
  assert.equal(left.pid, right.pid);
  assert.equal((await watchServiceStatus(stateRoot)).pid, left.pid);
  assert.deepEqual(await stopWatchService(stateRoot), { stopped: true });
  assert.equal((await watchServiceStatus(stateRoot)).running, false);
});
