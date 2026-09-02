import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { TERMINAL_CHANNEL, deviceTerminalRoom } from '../src/channel.js';
import { TerminalServer, changeDirectoryLine } from '../src/terminal-server.js';
import { FakeNode } from './fake-node.js';

const repositoryId = 'repository-terminal';
const serviceInstanceId = 'a'.repeat(32);
const secret = 'terminal-test-secret';
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

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
    repositories: [{ repositoryId, root: '/tmp/example-repository' }],
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
    repositories: [{ repositoryId, root: '/tmp/example-repository' }],
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
    repositories: [{ repositoryId, root: '/tmp/example-repository' }],
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
    repositories: [{ repositoryId, root: '/tmp/example-repository' }],
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
  // The shell shares live from GitPigeon's spool — a local projection of
  // the mesh record — never from the user's own history file.
  assert.ok(String(options.env.HISTFILE ?? process.env.HISTFILE ?? '') !== String(process.env.HISTFILE ?? 'unset-sentinel'));
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

test('one shell per machine: the device room and every repository channel reach the same session', async (t) => {
  const node = new FakeNode();
  const spawned = [];
  const repositoryA = await mkdtemp(path.join(tmpdir(), 'gitpigeon-terminal-a-'));
  const repositoryB = await mkdtemp(path.join(tmpdir(), 'gitpigeon-terminal-b-'));
  const server = new TerminalServer({
    node,
    serviceInstanceId,
    deviceName: 'test-device',
    repositories: [{ repositoryId: 'repo-a', root: repositoryA }],
    spawnPty(shell, args, options) {
      const terminal = new FakePty();
      spawned.push({ options, terminal });
      return terminal;
    },
  });
  server.start();
  t.after(() => server.stop());
  // Repositories come and go while the server runs.
  const lease = server.addRepository({ repositoryId: 'repo-b', root: repositoryB });

  // The dashboard opens on the DEVICE room, naming the repository it is
  // looking at only as the working directory; the same open also travels
  // the repository channel for older watchers, and must not open twice.
  const open = browserFrame('open', 0, { cols: 80, rows: 24, devices: [{ name: 'test-device' }], workingRepositoryId: 'repo-b' });
  node.receive('browser-peer', deviceTerminalRoom(serviceInstanceId), TERMINAL_CHANNEL, open);
  node.receive('browser-peer', 'repo-b', TERMINAL_CHANNEL, open);
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(server.activeSessionCount(), 1);
  assert.equal(spawned[0].options.cwd, repositoryB);
  // Replies take the road the session arrived on.
  const opened = node.direct.filter(({ frame }) => frame.kind === 'opened');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].frame.repositoryId, deviceTerminalRoom(serviceInstanceId));

  // Switching repositories moves the SAME shell — no new pty — with a
  // history-invisible cd (leading space), and input keeps flowing.
  node.receive('browser-peer', deviceTerminalRoom(serviceInstanceId), TERMINAL_CHANNEL, browserFrame('cwd', 1, { workingRepositoryId: 'repo-a' }));
  node.receive('browser-peer', deviceTerminalRoom(serviceInstanceId), TERMINAL_CHANNEL, browserFrame('input', 2, {
    payload: Buffer.from('pwd\r').toString('base64'),
  }));
  await settle();
  assert.equal(spawned.length, 1);
  // The cd is phrased for whichever shell this platform spawned (cmd on a
  // Windows runner); what is invariant is its place in the stream and the
  // leading space that keeps it out of history.
  const [cdLine, ...rest] = spawned[0].terminal.writes;
  assert.ok(cdLine.startsWith(' ') && cdLine.includes(repositoryA) && cdLine.endsWith('\r'), cdLine);
  assert.deepEqual(rest, ['pwd\r']);
  assert.equal(changeDirectoryLine('zsh', repositoryA), ` cd '${repositoryA}'\r`);
  assert.equal(changeDirectoryLine('powershell', "C:\\it's"), " Set-Location -LiteralPath 'C:\\it''s'\r");
  assert.equal(changeDirectoryLine('cmd', 'C:\\repo'), ' cd /d "C:\\repo"\r');

  // A repository this machine no longer serves is not a directory to cd to.
  lease.release();
  node.receive('browser-peer', deviceTerminalRoom(serviceInstanceId), TERMINAL_CHANNEL, browserFrame('cwd', 3, { workingRepositoryId: 'repo-b' }));
  await settle();
  assert.equal(spawned[0].terminal.writes.length, 2);
  // ...and its channel is no longer answered.
  node.receive('other-peer', 'repo-b', TERMINAL_CHANNEL, { ...browserFrame('open', 0, { cols: 80, rows: 24, devices: [{ name: 'x' }] }), sessionId: 'c'.repeat(32) });
  await settle();
  assert.equal(spawned.length, 1);
});

test('a repository channel open without a named directory starts in that repository', async (t) => {
  const node = new FakeNode();
  const spawned = [];
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-terminal-'));
  const server = new TerminalServer({
    node,
    serviceInstanceId,
    deviceName: 'test-device',
    repositories: [{ repositoryId, root }],
    spawnPty(shell, args, options) {
      const terminal = new FakePty();
      spawned.push({ options, terminal });
      return terminal;
    },
  });
  server.start();
  t.after(() => server.stop());
  node.receive('browser-peer', repositoryId, TERMINAL_CHANNEL, browserFrame('open', 0, { cols: 80, rows: 24, devices: [{ name: 'test-device' }] }));
  await settle();
  assert.equal(spawned[0]?.options.cwd, root);
  const opened = node.direct.find(({ frame }) => frame.kind === 'opened')?.frame;
  assert.equal(opened?.repositoryId, repositoryId);
  // ...and it points the browser at the machine's own room for the rest.
  assert.equal(opened?.deviceRoom, deviceTerminalRoom(serviceInstanceId));
});

test('relayed frames reach the machine terminal whether or not they name a repository', async (t) => {
  const node = new FakeNode();
  const spawned = [];
  const replies = [];
  const server = new TerminalServer({
    node,
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
  server.receiveRelayed(
    { replyEpub: 'browser-epub', frame: browserFrame('open', 0, { cols: 80, rows: 24, devices: [{ name: 'test-device' }] }) },
    { reply: async (value) => { replies.push(value); } },
  );
  await settle();
  assert.equal(spawned.length, 1);
  assert.equal(replies[0]?.frame.kind, 'opened');
  assert.equal(replies[0]?.frame.repositoryId, deviceTerminalRoom(serviceInstanceId));
});
