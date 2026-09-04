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

test('a browser whose base matches the file byte-for-byte is answered at once, election or not', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-seed-match-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await GitRepository.init(root);
  const repositoryId = 'a'.repeat(64);
  const content = 'shared and identical content\n';
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/example.js'), content);
  const node = new FakeNode();
  // Deliberately DEFERRING: a smaller device is alive, so this watcher would
  // otherwise wait the full seedFallbackMs (set absurdly long here) before
  // it could answer anyone.
  const server = new RealtimeWorkspaceServer({ node, repository, repositoryId, secret: 's', deviceId: 'zzzz-device', seedElectedFallbackMs: 60_000, seedFallbackMs: 60_000, seedRetryMs: 1_000 });
  await server.start();
  t.after(() => server.stop());
  node.receive('peer-a', repositoryId, REALTIME_CHANNEL, { kind: 'presence', deviceId: 'aaaa-device', repositoryId });
  await settle();

  const documentId = createHash('sha256').update([
    'gitpigeon-realtime-v2', repositoryId, 'refs/heads/main', 'src/example.js',
  ].join('\0')).digest('hex');
  const request = (baseHash, doc) => ({
    documentId,
    path: 'src/example.js',
    revision: 'refs/heads/main',
    baseHash,
    messageId: randomBytes(16).toString('hex'),
    kind: 'sync-request',
    part: 0,
    total: 1,
    payload: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
  });

  // Same bytes on both sides: any seed of them is the same Yjs structure, so
  // there is nothing an election could protect. Answer now.
  const browser = new Y.Doc();
  const matching = createHash('sha256').update(content).digest('hex');
  const startedAt = Date.now();
  node.receive('browser', repositoryId, REALTIME_CHANNEL, request(matching, browser));
  await settle();
  const responses = node.directFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'sync-response');
  assert.equal(responses.length, 1);
  assert.ok(Date.now() - startedAt < 1_000);
  // ...and the same answer rides the room by broadcast, for the asker whose
  // direct link is mid-renegotiation.
  assert.equal(node.broadcastFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'sync-response').length, 1);
  Y.applyUpdate(browser, Buffer.from(responses[0].payload, 'base64'));
  assert.equal(browser.getText('content').toString(), content);
  // ...and the seed is byte-for-byte the structure a browser would have
  // built from the same base, so merging the two changes nothing.
  const own = new Y.Doc({ gc: false });
  own.clientID = Number.parseInt(matching.slice(0, 8), 16) || 1;
  own.getText('content').insert(0, content);
  Y.applyUpdate(browser, Y.encodeStateAsUpdate(own));
  assert.equal(browser.getText('content').toString(), content);
  browser.destroy();
  own.destroy();
});

test('a browser whose base differs from the file still waits for the election', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-seed-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await GitRepository.init(root);
  const repositoryId = 'a'.repeat(64);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/example.js'), 'the watcher copy\n');
  const node = new FakeNode();
  const server = new RealtimeWorkspaceServer({ node, repository, repositoryId, secret: 's', deviceId: 'zzzz-device', seedElectedFallbackMs: 60_000, seedFallbackMs: 60_000, seedRetryMs: 1_000 });
  await server.start();
  t.after(() => server.stop());
  node.receive('peer-a', repositoryId, REALTIME_CHANNEL, { kind: 'presence', deviceId: 'aaaa-device', repositoryId });
  await settle();
  const documentId = createHash('sha256').update([
    'gitpigeon-realtime-v2', repositoryId, 'refs/heads/main', 'src/example.js',
  ].join('\0')).digest('hex');
  const browser = new Y.Doc();
  node.receive('browser', repositoryId, REALTIME_CHANNEL, {
    documentId, path: 'src/example.js', revision: 'refs/heads/main', baseHash: 'c'.repeat(64),
    messageId: randomBytes(16).toString('hex'), kind: 'sync-request', part: 0, total: 1,
    payload: Buffer.from(Y.encodeStateVector(browser)).toString('base64'),
  });
  await settleSeed();
  assert.equal(node.directFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'sync-response').length, 0);
  browser.destroy();
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

async function openSeededDocument(t, { name, content, serverOptions = {} }) {
  const root = await mkdtemp(path.join(tmpdir(), `gitpigeon-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await GitRepository.init(root);
  const node = new FakeNode();
  const repositoryId = 'a'.repeat(64);
  const server = new RealtimeWorkspaceServer({ node, repository, repositoryId, secret: 's', deviceId: 'solo', seedElectedFallbackMs: 120, seedFallbackMs: 240, seedRetryMs: 40, ...serverOptions });
  await server.start();
  t.after(() => server.stop());
  await writeFile(path.join(root, 'notes.md'), content);
  const documentId = createHash('sha256').update([
    'gitpigeon-realtime-v2', repositoryId, 'refs/heads/main', 'notes.md',
  ].join('\0')).digest('hex');
  const frame = (kind, payload) => ({
    documentId, path: 'notes.md', revision: 'refs/heads/main', baseHash: 'c'.repeat(64),
    messageId: randomBytes(16).toString('hex'), kind, part: 0, total: 1,
    payload: Buffer.from(payload).toString('base64'),
  });
  const browser = new Y.Doc();
  node.receive('browser', repositoryId, REALTIME_CHANNEL, frame('sync-request', Y.encodeStateVector(browser)));
  await settleSeed();
  const response = node.directFrames(REALTIME_CHANNEL).find((f) => f.kind === 'sync-response');
  Y.applyUpdate(browser, Buffer.from(response.payload, 'base64'));
  assert.equal(browser.getText('content').toString(), content);
  const seen = new Set();
  const applyOutbound = () => {
    for (const update of node.broadcastFrames(REALTIME_CHANNEL).filter((f) => f.kind === 'update')) {
      if (seen.has(update.messageId)) continue;
      seen.add(update.messageId);
      Y.applyUpdate(browser, Buffer.from(update.payload, 'base64'));
    }
    return browser.getText('content').toString();
  };
  const sendUpdate = (mutate) => {
    const before = Y.encodeStateAsUpdate(browser);
    mutate(browser.getText('content'));
    node.receive('browser', repositoryId, REALTIME_CHANNEL, frame('update', Y.encodeStateAsUpdate(browser, Y.encodeStateVectorFromUpdate(before))));
  };
  return { root, server, node, browser, documentId, file: path.join(root, 'notes.md'), applyOutbound, sendUpdate };
}

test('a file deleted from disk is never streamed to other machines as a delete-all edit', async (t) => {
  const { root, server, browser, documentId, file, applyOutbound } = await openSeededDocument(t, { name: 'rm-file', content: 'keep me\n' });
  // rm README.md — or rm -rf of the whole clone — while the watcher runs.
  // Diffing "everything" against "nothing" used to broadcast an edit that
  // deleted every line, and every other machine wrote the empty file.
  await rm(file, { force: true });
  await server.filesystemChanged('notes.md');
  await settle();
  assert.equal(applyOutbound(), 'keep me\n');
  assert.equal(server.documents.has(documentId), false, 'the live document is forgotten, not emptied');

  // The whole clone gone: nothing is propagated either.
  await rm(path.join(root, '.git'), { recursive: true, force: true });
  await server.filesystemChanged('notes.md');
  await settle();
  assert.equal(browser.getText('content').toString(), 'keep me\n');
});

test('a file truncated to zero bytes waits for its content instead of blanking the fleet', async (t) => {
  const { server, file, applyOutbound } = await openSeededDocument(t, { name: 'truncate', content: 'first line\n' });
  // Most editors truncate, then write. The truncation is not an edit.
  await writeFile(file, '');
  await server.filesystemChanged('notes.md');
  await settle();
  assert.equal(applyOutbound(), 'first line\n');
  // The write that follows is.
  await writeFile(file, 'first line\nsecond line\n');
  await server.filesystemChanged('notes.md');
  await settle();
  assert.equal(applyOutbound(), 'first line\nsecond line\n');
});

test('a version written long ago coming back (git checkout) is an edit, not an echo to overwrite', async (t) => {
  const { server, file, applyOutbound, sendUpdate } = await openSeededDocument(t, { name: 'checkout', content: 'v1\n', serverOptions: { echoWindowMs: 60 } });
  sendUpdate((text) => text.insert(text.length, 'v2 typed\n'));
  await settle();
  assert.equal(await readFile(file, 'utf8'), 'v1\nv2 typed\n');
  // Well past the echo window, a person checks v1 out again.
  await new Promise((resolve) => setTimeout(resolve, 120));
  await writeFile(file, 'v1\n');
  await server.filesystemChanged('notes.md');
  await settle();
  assert.equal(await readFile(file, 'utf8'), 'v1\n', 'the checkout stands on disk');
  assert.equal(applyOutbound(), 'v1\n', 'and the live document follows it');
});

test('an empty live document never wins over a file that has content', async (t) => {
  const { server, file, applyOutbound, sendUpdate } = await openSeededDocument(t, { name: 'restore', content: 'original\n' });
  // A live edit emptied the document; the watcher wrote 0 bytes.
  sendUpdate((text) => text.delete(0, text.length));
  await settle();
  assert.equal(await readFile(file, 'utf8'), '');
  // Seconds later the person restores the file. Its hash is in the write
  // history (the seed), which used to make the restore an "echo" that the
  // empty document immediately overwrote — again and again.
  await writeFile(file, 'original\n');
  await server.filesystemChanged('notes.md');
  await settle();
  assert.equal(await readFile(file, 'utf8'), 'original\n');
  assert.equal(applyOutbound(), 'original\n');
});
