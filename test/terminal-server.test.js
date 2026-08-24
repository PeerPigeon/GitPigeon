import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TERMINAL_CHANNEL } from '../src/channel.js';
import { TerminalServer } from '../src/terminal-server.js';
import { FakeNode } from './fake-node.js';

const repositoryId = 'repository-terminal';
const serviceInstanceId = 'a'.repeat(32);
const secret = 'terminal-test-secret';
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('device list labels the current device immediately after its index', () => {
  const roster = Buffer.from(JSON.stringify([
    { name: 'Daniels-Mac-mini.local' },
    { name: 'Other-Mac.local' },
  ])).toString('base64url');
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL('../bin/gitpigeon-device.js', import.meta.url)),
    'list',
  ], {
    encoding: 'utf8',
    env: { ...process.env, GITPIGEON_DEVICE_ROSTER: roster },
  });

  assert.equal(output, '0  [this device] Daniels-Mac-mini.local\n1  Other-Mac.local\n');

  const bundledCommandOutput = execFileSync(process.execPath, [
    fileURLToPath(new URL('../bin/git-pigeon.js', import.meta.url)),
    'terminal-device',
    'list',
  ], {
    encoding: 'utf8',
    env: { ...process.env, GITPIGEON_DEVICE_ROSTER: roster },
  });
  assert.equal(bundledCommandOutput, output);
});

class FakePty {
  writes = [];
  resizes = [];
  killed = false;
  dataListeners = new Set();
  exitListeners = new Set();

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() { this.killed = true; }
}

function browserFrame(kind, sequence, fields = {}) {
  return {
    serviceInstanceId,
    sessionId: 'b'.repeat(32),
    kind,
    sequence,
    ...fields,
  };
}

test('terminal frames from another repository or service instance are ignored', async (t) => {
  const node = new FakeNode();
  const server = new TerminalServer({
    node,
    repository: { root: '/tmp/example-repository' },
    secret,
    repositoryId,
    serviceInstanceId,
    deviceName: 'test-device',
    spawnPty() { throw new Error('must not spawn a shell'); },
  });
  server.start();
  t.after(() => server.stop());

  node.receive('browser-peer', 'another-repository', TERMINAL_CHANNEL, browserFrame('open', 0, { cols: 80, rows: 24 }));
  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, {
    ...browserFrame('open', 0, { cols: 80, rows: 24 }),
    serviceInstanceId: 'f'.repeat(32),
  });
  await settle();
  assert.equal(server.activeSessionCount(), 0);
  assert.equal(node.direct.length, 0);
});

test('watcher terminal opens one bounded PTY and cleans it up on close', async (t) => {
  const node = new FakeNode();
  const spawned = [];
  const server = new TerminalServer({
    node,
    repository: { root: '/tmp/example-repository' },
    secret,
    repositoryId,
    serviceInstanceId,
    deviceName: 'test-device',
    spawnPty(shell, args, options) {
      const terminal = new FakePty();
      spawned.push({ shell, args, options, terminal });
      return terminal;
    },
  });
  server.start();
  t.after(() => server.stop());

  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('open', 0, {
    cols: 120,
    rows: 40,
    devices: [{ name: 'test-device' }, { name: 'other-device' }],
  }));
  await settle();

  assert.equal(server.activeSessionCount(), 1);
  assert.equal(spawned.length, 1);
  // /tmp/example-repository does not exist, and the terminal belongs to the
  // device: a missing repository directory falls back to the home directory
  // rather than refusing a shell.
  const { homedir } = await import('node:os');
  assert.equal(spawned[0].options.cwd, homedir());
  assert.match(spawned[0].options.env.GITPIGEON_DEVICE_ROSTER, /^[A-Za-z0-9_-]+$/);
  assert.equal(node.directFrames(TERMINAL_CHANNEL)[0]?.kind, 'opened');
  // machine [directory/*] gitpigeon $ — same shape on every device.
  assert.match(spawned[0].terminal.writes[0], /test-device.*\[\.\.\/%1~\/\*\].*\$/);

  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('input', 1, {
    payload: Buffer.from('pwd\r').toString('base64'),
  }));
  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('resize', 2, { cols: 90, rows: 25 }));
  await settle();
  assert.equal(spawned[0].terminal.writes.at(-1), 'pwd\r');
  assert.deepEqual(spawned[0].terminal.resizes, [[90, 25]]);

  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('close', 3));
  await settle();
  assert.equal(server.activeSessionCount(), 0);
  assert.equal(spawned[0].terminal.killed, true);
});
