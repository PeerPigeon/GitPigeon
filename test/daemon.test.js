import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWatchControl,
  isGitPigeonWatcherCommand,
  listGitPigeonWatcherPids,
  startWatchDaemon,
  stopWatchDaemon,
  watcherPidsFromProcessRows,
  watchDaemonStatus,
} from '../src/daemon.js';
import { createRepository } from './helpers.js';

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

test('watcher control reports status and stops through its authenticated heartbeat channel', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-daemon-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(path.join(root, 'repository'));
  const token = 'a'.repeat(64);
  let control;
  let closeError;
  control = await createWatchControl(repository, token, () => {
    control.close().catch((error) => { closeError = error; });
  });

  const status = await watchDaemonStatus(repository.gitDir);
  assert.equal(status.running, true);
  assert.equal(status.pid, process.pid);
  assert.deepEqual(await stopWatchDaemon(repository), { stopped: true });
  assert.equal(closeError, undefined);
  assert.equal((await watchDaemonStatus(repository.gitDir)).running, false);
});

test('starts and stops a detached watcher process', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-daemon-process-test-'));
  const repository = await createRepository(path.join(root, 'repository'));
  const fixture = path.join(root, 'watcher.mjs');
  const daemonUrl = new URL('../src/daemon.js', import.meta.url).href;
  const gitUrl = new URL('../src/git.js', import.meta.url).href;
  await writeFile(fixture, `
    import { createWatchControl } from ${JSON.stringify(daemonUrl)};
    import { GitRepository } from ${JSON.stringify(gitUrl)};
    const token = process.argv.find((value) => value.startsWith('--daemon-child='))?.split('=')[1];
    const repository = await GitRepository.discover(process.cwd());
    let stop;
    const stopped = new Promise((resolve) => { stop = resolve; });
    const control = await createWatchControl(repository, token, stop);
    await stopped;
    await control.close();
  `);
  t.after(async () => {
    try { await stopWatchDaemon(repository); } catch { /* best effort cleanup */ }
    await rm(root, { recursive: true, force: true });
  });

  const started = await startWatchDaemon(repository, { entrypoint: fixture });
  assert.equal(started.started, true);
  assert.equal((await watchDaemonStatus(repository.gitDir)).running, true);
  assert.deepEqual(await stopWatchDaemon(repository), { stopped: true });
  assert.equal((await watchDaemonStatus(repository.gitDir)).running, false);
});
