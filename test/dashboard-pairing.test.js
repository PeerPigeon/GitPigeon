import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  randomBytes,
} from 'node:crypto';
import test from 'node:test';
import {
  PAIRING_PROTOCOL,
  createDashboardEnrollment,
  decryptEnrollmentClaim,
  encryptEnrollmentGrant,
} from '../src/dashboard-pairing.js';

function key(shared, pairingId) {
  return createHash('sha256')
    .update('gitpigeon-browser-enrollment-v1\0')
    .update(pairingId)
    .update('\0')
    .update(shared)
    .digest();
}

function aad(kind, enrollment, browserId, publicKey) {
  return Buffer.from(`${kind}\0${enrollment.pairingId}\0${browserId}\0${publicKey}`);
}

function seal(secret, value, additionalData) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value))),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

function open(secret, envelope, additionalData) {
  const combined = Buffer.from(envelope.ciphertext, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAAD(additionalData);
  decipher.setAuthTag(combined.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]));
}

test('enrolls a browser without exposing the permanent machine secret in the URL', () => {
  const index = {
    indexId: 'a'.repeat(32),
    secret: 'permanent-secret-that-must-never-enter-the-url',
  };
  const enrollment = createDashboardEnrollment(index);
  assert.match(enrollment.url, /^https:\/\/gitpigeon\.dev\/#enroll=[a-f0-9]{32}\.[a-zA-Z0-9_-]{32,}\.[a-zA-Z0-9_-]+$/);
  assert.equal(enrollment.url.includes(index.indexId), false);
  assert.equal(enrollment.url.includes(index.secret), false);
  assert.match(enrollment.displayCode, /^\d{3} \d{3}$/);

  const browser = createECDH('prime256v1');
  const publicKey = browser.generateKeys().toString('base64url');
  const browserId = 'browser-0123456789abcdef';
  const sharedKey = key(browser.computeSecret(Buffer.from(enrollment.nativePublicKey, 'base64url')), enrollment.pairingId);
  const claim = {
    protocol: PAIRING_PROTOCOL,
    pairingId: enrollment.pairingId,
    browserId,
    publicKey,
    nonce: randomBytes(16).toString('hex'),
    ...seal(sharedKey, { code: enrollment.code }, aad('claim', enrollment, browserId, publicKey)),
  };
  const accepted = decryptEnrollmentClaim(enrollment, claim);
  assert.equal(accepted.value.code, enrollment.code);
  const grant = encryptEnrollmentGrant(enrollment, accepted);
  const plaintext = open(sharedKey, grant, aad('grant', enrollment, browserId, publicKey));
  assert.equal(plaintext.indexId, index.indexId);
  assert.equal(plaintext.secret, index.secret);
  assert.equal(plaintext.browserId, browserId);
});

test('automatic enrollment carries only the persistent native public key and needs no code', () => {
  const nativeDevice = createECDH('prime256v1');
  const nativeDevicePublicKey = nativeDevice.generateKeys().toString('base64url');
  const index = { indexId: 'b'.repeat(32), secret: 'index-secret-that-stays-inside-the-encrypted-grant' };
  const enrollment = createDashboardEnrollment(index, 'https://gitpigeon.dev/', {
    automatic: true,
    nativeDevicePublicKey,
  });
  assert.equal(enrollment.automatic, true);
  assert.equal(enrollment.nativeDevicePublicKey, nativeDevicePublicKey);
  assert.match(enrollment.url, /\.auto\./);
  assert.equal(enrollment.url.includes(index.indexId), false);
  assert.equal(enrollment.url.includes(index.secret), false);
});
