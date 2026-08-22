import assert from 'node:assert/strict';
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TERMINAL_CHANNEL } from '../src/channel.js';
import { TerminalServer } from '../src/terminal-server.js';
import { FakeNode } from './fake-node.js';

const helper = fileURLToPath(new URL(
  `../node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
  import.meta.url,
));

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

test('the watcher shell opens even when node-pty ships without its execute bit', async (t) => {
  if (process.platform === 'win32') return;
  let original;
  try {
    original = (await stat(helper)).mode;
  } catch {
    return; // node-pty prebuilds are absent on this platform
  }
  t.after(() => chmod(helper, original));

  // This repository's .npmrc sets ignore-scripts=true to keep PeerPigeon and
  // FreeRTC pinned, so node-pty's install script never restores this bit and
  // every terminal failed with a bare "posix_spawnp failed".
  await chmod(helper, 0o644);

  const repositoryId = 'repository-terminal-spawn';
  const serviceInstanceId = 'a'.repeat(32);
  const node = new FakeNode();
  const server = new TerminalServer({
    node,
    repository: { root: fileURLToPath(new URL('..', import.meta.url)) },
    secret: 'terminal-spawn-secret',
    repositoryId,
    serviceInstanceId,
    deviceName: 'spawn-test',
  });
  server.start();
  t.after(() => server.stop());

  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, {
    serviceInstanceId,
    sessionId: 'b'.repeat(32),
    kind: 'open',
    sequence: 0,
    cols: 80,
    rows: 24,
    devices: [{ name: 'spawn-test' }],
  });
  await settle();

  const errors = node.directFrames(TERMINAL_CHANNEL).filter((frame) => frame.kind === 'error');
  assert.deepEqual(errors.map((frame) => frame.message), [], 'the shell must open');
  assert.equal(server.activeSessionCount(), 1);
  assert.ok((await stat(helper)).mode & 0o111, 'the execute bit should have been restored');
});
