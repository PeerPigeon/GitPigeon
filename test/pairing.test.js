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
  const approved = await responder.approve(bobRequest.requestId, capability, {
    confirmMs: 2_000,
    resendMs: 200,
    quietMs: 300,
  });
  assert.equal(approved.request.deviceName, 'Bob');
  // Bob stopped announcing after the grant, which is how acceptance is known.
  assert.equal(approved.confirmed, true);

  // Only Bob was granted, and only Bob's key can open it.
  assert.ok(node.direct.length >= 1);
  assert.ok(node.direct.every(({ peerId }) => peerId === 'bob-peer'));
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

test('pair opens a page only when no browser is already waiting', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));

  // Running `pair` while a browser sits on the approval screen must not throw
  // another tab on top of it; the waiting browser is the reason it was run.
  const command = /async function commandPair\(args, verbose\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(command, 'commandPair should be present');
  assert.match(command, /if \(!pending\.length && !openedDashboard/);
  assert.doesNotMatch(command, /openDashboard\([^)]*\);\s*\n\s*console\.log\('Waiting/);

  // The dashboard-URL enrollment flow, which always opened a tab and printed a
  // different six-digit code, is no longer what plain `pair` runs.
  const dashboardCall = command.indexOf('commandPairDashboard');
  const dashboardFlag = command.indexOf("takeFlag(args, '--dashboard')");
  assert.ok(dashboardFlag !== -1 && dashboardCall !== -1 && dashboardFlag < dashboardCall);
});

test('a grant is resent until the requester stops asking', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-pair-confirm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = await loadOrCreateNativeDeviceIdentity({ root });
  const request = createDeviceEnrollmentRequest(identity, { port: 41_717, deviceName: 'Safari' });

  let node;
  const responder = await startDeviceApprovalResponder({
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
  });
  t.after(() => responder.close());
  node.emit('message', { local: false, fromPeerId: 'browser', data: request });
  await settle();

  // A requester that keeps announcing has not taken the grant. A single
  // fire-and-forget send followed by tearing the node down loses it, which is
  // exactly what left an approved browser stuck on its waiting screen.
  const keepAsking = setInterval(() => {
    node.emit('message', { local: false, fromPeerId: 'browser', data: request });
  }, 100);
  const stubborn = await responder.approve(request.requestId, { index: {} }, {
    confirmMs: 1_200,
    resendMs: 200,
    quietMs: 400,
  });
  clearInterval(keepAsking);
  assert.equal(stubborn.confirmed, false, 'a requester still asking must not read as confirmed');
  assert.ok(node.direct.length > 1, `the grant should have been resent, sent ${node.direct.length} time(s)`);
});
