import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEVICE_APPROVAL_NETWORK_ID,
  DEVICE_APPROVAL_SESSION_ID,
  createMeshPairingRequest,
  MESH_PAIRING_PROTOCOL,
  startDeviceApprovalRequester,
} from '../src/device-approval-mesh.js';
import {
  DEVICE_GRANT_PROTOCOL,
  createDeviceEnrollmentRequest,
  loadOrCreateNativeDeviceIdentity,
  openDeviceGrant,
  parseNativeCloneUrl,
  sealDeviceGrant,
  validateDeviceEnrollmentRequest,
  validateNativeClonePayload,
} from '../src/device-grants.js';

class FakeApprovalNode {
  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    this.broadcasts = [];
    this.destroyed = false;
    this.keyPair = { pub: 'fake-pub', epub: 'fake-epub', priv: 'p', epriv: 'ep' };
    // The node facade exposes the raw mesh for signaling diagnostics.
    this.mesh = { on: () => {} };
  }

  getKeyPair() { return this.keyPair; }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  async start() {}

  broadcast(value) {
    this.broadcasts.push(value);
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  async destroy() {
    this.destroyed = true;
  }
}

test('encrypts device enrollment so only the requested native identity can open it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-device-grant-'));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-other-device-'));
  try {
    const identity = await loadOrCreateNativeDeviceIdentity({ root });
    const other = await loadOrCreateNativeDeviceIdentity({ root: otherRoot });
    const request = createDeviceEnrollmentRequest(identity, { port: 41_717 });
    assert.deepEqual(validateDeviceEnrollmentRequest(request), request);
    const envelope = sealDeviceGrant(identity.publicKey, request.requestId, {
      index: { indexId: 'a'.repeat(32), secret: 's'.repeat(43) },
    });
    assert.equal(envelope.protocol, DEVICE_GRANT_PROTOCOL);
    assert.equal(JSON.stringify(envelope).includes('s'.repeat(43)), false);
    const opened = openDeviceGrant(identity, envelope);
    assert.equal(opened.index.indexId, 'a'.repeat(32));
    assert.throws(() => openDeviceGrant(other, envelope), /another device/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test('native clone URLs contain ciphertext and decrypt into a validated repository capability', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-clone-grant-'));
  try {
    const identity = await loadOrCreateNativeDeviceIdentity({ root });
    const requestId = 'b'.repeat(32);
    const repositoryId = 'repository-1234';
    const secret = 'k'.repeat(43);
    const envelope = sealDeviceGrant(identity.publicKey, requestId, {
      repositoryId,
      secret,
      name: 'Example repository',
    }, { purpose: 'clone' });
    const url = new URL(`gitpigeon://clone/${requestId}`);
    url.searchParams.set('recipient', envelope.recipientPublicKey);
    url.searchParams.set('key', envelope.publicKey);
    url.searchParams.set('iv', envelope.iv);
    url.hash = envelope.ciphertext;
    assert.equal(url.toString().includes(repositoryId), false);
    assert.equal(url.toString().includes(secret), false);
    const opened = openDeviceGrant(identity, parseNativeCloneUrl(url), { purpose: 'clone' });
    assert.deepEqual(validateNativeClonePayload(opened), { repositoryId, secret, name: 'Example repository' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a mesh pairing grant arrives through PeerPigeon encryption, not a second envelope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitpigeon-mesh-approval-'));
  try {
    const request = createMeshPairingRequest({ requestId: 'a'.repeat(32), deviceName: 'New device' });
    let fake;
    let resolveGrant;
    const received = new Promise((resolve) => { resolveGrant = resolve; });
    const session = await startDeviceApprovalRequester(request, {
      nodeFactory: (options) => {
        fake = new FakeApprovalNode(options);
        return fake;
      },
      onGrant: (capability) => resolveGrant(capability),
    });
    assert.equal(fake.options.networkId, DEVICE_APPROVAL_NETWORK_ID);
    assert.equal(fake.options.sessionId, DEVICE_APPROVAL_SESSION_ID);
    // sendEncryptedDirect throws on a node without crypto.
    assert.notEqual(fake.options.crypto, false);
    // The announcement now carries the requester's unsea encryption key, so
    // approvals can be sealed to it and broadcast — delivery must not depend
    // on a direct channel that may never form.
    assert.deepEqual(fake.broadcasts, [{ ...request, epub: fake.getKeyPair().epub }]);

    // But never a hand-rolled key of its own: unsea's key is the only one.
    assert.equal(request.publicKey, undefined);
    fake.emit('message', {
      local: false,
      encrypted: true,
      fromPeerId: 'browser-peer',
      data: JSON.stringify({
        protocol: MESH_PAIRING_PROTOCOL,
        kind: 'grant',
        requestId: request.requestId,
        capability: { index: { indexId: 'c'.repeat(32), secret: 'z'.repeat(43) } },
      }),
    });
    assert.equal((await received).index.indexId, 'c'.repeat(32));
    await session.close();
    assert.equal(fake.destroyed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
