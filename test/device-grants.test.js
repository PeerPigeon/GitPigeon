import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
