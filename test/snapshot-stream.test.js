import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SNAPSHOT_CHANNEL } from '../src/channel.js';
import { SnapshotStreamServer } from '../src/snapshot-stream.js';
import { FakeNode } from './fake-node.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const repositoryId = 'repository-id';

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for snapshot frames');
    await sleep(5);
  }
}

test('answers watcher metadata before a snapshot exists', async () => {
  const service = {
    protocol: 'gitpigeon/1',
    repositoryId,
    serviceInstanceId: 'a'.repeat(32),
    deviceName: 'test-device',
  };
  const node = new FakeNode();
  const server = new SnapshotStreamServer({
    node,
    repositoryId,
    cache: {},
    // Discovery must not carry the snapshot manifest; only the service fields
    // survive, which is what keeps the frame small.
    getMetadata: async () => ({
      ...service,
      head: { snapshotId: 'b'.repeat(64) },
      manifest: { liveFiles: [{ content: 'x'.repeat(80_000) }] },
    }),
  });
  server.start();

  node.receive('browser-peer', repositoryId, SNAPSHOT_CHANNEL, { kind: 'metadata-request', requestId: 'r1' });
  await waitFor(() => node.direct.length === 1);

  const [reply] = node.directFrames(SNAPSHOT_CHANNEL);
  assert.equal(reply.kind, 'metadata');
  assert.equal(reply.requestId, 'r1');
  assert.deepEqual(reply.metadata, service);
  assert.ok(JSON.stringify(reply).length < 65_536, 'watcher discovery must stay small');
  server.stop();
});

test('serves requested snapshot chunks and refuses digests the snapshot does not reference', async () => {
  const snapshotId = 'a'.repeat(64);
  const chunks = Array.from({ length: 3 }, (_value, index) => Buffer.from(`chunk-${index}`));
  const descriptors = chunks.map((data) => ({
    sha256: createHash('sha256').update(data).digest('hex'),
    size: data.length,
  }));
  const foreign = createHash('sha256').update('unreferenced').digest('hex');
  const manifest = { snapshotId, bundleSha256: 'b'.repeat(64), chunks: descriptors };
  const cache = {
    async readManifest(value) { return value === snapshotId ? manifest : null; },
    async readChunk(value) {
      const index = descriptors.findIndex((descriptor) => descriptor.sha256 === value);
      if (index === -1) throw new Error(`unknown chunk ${value}`);
      return chunks[index];
    },
  };
  const node = new FakeNode();
  const server = new SnapshotStreamServer({ node, repositoryId, cache });
  server.start();

  node.receive('browser-peer', repositoryId, SNAPSHOT_CHANNEL, {
    kind: 'chunk-request',
    requestId: 'r2',
    snapshotId,
    digests: [...descriptors.map((descriptor) => descriptor.sha256), foreign],
  });
  await waitFor(() => node.direct.length === 3);
  await sleep(20);

  const replies = node.directFrames(SNAPSHOT_CHANNEL);
  assert.equal(replies.length, 3, 'the unreferenced digest must not be served');
  assert.deepEqual(replies.map((frame) => frame.kind), ['chunk', 'chunk', 'chunk']);
  assert.deepEqual(
    replies.map((frame) => Buffer.from(frame.data, 'base64').toString('utf8')),
    ['chunk-0', 'chunk-1', 'chunk-2'],
  );
  assert.deepEqual(replies.map((frame) => frame.sha256), descriptors.map((descriptor) => descriptor.sha256));
  server.stop();
});

test('reports an unavailable snapshot instead of staying silent', async () => {
  const node = new FakeNode();
  const server = new SnapshotStreamServer({
    node,
    repositoryId,
    cache: { async readManifest() { return null; } },
  });
  server.start();

  node.receive('browser-peer', repositoryId, SNAPSHOT_CHANNEL, {
    kind: 'chunk-request',
    requestId: 'r3',
    snapshotId: 'c'.repeat(64),
    digests: ['d'.repeat(64)],
  });
  await waitFor(() => node.direct.length === 1);

  const [reply] = node.directFrames(SNAPSHOT_CHANNEL);
  assert.equal(reply.kind, 'error');
  assert.match(reply.message, /not available/);
  server.stop();
});

test('ignores frames addressed to another repository', async () => {
  const node = new FakeNode();
  const server = new SnapshotStreamServer({
    node,
    repositoryId,
    cache: {},
    getMetadata: async () => ({ protocol: 'gitpigeon/1', repositoryId }),
  });
  server.start();

  node.receive('browser-peer', 'another-repository', SNAPSHOT_CHANNEL, { kind: 'metadata-request', requestId: 'r4' });
  await sleep(50);
  assert.equal(node.direct.length, 0);
  server.stop();
});
