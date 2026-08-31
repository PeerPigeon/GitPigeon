import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { installNativeIntegration, refreshNativeCommandShim } from '../src/native-install.js';

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
