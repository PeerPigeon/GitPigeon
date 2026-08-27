import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CONTROL_CHANNEL } from '../src/channel.js';
import { ControlServer } from '../src/control-server.js';
import {
  listMachinePigeons,
  loadMachineIndex,
  registerMachinePigeon,
} from '../src/machine-index.js';
import { FakeNode } from './fake-node.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const indexId = 'a'.repeat(32);

async function seed(root, name, repositoryId) {
  const repository = { root: path.join(root, name), gitDir: path.join(root, name, '.git') };
  await registerMachinePigeon(repository, {
    repositoryId,
    secret: 's'.repeat(43),
    deviceId: 'device-aaaaaaaa',
  }, { root, pid: null });
  return repository;
}

test('a paired peer can remove one repository and the rest stay', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seed(root, 'alpha', 'repo-alpha-0001');
  await seed(root, 'beta', 'repo-beta-00001');

  const node = new FakeNode();
  let reconciled = 0;
  const server = new ControlServer({
    node,
    indexId,
    root,
    onChanged: async () => { reconciled += 1; },
  });
  server.start();
  t.after(() => server.stop());

  node.receive('browser', indexId, CONTROL_CHANNEL, {
    kind: 'remove-repository',
    requestId: 'r1',
    targetRepositoryId: 'repo-alpha-0001',
  }, 'direct');
  await settle();

  const [reply] = node.directFrames(CONTROL_CHANNEL);
  assert.equal(reply.ok, true);
  assert.equal(reply.removed, true);
  assert.equal(reconciled, 1, 'the watcher should reload its sessions');
  const remaining = await listMachinePigeons({ root, activeOnly: false });
  assert.deepEqual(remaining.map((entry) => entry.repositoryId), ['repo-beta-00001']);
});

test('rotating the index secret is what actually revokes access', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-control-rotate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await loadMachineIndex({ root });

  const node = new FakeNode();
  const server = new ControlServer({ node, indexId, root });
  server.start();
  t.after(() => server.stop());

  node.receive('browser', indexId, CONTROL_CHANNEL, { kind: 'rotate-index', requestId: 'r2' }, 'direct');
  await settle();

  const [reply] = node.directFrames(CONTROL_CHANNEL);
  assert.equal(reply.ok, true);
  const after = await loadMachineIndex({ root });
  // The index keeps its identity; only the capability changes, so every peer
  // holding the old secret loses access.
  assert.equal(after.indexId, before.indexId);
  assert.notEqual(after.secret, before.secret);
  assert.equal(after.pairingComplete, false);
});

test('rotating asks the watcher to restart, because its node holds the old secret', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-control-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const node = new FakeNode();
  let rotatedSignals = 0;
  const server = new ControlServer({ node, indexId, root, onRotated: () => { rotatedSignals += 1; } });
  server.start();
  t.after(() => server.stop());

  node.receive('browser', indexId, CONTROL_CHANNEL, { kind: 'rotate-index', requestId: 'r6' }, 'direct');
  await settle();

  // The reply goes out first; a mesh session built on the previous secret
  // cannot reach anything paired with the new one, so it must not keep running.
  assert.equal(node.directFrames(CONTROL_CHANNEL)[0].ok, true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(rotatedSignals, 1);
});

test('an unknown repository or command is refused, not silently ignored', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-control-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const node = new FakeNode();
  const server = new ControlServer({ node, indexId, root });
  server.start();
  t.after(() => server.stop());

  node.receive('browser', indexId, CONTROL_CHANNEL, {
    kind: 'remove-repository', requestId: 'r3', targetRepositoryId: 'repo-missing-01',
  }, 'direct');
  node.receive('browser', indexId, CONTROL_CHANNEL, { kind: 'detonate', requestId: 'r4' }, 'direct');
  await settle();

  // Replies are independent async operations, so match on requestId.
  const replies = new Map(node.directFrames(CONTROL_CHANNEL).map((frame) => [frame.requestId, frame]));
  assert.equal(replies.size, 2);
  assert.equal(replies.get('r3').ok, false);
  assert.match(replies.get('r3').message, /not registered/);
  assert.equal(replies.get('r4').ok, false);
  assert.match(replies.get('r4').message, /Unsupported control command/);
});

test('a control frame for another index is ignored', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-control-other-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const node = new FakeNode();
  const server = new ControlServer({ node, indexId, root });
  server.start();
  t.after(() => server.stop());

  node.receive('browser', 'b'.repeat(32), CONTROL_CHANNEL, { kind: 'rotate-index', requestId: 'r5' }, 'direct');
  await settle();
  assert.equal(node.direct.length, 0);
});

test('a paired browser commits the working tree through the watcher', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { writeFile } = await import('node:fs/promises');
  const run = promisify(execFile);
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-control-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repoDir = path.join(root, 'workrepo');
  await run('git', ['init', '-q', repoDir]);
  await writeFile(path.join(repoDir, 'edited.txt'), 'edited from a browser\n');
  await registerMachinePigeon({ root: repoDir, gitDir: path.join(repoDir, '.git') }, {
    repositoryId: 'repo-commit-001',
    secret: 's'.repeat(43),
    deviceId: 'device-aaaaaaaa',
  }, { root, pid: null });

  const node = new FakeNode();
  const server = new ControlServer({ node, indexId, root });
  server.start();
  t.after(() => server.stop());

  node.receive('browser', indexId, CONTROL_CHANNEL, {
    kind: 'commit-repository',
    requestId: 'c1',
    targetRepositoryId: 'repo-commit-001',
    message: 'browser commit',
  }, 'direct');
  // Committing shells out to git twice; give it a real moment.
  for (let waited = 0; waited < 100 && !node.directFrames(CONTROL_CHANNEL).length; waited += 1) await settle();

  const [reply] = node.directFrames(CONTROL_CHANNEL);
  assert.equal(reply.ok, true, reply.message);
  assert.match(reply.commit, /^[0-9a-f]{7,12}$/);
  const log = await run('git', ['-C', repoDir, 'log', '--oneline']);
  assert.match(log.stdout, /browser commit/);

  // A clean tree reports 'nothing to commit' instead of an empty commit.
  node.receive('browser', indexId, CONTROL_CHANNEL, {
    kind: 'commit-repository',
    requestId: 'c2',
    targetRepositoryId: 'repo-commit-001',
    message: 'again',
  }, 'direct');
  for (let waited = 0; waited < 100 && node.directFrames(CONTROL_CHANNEL).length < 2; waited += 1) await settle();
  const second = node.directFrames(CONTROL_CHANNEL)[1];
  assert.equal(second.ok, false);
  assert.match(second.message, /Nothing to commit/);
});
