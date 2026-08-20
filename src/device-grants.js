import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  randomBytes,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { machineIndexRoot } from './machine-index.js';

export const DEVICE_GRANT_PROTOCOL = 'gitpigeon-device-grant/1';
export const DEVICE_REQUEST_PROTOCOL = 'gitpigeon-device-request/1';
export const DEVICE_REQUEST_TTL_MS = 5 * 60_000;
export const LAN_MULTICAST_ADDRESS = '239.255.71.71';
export const LAN_MULTICAST_PORT = 47171;
export const NATIVE_DEVICE_FILE = 'native-device.json';

const REQUEST_ID = /^[a-f0-9]{32}$/;
const PUBLIC_KEY_BYTES = 65;
const REPOSITORY_ID = /^[a-zA-Z0-9_-]{8,128}$/;
const SECRET = /^[a-zA-Z0-9_-]{32,256}$/;

function decodePublicKey(value) {
  const bytes = Buffer.from(String(value ?? ''), 'base64url');
  if (bytes.length !== PUBLIC_KEY_BYTES) throw new Error('Invalid GitPigeon native device public key');
  return bytes;
}

function grantKey(sharedSecret, requestId, purpose) {
  return createHash('sha256')
    .update('gitpigeon-native-device-grant-v1\0')
    .update(purpose)
    .update('\0')
    .update(requestId)
    .update('\0')
    .update(sharedSecret)
    .digest();
}

function grantAad(envelope) {
  return Buffer.from([
    DEVICE_GRANT_PROTOCOL,
    envelope.purpose,
    envelope.requestId,
    envelope.recipientPublicKey,
    envelope.publicKey,
  ].join('\0'));
}

function validateGrantPayload(value, requestId, purpose) {
  if (!value || typeof value !== 'object' || value.protocol !== DEVICE_GRANT_PROTOCOL) {
    throw new Error('Invalid GitPigeon device grant');
  }
  if (value.requestId !== requestId || value.purpose !== purpose) {
    throw new Error('The GitPigeon device grant does not match this request');
  }
  const issuedAt = Date.parse(String(value.issuedAt ?? ''));
  const expiresAt = Date.parse(String(value.expiresAt ?? ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt || Date.now() > expiresAt || issuedAt - Date.now() > 60_000) {
    throw new Error('The GitPigeon device grant has expired');
  }
  return value;
}

export function nativeDevicePath(root = machineIndexRoot()) {
  return path.join(root, NATIVE_DEVICE_FILE);
}

export async function loadOrCreateNativeDeviceIdentity({ root = machineIndexRoot() } = {}) {
  const filename = nativeDevicePath(root);
  try {
    const value = JSON.parse(await readFile(filename, 'utf8'));
    const privateKey = String(value.privateKey ?? '');
    const publicKey = String(value.publicKey ?? '');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (ecdh.getPublicKey().toString('base64url') !== publicKey) throw new Error('Native device key mismatch');
    return { privateKey, publicKey };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Invalid GitPigeon native device identity: ${error.message}`);
  }
  const ecdh = createECDH('prime256v1');
  const publicKey = ecdh.generateKeys().toString('base64url');
  const value = {
    version: 1,
    privateKey: ecdh.getPrivateKey().toString('base64url'),
    publicKey,
    createdAt: new Date().toISOString(),
  };
  const temporary = `${filename}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
  return { privateKey: value.privateKey, publicKey };
}

export function createDeviceEnrollmentRequest(identity, {
  port,
  deviceName = os.hostname(),
  platform = process.platform,
  arch = process.arch,
  now = Date.now(),
} = {}) {
  decodePublicKey(identity?.publicKey);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid LAN enrollment port');
  return {
    protocol: DEVICE_REQUEST_PROTOCOL,
    kind: 'request',
    requestId: randomBytes(16).toString('hex'),
    publicKey: identity.publicKey,
    deviceName: String(deviceName || 'New device').trim().slice(0, 120),
    platform: String(platform).slice(0, 32),
    arch: String(arch).slice(0, 32),
    port,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DEVICE_REQUEST_TTL_MS).toISOString(),
  };
}

export function validateDeviceEnrollmentRequest(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || value.protocol !== DEVICE_REQUEST_PROTOCOL || value.kind !== 'request') return null;
  const requestId = String(value.requestId ?? '');
  const publicKey = String(value.publicKey ?? '');
  const port = Number(value.port);
  const issuedAt = Date.parse(String(value.issuedAt ?? ''));
  const expiresAt = Date.parse(String(value.expiresAt ?? ''));
  if (!REQUEST_ID.test(requestId) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt || expiresAt - issuedAt > DEVICE_REQUEST_TTL_MS + 1_000
    || now > expiresAt || issuedAt - now > 60_000) return null;
  try { decodePublicKey(publicKey); } catch { return null; }
  return {
    protocol: DEVICE_REQUEST_PROTOCOL,
    kind: 'request',
    requestId,
    publicKey,
    deviceName: String(value.deviceName || 'New device').trim().slice(0, 120),
    platform: String(value.platform || 'unknown').slice(0, 32),
    arch: String(value.arch || 'unknown').slice(0, 32),
    port,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function sealDeviceGrant(recipientPublicKey, requestId, value, { purpose = 'enrollment' } = {}) {
  if (!REQUEST_ID.test(String(requestId))) throw new Error('Invalid GitPigeon device request ID');
  const recipientBytes = decodePublicKey(recipientPublicKey);
  const ephemeral = createECDH('prime256v1');
  const publicKey = ephemeral.generateKeys().toString('base64url');
  const envelope = {
    protocol: DEVICE_GRANT_PROTOCOL,
    purpose,
    requestId,
    recipientPublicKey,
    publicKey,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    grantKey(ephemeral.computeSecret(recipientBytes), requestId, purpose),
    iv,
  );
  cipher.setAAD(grantAad(envelope));
  const plaintext = {
    protocol: DEVICE_GRANT_PROTOCOL,
    purpose,
    requestId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DEVICE_REQUEST_TTL_MS).toISOString(),
    ...value,
  };
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintext), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    ...envelope,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export function openDeviceGrant(identity, envelope, { purpose = 'enrollment' } = {}) {
  if (!envelope || envelope.protocol !== DEVICE_GRANT_PROTOCOL || envelope.purpose !== purpose) {
    throw new Error('Invalid GitPigeon encrypted device grant');
  }
  const requestId = String(envelope.requestId ?? '');
  if (!REQUEST_ID.test(requestId) || envelope.recipientPublicKey !== identity.publicKey) {
    throw new Error('The GitPigeon device grant was encrypted for another device');
  }
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(identity.privateKey, 'base64url'));
  const combined = Buffer.from(String(envelope.ciphertext ?? ''), 'base64url');
  const iv = Buffer.from(String(envelope.iv ?? ''), 'base64url');
  if (iv.length !== 12 || combined.length < 17) throw new Error('Invalid GitPigeon encrypted device grant');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    grantKey(ecdh.computeSecret(decodePublicKey(envelope.publicKey)), requestId, purpose),
    iv,
  );
  decipher.setAAD(grantAad(envelope));
  decipher.setAuthTag(combined.subarray(-16));
  const value = JSON.parse(Buffer.concat([
    decipher.update(combined.subarray(0, -16)),
    decipher.final(),
  ]).toString('utf8'));
  return validateGrantPayload(value, requestId, purpose);
}

export function deviceRequestsKey(indexId, bucket) {
  return `gitpigeon/index/v1/${indexId}/device-requests/${bucket}`;
}

export function deviceApprovalKey(indexId, requestId) {
  if (!REQUEST_ID.test(String(requestId))) throw new Error('Invalid GitPigeon device request ID');
  return `gitpigeon/index/v1/${indexId}/device-approval/${requestId}`;
}

export function parseNativeCloneUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Invalid GitPigeon native clone URL'); }
  if (url.protocol !== 'gitpigeon:' || url.hostname !== 'clone') {
    throw new Error('Native clone requests must use gitpigeon://clone');
  }
  const requestId = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const envelope = {
    protocol: DEVICE_GRANT_PROTOCOL,
    purpose: 'clone',
    requestId,
    recipientPublicKey: url.searchParams.get('recipient') ?? '',
    publicKey: url.searchParams.get('key') ?? '',
    iv: url.searchParams.get('iv') ?? '',
    ciphertext: decodeURIComponent(url.hash.replace(/^#/, '')),
  };
  if (!REQUEST_ID.test(requestId)) throw new Error('Invalid GitPigeon native clone request ID');
  return envelope;
}

export function validateNativeClonePayload(value) {
  const repositoryId = String(value.repositoryId ?? '');
  const secret = String(value.secret ?? '');
  const signalingServer = value.signalingServer ? String(value.signalingServer) : undefined;
  if (!REPOSITORY_ID.test(repositoryId) || !SECRET.test(secret)) throw new Error('Invalid repository capability in native clone grant');
  if (signalingServer && !/^wss?:\/\//i.test(signalingServer)) throw new Error('Invalid signaling server in native clone grant');
  return {
    repositoryId,
    secret,
    name: String(value.name || `pigeon-${repositoryId.slice(0, 10)}`).trim().slice(0, 120),
    ...(signalingServer ? { signalingServer } : {}),
  };
}
