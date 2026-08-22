import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as Y from 'yjs';
import { REALTIME_CHANNEL } from '../src/channel.js';
import { GitRepository } from '../src/git.js';
import { RealtimeWorkspaceServer } from '../src/realtime-server.js';
import { FakeNode } from './fake-node.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

test('watcher joins realtime browser documents and writes the real repository file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-realtime-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await GitRepository.init(root);
  const node = new FakeNode();
  const repositoryId = 'a'.repeat(64);
  const secret = 'realtime-workspace-secret';
  const server = new RealtimeWorkspaceServer({ node, repository, repositoryId, secret });
  await server.start();
  t.after(() => server.stop());
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/example.js'), 'original watcher file\n');

  const browser = new Y.Doc();
  browser.getText('content').insert(0, 'edited from the browser\n');
  const documentId = createHash('sha256').update([
    'gitpigeon-realtime-v1', repositoryId, 'refs/heads/main', 'src/example.js', 'c'.repeat(64),
  ].join('\0')).digest('hex');
  const frame = {
    documentId,
    path: 'src/example.js',
    revision: 'refs/heads/main',
    baseHash: 'c'.repeat(64),
    messageId: 'd'.repeat(32),
    kind: 'update',
    part: 0,
    total: 1,
    payload: Buffer.from(Y.encodeStateAsUpdate(browser)).toString('base64'),
  };
  node.receive('browser-peer', repositoryId, REALTIME_CHANNEL, frame);
  await settle();

  assert.equal(await readFile(path.join(root, 'src/example.js'), 'utf8'), 'original watcher file\n');
  assert.equal(node.directFrames(REALTIME_CHANNEL).some((value) => value.kind === 'sync-request'), true);

  node.receive('browser-peer', repositoryId, REALTIME_CHANNEL, {
    ...frame,
    messageId: 'e'.repeat(32),
    kind: 'sync-response',
  });
  await settle();

  assert.equal(await readFile(path.join(root, 'src/example.js'), 'utf8'), 'edited from the browser\n');
  assert.equal(node.direct.some(({ peerId }) => peerId === 'browser-peer'), true);

  await writeFile(path.join(root, 'src/example.js'), 'edited on the watcher\n');
  await server.filesystemChanged('src/example.js');
  await settle();
  const outbound = node.broadcastFrames(REALTIME_CHANNEL).filter((value) => value.kind === 'update');
  assert.equal(outbound.length >= 2, true);
  for (const update of outbound) Y.applyUpdate(browser, Buffer.from(update.payload, 'base64'));
  assert.equal(browser.getText('content').toString(), 'edited on the watcher\n');

  browser.destroy();
});
