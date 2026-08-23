import assert from 'node:assert/strict';
import { indexFingerprint, startWatcherOffer, validateMeshPairingRequest } from '../src/device-approval-mesh.js';
import { pairingCode } from '../src/pairing-identity.js';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createMeshPairingRequest,
  startDeviceApprovalResponder,
} from '../src/device-approval-mesh.js';

class FakeApprovalNode extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.direct = [];
    this.broadcasts = [];
    this.destroyed = false;
    this.keys = new Map();
    this.mesh = { on: () => {} };
  }

  async start() {}
  broadcast(value) { this.broadcasts.push(value); }
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

// Silence used to count as acceptance, which a closed browser produced too.
const acknowledge = (node, peerId, request) => node.emit('message', {
  local: false,
  fromPeerId: peerId,
  data: { protocol: 'gitpigeon-mesh-pairing/1', kind: 'accepted', requestId: request.requestId },
});

test('a pairing code identifies the watcher and needs no browser', () => {
  assert.match(pairingCode('watcher-key'), /^[0-9]{6}$/);
  assert.equal(pairingCode('watcher-key'), pairingCode('watcher-key'));

  // Two machines must show different digits, or confirming the code says
  // nothing about which machine is being approved.
  assert.notEqual(pairingCode('watcher-one'), pairingCode('watcher-two'));

  // Deriving from the watcher alone is the point: a machine can state its code
  // at install time, before any browser exists to mix a key in.
  assert.throws(() => pairingCode(''), /watcher public key/);
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

  // The browser derives from the key PeerPigeon discovered for this machine,
  // and this machine derives from its own. Same key, same digits — and it does
  // not depend on which browser is asking.
  assert.equal(await responder.codeFor(request.requestId), pairingCode('local-public-key'));
  assert.equal(responder.code(), pairingCode('local-public-key'));
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
  setTimeout(() => acknowledge(node, 'bob-peer', bob), 150);
  const approved = await responder.approve(bob.requestId, capability, {
    confirmMs: 4_000, resendMs: 200,
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

test('a grant is resent until the requester acknowledges it', async (t) => {
  let node;
  const responder = await startDeviceApprovalResponder({
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
  });
  t.after(() => responder.close());

  const request = createMeshPairingRequest({ requestId: 'a'.repeat(32), deviceName: 'Safari' });
  announce(node, 'browser', request);
  await settle();

  // A requester that never acknowledges has not taken the grant. A single
  // fire-and-forget send followed by tearing the node down loses it, which is
  // what left an approved browser stuck on its waiting screen.
  const stubborn = await responder.approve(request.requestId, { index: {} }, {
    confirmMs: 1_200, resendMs: 200,
  });
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

test('the watcher offers itself to browsers that are already paired', async (t) => {
  let node;
  const offer = await startWatcherOffer({
    deviceName: 'Dans-MacBook-Air',
    keyPair: { pub: 'air-public-key', priv: 'p', epub: 'e', epriv: 'ep' },
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
  });
  t.after(() => offer.close());

  // Nothing used to announce. The service only listened for browsers asking to
  // pair, and only an unpaired browser asks — so installing a second machine
  // while a browser was already paired opened no approval prompt at all.
  const announced = node.broadcasts.filter((value) => value?.kind === 'request');
  assert.ok(announced.length, 'the watcher should announce itself');
  assert.equal(announced[0].requesterKind, 'native');
  assert.equal(announced[0].deviceName, 'Dans-MacBook-Air');

  // The digits a browser derives from this machine's key are the ones it
  // printed when it was installed.
  assert.equal(offer.code(), pairingCode('air-public-key'));

  // A pairing request expires, and approvers reject stale ones, so rebroadcast
  // of one fixed object made a machine visible only for its first few minutes.
  const first = announced[0];
  node.broadcasts.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 1));
  node.emit('peerConnected', { peerId: 'browser' });
  const again = node.broadcasts.filter((value) => value?.kind === 'request');
  assert.ok(again.length, 'the watcher should keep announcing');
  assert.notEqual(again[0].issuedAt + again[0].expiresAt, first.issuedAt + first.expiresAt);

  // Restarting must not change what the browser is asked to compare against.
  assert.equal(again[0].requestId, first.requestId);
});

test('a machine announces which index it already belongs to', async (t) => {
  let node;
  const offer = await startWatcherOffer({
    deviceName: 'Daniels-MacBook-Pro',
    indexId: 'f00ab7ea24fe377da70fc7148bfdd047',
    keyPair: { pub: 'pro-public-key', priv: 'p', epub: 'e', epriv: 'ep' },
    nodeFactory: (options) => { node = new FakeApprovalNode(options); return node; },
  });
  t.after(() => offer.close());

  // A browser that already took this machine in was asked to authorise it
  // again every time it announced, which is not an approval anyone can make
  // sense of. It compares this against its own index and stays quiet.
  const [announced] = node.broadcasts.filter((value) => value?.kind === 'request');
  assert.equal(announced.indexFingerprint, indexFingerprint('f00ab7ea24fe377da70fc7148bfdd047'));
  assert.match(announced.indexFingerprint, /^[0-9a-f]{64}$/);

  // The announcement is not encrypted, so the index id itself must not be on
  // it — and neither must anything derived from the secret.
  assert.ok(!JSON.stringify(announced).includes('f00ab7ea24fe377da70fc7148bfdd047'));

  // A machine with no index yet has nothing to claim.
  assert.equal(validateMeshPairingRequest(createMeshPairingRequest({
    requestId: 'a'.repeat(32),
    deviceName: 'New machine',
  })).indexFingerprint, undefined);
});
