import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
  // The session must not impersonate the terminal app the service was
  // launched from — Apple Terminal's session-restore hijacked history.
  assert.equal(spawned[0].options.env.TERM_PROGRAM, undefined);
  assert.equal(spawned[0].options.env.TERM_SESSION_ID, undefined);
  assert.match(spawned[0].options.env.GITPIGEON_DEVICE_ROSTER, /^[A-Za-z0-9_-]+$/);
  assert.equal(node.directFrames(TERMINAL_CHANNEL)[0]?.kind, 'opened');
  // Setup travels through startup files and spawn arguments — the shell
  // never receives it as typed input, so nothing is echoed and nothing
  // lands in the shell's own command history.
  assert.equal(spawned[0].terminal.writes.length, 0);
  const zdot = spawned[0].options.env.ZDOTDIR;
  assert.ok(zdot, 'zsh sessions get a ZDOTDIR wrapper');
  const rc = await readFile(path.join(zdot, '.zshrc'), 'utf8');
  // machine [directory/*] gitpigeon $ — same shape on every device.
  assert.match(rc, /test-device.*\[\.\.\/%1~\/\*\].*\$/);
  assert.match(rc, /gitpigeon-ready/);

  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('input', 1, {
    payload: Buffer.from('pwd\r').toString('base64'),
  }));
  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('resize', 2, { cols: 90, rows: 25 }));
  await settle();
  assert.deepEqual(spawned[0].terminal.writes, ['pwd\r']);
  assert.deepEqual(spawned[0].terminal.resizes, [[90, 25]]);

  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('close', 3));
  await settle();
  assert.equal(server.activeSessionCount(), 0);
  assert.equal(spawned[0].terminal.killed, true);
});

test('nothing before the ready marker reaches the browser or the history', async (t) => {
  const node = new FakeNode();
  const spawned = [];
  const server = new TerminalServer({
    node,
    repository: { root: '/tmp/example-repository' },
    secret,
    repositoryId,
    serviceInstanceId,
    deviceName: 'test-device',
    spawnPty() {
      const terminal = new FakePty();
      spawned.push(terminal);
      return terminal;
    },
  });
  server.start();
  t.after(() => server.stop());

  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('open', 0, {
    cols: 80,
    rows: 24,
    devices: [{ name: 'test-device' }],
  }));
  await settle();
  const [terminal] = spawned;
  const emit = (data) => { for (const listener of terminal.dataListeners) listener(data); };

  // Shell startup noise and the echoed setup line — including the marker's
  // SOURCE TEXT, which is backslash escapes, not the raw bytes.
  emit('Last login: never\r\n');
  emit("$ device() { ... }; clear; printf '\\033]777;gitpigeon-ready\\a'\r\n");
  await settle();
  assert.equal(node.directFrames(TERMINAL_CHANNEL).filter((f) => f.kind === 'output').length, 0);

  // The raw marker arrives split across chunks; only what follows it flows.
  emit('\u001b[2J\u001b[3J\u001b[H\u001b]777;gitpigeon-re');
  emit('ady\u0007prompt $ ');
  emit('typed');
  await settle();
  const output = node.directFrames(TERMINAL_CHANNEL)
    .filter((f) => f.kind === 'output')
    .map((f) => Buffer.from(f.payload, 'base64').toString('utf8'))
    .join('');
  assert.equal(output, 'prompt $ typed');
});

test('history capture frames are stripped from output and merged; the seed rides the env', async (t) => {
  const node = new FakeNode();
  const spawned = [];
  const added = [];
  const server = new TerminalServer({
    node,
    repository: { root: '/tmp/example-repository' },
    secret,
    repositoryId,
    serviceInstanceId,
    deviceName: 'test-device',
    history: {
      lines: () => ['git status', 'npm test'],
      add: (line) => added.push(line),
    },
    spawnPty(shell, args, options) {
      const terminal = new FakePty();
      spawned.push({ options, terminal });
      return terminal;
    },
  });
  server.start();
  t.after(() => server.stop());

  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('open', 0, {
    cols: 80, rows: 24, devices: [{ name: 'test-device' }],
  }));
  await settle();
  const [{ options, terminal }] = spawned;
  // The fleet-wide history seeds the shell in-memory list via the spawn env.
  assert.equal(options.env.GITPIGEON_HISTORY, 'git status\nnpm test');
  const emit = (data) => { for (const listener of terminal.dataListeners) listener(data); };

  const frame = (line) => `\u001b]777;gitpigeon-hist;${Buffer.from(line).toString('base64')}\u0007`;
  emit('\u001b]777;gitpigeon-ready\u0007prompt $ ');
  // A whole frame in one chunk, and one split across three chunks.
  emit(`before ${frame('ls -la')}after `);
  const split = frame('echo hi');
  emit(split.slice(0, 9));
  emit(split.slice(9, 20));
  emit(`${split.slice(20)}tail`);
  await settle();

  assert.deepEqual(added, ['ls -la', 'echo hi']);
  const output = node.directFrames(TERMINAL_CHANNEL)
    .filter((f) => f.kind === 'output')
    .map((f) => Buffer.from(f.payload, 'base64').toString('utf8'))
    .join('');
  assert.equal(output, 'prompt $ before after tail');
});
