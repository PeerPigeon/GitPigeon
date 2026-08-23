import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createMeshPairingRequest,
  pairingCode,
  startDeviceApprovalResponder,
} from '../src/device-approval-mesh.js';

class FakeApprovalNode extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.direct = [];
    this.destroyed = false;
    this.keys = new Map();
    this.mesh = { on: () => {} };
  }

  async start() {}
  broadcast() {}
  getKeyPair() { return { pub: 'local-public-key' }; }
  getPublicKey(peerId) { return this.keys.get(peerId) ?? null; }
  async waitForPeerKey(peerId) {
    const known = this.keys.get(peerId);
    if (!known) throw new Error(`no key for ${peerId}`);
    return known;
  }

  // PeerPigeon encrypts this to the peer's key with unsea; the fake records
  // the plaintext it was asked to send.
  async sendEncryptedDirect(peerId, plaintext) {
    this.direct.push({ peerId, frame: JSON.parse(plaintext) });
    return `direct-${this.direct.length}`;
  }

  async destroy() { this.destroyed = true; }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const announce = (node, peerId, request) => node.emit('message', {
  local: false,
  fromPeerId: peerId,
  data: request,
});

test('a pairing code is derived from the PeerPigeon key the grant is encrypted to', () => {
  assert.match(pairingCode('some-peer-public-key'), /^[0-9]{6}$/);
  assert.equal(pairingCode('some-peer-public-key'), pairingCode('some-peer-public-key'));
  // A different key must not present the same digits, or confirming the code
  // would not tell you where the capability is going.
  assert.notEqual(pairingCode('some-peer-public-key'), pairingCode('another-peer-public-key'));
  assert.throws(() => pairingCode(''), /requires a PeerPigeon public key/);
});

test('both sides show the same code for the same requester', async (t) => {
  let node;
  const responder = await startDeviceApprovalResponder({
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
  });
  t.after(() => responder.close());

  const request = createMeshPairingRequest({ requestId: 'a'.repeat(32), deviceName: 'Safari' });
  node.keys.set('browser', { pub: 'requester-public-key' });
  announce(node, 'browser', request);
  await settle();

  // The requester derives from its own key pair; the approver derives from the
  // key PeerPigeon discovered for that peer. Same key, same digits.
  assert.equal(await responder.codeFor(request.requestId), pairingCode('requester-public-key'));
});

test('the responder lists requests and grants only the chosen one', async (t) => {
  let node;
  const seen = [];
  const responder = await startDeviceApprovalResponder({
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
    onRequest: (request) => seen.push(request.deviceName),
  });
  t.after(() => responder.close());

  const alice = createMeshPairingRequest({ requestId: 'a'.repeat(32), deviceName: 'Alice' });
  const bob = createMeshPairingRequest({ requestId: 'b'.repeat(32), deviceName: 'Bob' });
  announce(node, 'alice-peer', alice);
  announce(node, 'bob-peer', bob);
  await settle();

  assert.deepEqual(seen, ['Alice', 'Bob']);
  assert.deepEqual(responder.pending().map((r) => r.deviceName), ['Alice', 'Bob']);

  const capability = { index: { indexId: 'c'.repeat(32), secret: 'z'.repeat(43) } };
  const approved = await responder.approve(bob.requestId, capability, {
    confirmMs: 2_000, resendMs: 200, quietMs: 300,
  });
  assert.equal(approved.request.deviceName, 'Bob');
  assert.equal(approved.confirmed, true);

  // Only Bob's peer was sent to, and the capability went out as plain JSON for
  // PeerPigeon to encrypt rather than wrapped in a second envelope.
  assert.ok(node.direct.length >= 1);
  assert.ok(node.direct.every(({ peerId }) => peerId === 'bob-peer'));
  assert.deepEqual(node.direct[0].frame.capability, capability);
  assert.equal(node.direct[0].frame.kind, 'grant');
  assert.deepEqual(responder.pending().map((r) => r.deviceName), ['Alice']);
});

test('a grant is resent until the requester stops asking', async (t) => {
  let node;
  const responder = await startDeviceApprovalResponder({
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
  });
  t.after(() => responder.close());

  const request = createMeshPairingRequest({ requestId: 'a'.repeat(32), deviceName: 'Safari' });
  announce(node, 'browser', request);
  await settle();

  // A requester that keeps announcing has not taken the grant. A single
  // fire-and-forget send followed by tearing the node down loses it, which is
  // what left an approved browser stuck on its waiting screen.
  const keepAsking = setInterval(() => announce(node, 'browser', request), 100);
  const stubborn = await responder.approve(request.requestId, { index: {} }, {
    confirmMs: 1_200, resendMs: 200, quietMs: 400,
  });
  clearInterval(keepAsking);
  assert.equal(stubborn.confirmed, false);
  assert.ok(node.direct.length > 1, `expected a resend, sent ${node.direct.length}`);
});

test('an expired or silent request stops being offered', async (t) => {
  let node;
  const responder = await startDeviceApprovalResponder({
    requestStaleMs: 0,
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
  });
  t.after(() => responder.close());

  const request = createMeshPairingRequest({ requestId: 'a'.repeat(32), deviceName: 'Safari' });
  announce(node, 'browser', request);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(responder.pending(), []);
  await assert.rejects(
    () => responder.approve(request.requestId, { index: {} }),
    /no longer being advertised/,
  );
});

test('pair never opens a page of its own', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));
  const command = /async function commandPair\(args, verbose\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(command, 'commandPair should be present');

  // Only an unpaired browser announces itself. Opening a tab from here lands on
  // the same already-paired origin, so it stays just as silent as the page the
  // user already had open — it only ever added noise.
  assert.doesNotMatch(command, /openDashboard/);
  assert.match(command, /already paired will not appear/);

  // Joining the mesh and hearing a gossip announcement takes far longer than a
  // few seconds, so the hint waits for signaling to connect and then for a real
  // window on top of that. Reporting on it sooner said a waiting browser was
  // not there.
  assert.match(command, /connectedAt && Date\.now\(\) - connectedAt >= DISCOVERY_HINT_MS/);
  assert.doesNotMatch(command, /Date\.now\(\) - startedAt/);

  const dashboardCall = command.indexOf('commandPairDashboard');
  const dashboardFlag = command.indexOf("takeFlag(args, '--dashboard')");
  assert.ok(dashboardFlag !== -1 && dashboardCall !== -1 && dashboardFlag < dashboardCall);
});
