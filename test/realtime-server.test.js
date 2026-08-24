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
const settleSeed = () => new Promise((resolve) => setTimeout(resolve, 260));

test('watcher seeds from the file and merges edits without stomping', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-realtime-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await GitRepository.init(root);
  const node = new FakeNode();
  const repositoryId = 'a'.repeat(64);
  const secret = 'realtime-workspace-secret';
  const server = new RealtimeWorkspaceServer({ node, repository, repositoryId, secret, seedElectedFallbackMs: 120, seedFallbackMs: 240, seedRetryMs: 40 });
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
  await settleSeed();
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

  // While the realtime session is live, the document is the file's only
  // writer: the live-workspace overlay must not apply its copy of the path.
  assert.equal(server.ownsPath('src/example.js'), true);
  assert.equal(server.ownsPath('src/other.js'), false);

  browser.destroy();
});

test('only the smallest live device seeds; the other adopts, never unions', async (t) => {
  const rootA = await mkdtemp(path.join(tmpdir(), 'gitpigeon-seed-a-'));
  const rootB = await mkdtemp(path.join(tmpdir(), 'gitpigeon-seed-b-'));
  t.after(() => Promise.all([
    rm(rootA, { recursive: true, force: true }),
    rm(rootB, { recursive: true, force: true }),
  ]));
  const repoA = await GitRepository.init(rootA);
  const repoB = await GitRepository.init(rootB);
  const repositoryId = 'a'.repeat(64);
  // The overlay lags between machines, so at seed time the two copies of the
  // same file routinely differ. Both watchers seeding unioned the versions —
  // the indefinitely-duplicating loop.
  await mkdir(path.join(rootA, 'src'), { recursive: true });
  await mkdir(path.join(rootB, 'src'), { recursive: true });
  await writeFile(path.join(rootA, 'src/example.js'), 'authoritative content\n');
  await writeFile(path.join(rootB, 'src/example.js'), 'stale lagging copy\n');

  const nodeA = new FakeNode();
  const nodeB = new FakeNode();
  const serverA = new RealtimeWorkspaceServer({ node: nodeA, repository: repoA, repositoryId, secret: 's', deviceId: 'aaaa-device', seedElectedFallbackMs: 120, seedFallbackMs: 600, seedRetryMs: 40 });
  const serverB = new RealtimeWorkspaceServer({ node: nodeB, repository: repoB, repositoryId, secret: 's', deviceId: 'bbbb-device', seedElectedFallbackMs: 120, seedFallbackMs: 600, seedRetryMs: 40 });
  await serverA.start();
  await serverB.start();
  t.after(() => { serverA.stop(); serverB.stop(); });

  // Presence crosses between them, so B knows a smaller device is alive.
  const bridgePresence = () => {
    for (const value of nodeA.broadcastFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'presence')) {
      nodeB.receive('peer-a', repositoryId, REALTIME_CHANNEL, value);
    }
    for (const value of nodeB.broadcastFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'presence')) {
      nodeA.receive('peer-b', repositoryId, REALTIME_CHANNEL, value);
    }
  };
  bridgePresence();
  await settle();

  const documentId = createHash('sha256').update([
    'gitpigeon-realtime-v2', repositoryId, 'refs/heads/main', 'src/example.js',
  ].join('\0')).digest('hex');
  const open = (kindNode, doc) => ({
    documentId,
    path: 'src/example.js',
    revision: 'refs/heads/main',
    baseHash: 'c'.repeat(64),
    messageId: randomBytes(16).toString('hex'),
    kind: 'sync-request',
    part: 0,
    total: 1,
    payload: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
  });
  const browser = new Y.Doc();
  nodeA.receive('browser', repositoryId, REALTIME_CHANNEL, open(nodeA, browser));
  nodeB.receive('browser', repositoryId, REALTIME_CHANNEL, open(nodeB, browser));
  await settleSeed();

  // A (smallest id) answered with its seed; B answered nothing.
  const fromA = nodeA.directFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'sync-response');
  const fromB = nodeB.directFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'sync-response');
  assert.equal(fromA.length, 1);
  assert.equal(fromB.length, 0);
  Y.applyUpdate(browser, Buffer.from(fromA[0].payload, 'base64'));
  assert.equal(browser.getText('content').toString(), 'authoritative content\n');

  // B's own sync-request reaches A; the response seeds B with A's content —
  // adopted, not unioned with its stale copy.
  for (const value of nodeB.broadcastFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'sync-request')) {
    nodeA.receive('peer-b', repositoryId, REALTIME_CHANNEL, value);
  }
  await settle();
  for (const { peerId, frame } of nodeA.direct.filter((entry) => entry.peerId === 'peer-b' && entry.frame.channel === REALTIME_CHANNEL)) {
    void peerId;
    nodeB.receive('peer-a', repositoryId, REALTIME_CHANNEL, frame);
  }
  await settle();
  assert.equal(await readFile(path.join(rootB, 'src/example.js'), 'utf8'), 'authoritative content\n');
});

test('an external file edit never deletes concurrent typing', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-fsdiff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await GitRepository.init(root);
  const node = new FakeNode();
  const repositoryId = 'a'.repeat(64);
  const server = new RealtimeWorkspaceServer({ node, repository, repositoryId, secret: 's', deviceId: 'solo', seedElectedFallbackMs: 120, seedFallbackMs: 240, seedRetryMs: 40 });
  await server.start();
  t.after(() => server.stop());
  await writeFile(path.join(root, 'notes.md'), 'shared base\n');

  const documentId = createHash('sha256').update([
    'gitpigeon-realtime-v2', repositoryId, 'refs/heads/main', 'notes.md',
  ].join('\0')).digest('hex');
  const browser = new Y.Doc();
  node.receive('browser', repositoryId, REALTIME_CHANNEL, {
    documentId, path: 'notes.md', revision: 'refs/heads/main', baseHash: 'c'.repeat(64),
    messageId: randomBytes(16).toString('hex'), kind: 'sync-request', part: 0, total: 1,
    payload: Buffer.from(Y.encodeStateVector(browser)).toString('base64'),
  });
  await settleSeed();
  const response = node.directFrames(REALTIME_CHANNEL).find((f) => f.kind === 'sync-response');
  Y.applyUpdate(browser, Buffer.from(response.payload, 'base64'));

  // The person types; the update reaches the watcher and the file follows.
  const before = Y.encodeStateAsUpdate(browser);
  browser.getText('content').insert(browser.getText('content').length, 'typed while busy');
  node.receive('browser', repositoryId, REALTIME_CHANNEL, {
    documentId, path: 'notes.md', revision: 'refs/heads/main', baseHash: 'c'.repeat(64),
    messageId: randomBytes(16).toString('hex'), kind: 'update', part: 0, total: 1,
    payload: Buffer.from(Y.encodeStateAsUpdate(browser, Y.encodeStateVectorFromUpdate(before))).toString('base64'),
  });
  await settle();

  // A stale ECHO lands: the file bounces back to an older version this
  // watcher itself wrote (an overlay straggler). Treating echoes as edits
  // deleted whatever had been typed since — live, keystroke by keystroke.
  await writeFile(path.join(root, 'notes.md'), 'shared base\n');
  await server.filesystemChanged('notes.md');
  await settle();
  let outbound = node.broadcastFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'update');
  for (const update of outbound) Y.applyUpdate(browser, Buffer.from(update.payload, 'base64'));
  let text = browser.getText('content').toString();
  assert.ok(text.includes('typed while busy'), `typing survived the echo: ${JSON.stringify(text)}`);
  // And the echo was corrected on disk, not adopted.
  assert.ok((await readFile(path.join(root, 'notes.md'), 'utf8')).includes('typed while busy'));

  // A genuinely NOVEL external edit merges: it changes only the span its
  // author touched, diffed file-against-file, never against the live doc.
  const written = await readFile(path.join(root, 'notes.md'), 'utf8');
  await writeFile(path.join(root, 'notes.md'), `${written}external line\n`);
  await server.filesystemChanged('notes.md');
  await settle();
  outbound = node.broadcastFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'update');
  for (const update of outbound) Y.applyUpdate(browser, Buffer.from(update.payload, 'base64'));
  text = browser.getText('content').toString();
  assert.ok(text.includes('typed while busy'), `typing survived the edit: ${JSON.stringify(text)}`);
  assert.ok(text.includes('external line'), `external edit landed: ${JSON.stringify(text)}`);
});
