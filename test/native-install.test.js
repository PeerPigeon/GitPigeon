import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ensureServiceWatchdog, installNativeIntegration, refreshNativeCommandShim, removeServiceWatchdog, watchdogPlist } from '../src/native-install.js';

const execFileAsync = promisify(execFile);

test('installs the real git-pigeon command and encrypted-link handler in a user profile', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-native-install-'));
  try {
    const result = await installNativeIntegration({
      platform: 'linux',
      home,
      invocation: ['/opt/GitPigeon/git-pigeon'],
      run: async () => '',
    });
    assert.equal(result.commandPath, path.join(home, '.local', 'bin', 'git-pigeon'));
    const shim = await readFile(result.commandPath, 'utf8');
    // The shim chases the automatically updated build first; the install-time
    // binary is only the fallback. Baking it in left `git pigeon` answering
    // as an old build forever after the service auto-updated.
    assert.match(shim, /updates\/current\.json/);
    assert.match(shim, /exec '\/opt\/GitPigeon\/git-pigeon' "\$@"/);
    const desktop = await readFile(result.handler, 'utf8');
    assert.match(desktop, /x-scheme-handler\/gitpigeon/);
    assert.match(desktop, / protocol %u/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the command shim runs the executable current.json names, or falls back', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX shim');
  const home = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-shim-refresh-'));
  try {
    const stateDir = path.join(home, 'state');
    const fallback = path.join(home, 'fallback');
    await writeFile(fallback, '#!/bin/sh\necho fallback\n', { mode: 0o755 });
    const { commandPath } = await refreshNativeCommandShim({
      platform: 'linux',
      home,
      invocation: [fallback],
    });
    const environment = { ...process.env, GITPIGEON_STATE_DIR: stateDir };

    // Without current.json the shim uses the install-time binary.
    const before = await execFileAsync(commandPath, [], { env: environment });
    assert.equal(before.stdout.trim(), 'fallback');

    // Once an automatic update records current.json, the shim follows it.
    const updated = path.join(home, 'updated');
    await writeFile(updated, '#!/bin/sh\necho updated "$1"\n', { mode: 0o755 });
    await chmod(updated, 0o755);
    await mkdir(path.join(stateDir, 'updates'), { recursive: true });
    await writeFile(path.join(stateDir, 'updates', 'current.json'), `${JSON.stringify({
      version: 1,
      releaseVersion: '9.9.9',
      executable: updated,
    }, null, 2)}\n`);
    const after = await execFileAsync(commandPath, ['--version'], { env: environment });
    assert.equal(after.stdout.trim(), 'updated --version');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('the launchd watchdog installs once, reloads only on change, and stop removes it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-watchdog-'));
  try {
    const calls = [];
    const loaded = { value: false };
    const run = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'print' && !loaded.value) throw new Error('not loaded');
      if (args[0] === 'bootstrap') loaded.value = true;
      if (args[0] === 'bootout') loaded.value = false;
      return '';
    };

    const first = await ensureServiceWatchdog({ platform: 'darwin', home, commandPath: '/x/git-pigeon', uid: 501, run });
    assert.equal(first.changed, true);
    const plist = await readFile(first.plist, 'utf8');
    assert.equal(plist, watchdogPlist('/x/git-pigeon'));
    assert.match(plist, /<string>start<\/string>/);
    assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/);
    assert.deepEqual(calls.at(-1), ['launchctl', 'bootstrap', 'gui/501', first.plist]);

    // The agent's own `start` invocation runs this code: with nothing
    // changed and the job loaded, it must not bootout itself.
    calls.length = 0;
    const second = await ensureServiceWatchdog({ platform: 'darwin', home, commandPath: '/x/git-pigeon', uid: 501, run });
    assert.equal(second.changed, false);
    assert.equal(calls.some(([, verb]) => verb === 'bootout' || verb === 'bootstrap'), false);

    await removeServiceWatchdog({ platform: 'darwin', home, uid: 501, run });
    assert.equal(loaded.value, false);
    await assert.rejects(readFile(first.plist, 'utf8'), { code: 'ENOENT' });

    // Non-macOS platforms are untouched.
    assert.equal(await ensureServiceWatchdog({ platform: 'linux', home, uid: 501, run }), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
