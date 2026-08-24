import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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

test('watcher seeds from the file and merges edits without stomping', async (t) => {
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

  // One document per file per revision — the base hash is not part of the
  // identity. Binding it in meant every disk write forked a second live
  // document fighting over the same file.
  const documentId = createHash('sha256').update([
    'gitpigeon-realtime-v2', repositoryId, 'refs/heads/main', 'src/example.js',
  ].join('\0')).digest('hex');
  const base = (kind) => ({
    documentId,
    path: 'src/example.js',
    revision: 'refs/heads/main',
    baseHash: 'c'.repeat(64),
    messageId: randomBytes(16).toString('hex'),
    kind,
    part: 0,
    total: 1,
  });

  // The browser opens the document by asking, not by seeding: the watcher is
  // the seeding authority and answers with the file's content.
  const browser = new Y.Doc();
  node.receive('browser-peer', repositoryId, REALTIME_CHANNEL, {
    ...base('sync-request'),
    payload: Buffer.from(Y.encodeStateVector(browser)).toString('base64'),
  });
  await settle();
  const responses = node.directFrames(REALTIME_CHANNEL).filter((value) => value.kind === 'sync-response');
  assert.equal(responses.length, 1);
  Y.applyUpdate(browser, Buffer.from(responses[0].payload, 'base64'));
  assert.equal(browser.getText('content').toString(), 'original watcher file\n');

  // A browser edit merges into the file instead of replacing it.
  const before = Y.encodeStateAsUpdate(browser);
  browser.getText('content').insert(0, 'edited from the browser\n');
  node.receive('browser-peer', repositoryId, REALTIME_CHANNEL, {
    ...base('update'),
    payload: Buffer.from(Y.encodeStateAsUpdate(browser, Y.encodeStateVectorFromUpdate(before))).toString('base64'),
  });
  await settle();
  assert.equal(await readFile(path.join(root, 'src/example.js'), 'utf8'), 'edited from the browser\noriginal watcher file\n');

  // Applying a browser update must not echo it back to the room: gossip
  // already delivered the broadcast, and the echo raced the next keystroke.
  assert.equal(node.broadcastFrames(REALTIME_CHANNEL).filter((value) => value.kind === 'update').length, 0);

  // The filesystem event for the watcher's own write is recognized and
  // ignored — pumping it back in as a whole-file rewrite was the loop that
  // stomped and duplicated live edits indefinitely.
  await server.filesystemChanged('src/example.js');
  await settle();
  assert.equal(node.broadcastFrames(REALTIME_CHANNEL).filter((value) => value.kind === 'update').length, 0);

  // A genuinely external edit broadcasts as a minimal replacement and reaches
  // the browser document.
  await writeFile(path.join(root, 'src/example.js'), 'edited from the browser\nedited on the watcher\n');
  await server.filesystemChanged('src/example.js');
  await settle();
  const outbound = node.broadcastFrames(REALTIME_CHANNEL).filter((value) => value.kind === 'update');
  assert.ok(outbound.length >= 1);
  for (const update of outbound) Y.applyUpdate(browser, Buffer.from(update.payload, 'base64'));
  assert.equal(browser.getText('content').toString(), 'edited from the browser\nedited on the watcher\n');

  browser.destroy();
});
