import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startDeviceApprovalResponder } from '../src/device-approval-mesh.js';
import {
  createDeviceEnrollmentRequest,
  loadOrCreateNativeDeviceIdentity,
  openDeviceGrant,
  pairingCode,
} from '../src/device-grants.js';

class FakeApprovalNode extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.direct = [];
    this.destroyed = false;
    this.mesh = { on: () => {} };
  }
  async start() {}
  broadcast() {}
  sendDirect(peerId, data) {
    this.direct.push({ peerId, data });
    return `direct-${this.direct.length}`;
  }
  async destroy() { this.destroyed = true; }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a pairing code is stable, request-specific, and needs no extra transport', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-pair-code-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await loadOrCreateNativeDeviceIdentity({ root });
  const request = createDeviceEnrollmentRequest(identity, { port: 41_717 });

  assert.match(pairingCode(request), /^[0-9]{6}$/);
  assert.equal(pairingCode(request), pairingCode({ ...request }));
  // Both halves of the pairing derive it from the request alone, so a different
  // request can never present the same code by accident.
  assert.notEqual(pairingCode(request), pairingCode({ ...request, requestId: 'f'.repeat(32) }));
  assert.notEqual(pairingCode(request), pairingCode({ ...request, publicKey: `${request.publicKey}x` }));
});

test('the watcher host lists pending requests and grants only the chosen one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-pair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alice = await loadOrCreateNativeDeviceIdentity({ root: path.join(root, 'alice') });
  const bob = await loadOrCreateNativeDeviceIdentity({ root: path.join(root, 'bob') });
  const aliceRequest = createDeviceEnrollmentRequest(alice, { port: 41_717, deviceName: 'Alice' });
  const bobRequest = createDeviceEnrollmentRequest(bob, { port: 41_718, deviceName: 'Bob' });

  let node;
  const seen = [];
  const responder = await startDeviceApprovalResponder({
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
    onRequest: (request) => seen.push(request.deviceName),
  });
  t.after(() => responder.close());

  node.emit('message', { local: false, fromPeerId: 'alice-peer', data: aliceRequest });
  node.emit('message', { local: false, fromPeerId: 'bob-peer', data: bobRequest });
  await settle();

  assert.deepEqual(seen, ['Alice', 'Bob']);
  const pending = responder.pending();
  assert.deepEqual(pending.map((request) => request.deviceName), ['Alice', 'Bob']);

  const capability = {
    index: { indexId: 'c'.repeat(32), secret: 'z'.repeat(43), publisherId: 'd'.repeat(32) },
    nativeDevicePublicKey: null,
    repositories: [],
  };
  const approved = await responder.approve(bobRequest.requestId, capability);
  assert.equal(approved.deviceName, 'Bob');

  // Only Bob was granted, and only Bob's key can open it.
  assert.equal(node.direct.length, 1);
  assert.equal(node.direct[0].peerId, 'bob-peer');
  assert.equal(openDeviceGrant(bob, node.direct[0].data).index.indexId, 'c'.repeat(32));
  assert.throws(() => openDeviceGrant(alice, node.direct[0].data));

  // An approved request stops being offered, and Alice is still waiting.
  assert.deepEqual(responder.pending().map((request) => request.deviceName), ['Alice']);
});

test('an expired or silent request stops being offered for approval', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-pair-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await loadOrCreateNativeDeviceIdentity({ root });
  const request = createDeviceEnrollmentRequest(identity, { port: 41_717 });

  let node;
  const responder = await startDeviceApprovalResponder({
    requestStaleMs: 0,
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
  });
  t.after(() => responder.close());

  node.emit('message', { local: false, fromPeerId: 'peer', data: request });
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(responder.pending(), []);
  await assert.rejects(
    () => responder.approve(request.requestId, { index: {} }),
    /no longer being advertised/,
  );
});
