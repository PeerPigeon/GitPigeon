import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  TERMINAL_PROTOCOL,
  TerminalServer,
  decryptTerminalFrame,
  encryptTerminalFrame,
} from '../src/terminal-server.js';

const repositoryId = 'repository-terminal';
const serviceInstanceId = 'a'.repeat(32);
const secret = 'terminal-test-secret';
const settle = () => new Promise((resolve) => setImmediate(resolve));

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
});

class FakeNode extends EventEmitter {
  sent = [];

  sendDirect(peerId, data) {
    this.sent.push({ peerId, data });
    return `message-${this.sent.length}`;
  }
}

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
  return encryptTerminalFrame(secret, repositoryId, {
    protocol: TERMINAL_PROTOCOL,
    repositoryId,
    serviceInstanceId,
    sessionId: 'b'.repeat(32),
    kind,
    sequence,
    ...fields,
  });
}

test('terminal frames are authenticated to the repository secret', () => {
  const encrypted = browserFrame('ping', 1);
  assert.equal(decryptTerminalFrame(secret, repositoryId, encrypted)?.kind, 'ping');
  assert.equal(decryptTerminalFrame('wrong-secret', repositoryId, encrypted), null);
  assert.equal(decryptTerminalFrame(secret, 'another-repository', encrypted), null);
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

  node.emit('message', {
    kind: 'direct',
    local: false,
    fromPeerId: 'browser-peer',
    data: browserFrame('open', 0, {
      cols: 120,
      rows: 40,
      devices: [{ name: 'test-device' }, { name: 'other-device' }],
    }),
  });
  await settle();

  assert.equal(server.activeSessionCount(), 1);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.cwd, '/tmp/example-repository');
  assert.match(spawned[0].options.env.GITPIGEON_DEVICE_ROSTER, /^[A-Za-z0-9_-]+$/);
  assert.equal(decryptTerminalFrame(secret, repositoryId, node.sent[0].data)?.kind, 'opened');
  assert.match(spawned[0].terminal.writes[0], /gitpigeon test-device:\$/);

  node.emit('message', {
    kind: 'direct',
    local: false,
    fromPeerId: 'browser-peer',
    data: browserFrame('input', 1, { payload: Buffer.from('pwd\r').toString('base64') }),
  });
  node.emit('message', {
    kind: 'direct',
    local: false,
    fromPeerId: 'browser-peer',
    data: browserFrame('resize', 2, { cols: 90, rows: 25 }),
  });
  await settle();
  assert.equal(spawned[0].terminal.writes.at(-1), 'pwd\r');
  assert.deepEqual(spawned[0].terminal.resizes, [[90, 25]]);

  node.emit('message', {
    kind: 'direct',
    local: false,
    fromPeerId: 'browser-peer',
    data: browserFrame('close', 3),
  });
  await settle();
  assert.equal(server.activeSessionCount(), 0);
  assert.equal(spawned[0].terminal.killed, true);
});
