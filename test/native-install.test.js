import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installNativeIntegration } from '../src/native-install.js';

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
    assert.match(await readFile(result.commandPath, 'utf8'), /exec '\/opt\/GitPigeon\/git-pigeon' "\$@"/);
    const desktop = await readFile(result.handler, 'utf8');
    assert.match(desktop, /x-scheme-handler\/gitpigeon/);
    assert.match(desktop, / protocol %u/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
