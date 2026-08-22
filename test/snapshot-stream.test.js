import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SnapshotStreamServer, snapshotStreamWire } from '../src/snapshot-stream.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for snapshot stream frames');
    await sleep(5);
  }
}

class FakeMesh {
  constructor() {
    this.listeners = new Set();
    this.sent = [];
  }

  on(event, listener) {
    if (event === 'peer:data') this.listeners.add(listener);
  }

  off(event, listener) {
    if (event === 'peer:data') this.listeners.delete(listener);
  }

  send(peerId, data) {
    this.sent.push({ peerId, data });
  }

  receive(peerId, data) {
    for (const listener of this.listeners) listener({ peerId, data });
  }
}

test('answers authenticated watcher metadata before a snapshot exists', async () => {
  const secret = 'snapshot-stream-metadata-secret';
  const service = {
    protocol: 'gitpigeon/1',
    repositoryId: 'repository-id',
    serviceInstanceId: 'a'.repeat(32),
    deviceName: 'test-device',
  };
  const metadata = {
    ...service,
    head: { snapshotId: 'b'.repeat(64) },
    manifest: { liveFiles: [{ content: 'x'.repeat(80_000) }] },
  };
  const mesh = new FakeMesh();
  const server = new SnapshotStreamServer({
    mesh,
    cache: {},
    secret,
    getMetadata: async () => metadata,
  });
  server.start();
  const key = snapshotStreamWire.streamKey(secret);
  const requestId = Buffer.alloc(16, 9);
  mesh.receive('browser-peer', snapshotStreamWire.encodeFrame(
    key,
    snapshotStreamWire.TYPE_METADATA_REQUEST,
    requestId,
    0,
  ));
  await waitFor(() => mesh.sent.length === 1);
  const response = snapshotStreamWire.decodeFrame(key, mesh.sent[0].data);
  assert.equal(response.type, snapshotStreamWire.TYPE_METADATA);
  assert.deepEqual(JSON.parse(response.plaintext.toString('utf8')), service);
  assert.ok(mesh.sent[0].data.length < 65_536, 'watcher discovery must stay below the WebRTC message ceiling');
  server.stop();
});

test('streams encrypted snapshot frames with acknowledgement backpressure', async () => {
  const secret = 'snapshot-stream-test-secret-0123456789';
  const snapshotId = 'a'.repeat(64);
  const bundleSha256 = 'b'.repeat(64);
  const chunks = Array.from({ length: 40 }, (_, index) => Buffer.from(`chunk-${String(index).padStart(2, '0')}`));
  const descriptors = chunks.map((data, index) => ({ sha256: String(index).padStart(64, '0'), size: data.length }));
  const manifest = {
    snapshotId,
    bundleSha256,
    bundleSize: chunks.reduce((total, data) => total + data.length, 0),
    chunks: descriptors,
  };
  const cache = {
    async readManifest(value) { return value === snapshotId ? manifest : null; },
    async readChunk(value) { return chunks[descriptors.findIndex((descriptor) => descriptor.sha256 === value)]; },
  };
  const mesh = new FakeMesh();
  const server = new SnapshotStreamServer({ mesh, cache, secret });
  server.start();

  const key = snapshotStreamWire.streamKey(secret);
  const requestId = Buffer.alloc(16, 7);
  const request = snapshotStreamWire.encodeFrame(
    key,
    snapshotStreamWire.TYPE_REQUEST,
    requestId,
    0,
    Buffer.from(JSON.stringify({ snapshotId, bundleSha256 })),
  );
  mesh.receive('browser-peer', request);
  await waitFor(() => mesh.sent.length === 32);
  assert.equal(mesh.sent.length, 32, 'the sender must stop at its unacknowledged window');

  mesh.receive('browser-peer', snapshotStreamWire.encodeFrame(
    key,
    snapshotStreamWire.TYPE_ACK,
    requestId,
    32,
  ));
  await waitFor(() => mesh.sent.length === 41);
  const decoded = mesh.sent.map(({ data }) => snapshotStreamWire.decodeFrame(key, data));
  assert.deepEqual(decoded.slice(0, 40).map((frame) => frame.type), Array(40).fill(snapshotStreamWire.TYPE_DATA));
  assert.deepEqual(decoded.slice(0, 40).map((frame) => frame.sequence), Array.from({ length: 40 }, (_, index) => index));
  assert.deepEqual(decoded.slice(0, 40).map((frame) => frame.plaintext), chunks);
  assert.equal(decoded[40].type, snapshotStreamWire.TYPE_END);
  assert.equal(decoded[40].sequence, 40);

  server.stop();
  assert.equal(mesh.listeners.size, 0);
});
