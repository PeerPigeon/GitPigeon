import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { installNativeWebRTC } from './webrtc.js';
import { productionSignalingServers } from './relay-policy.js';

export const PAIRING_PROTOCOL = 'gitpigeon-pairing/1';
export const PAIRING_NETWORK_ID = 'gitpigeon-pairing-v1';
export const PAIRING_TTL_MS = 2 * 60_000;
const DEVICE = /^[a-zA-Z0-9_-]{8,128}$/;
const PUBLIC_KEY_BYTES = 65;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prefix = (pairingId) => `gitpigeon/pairing/v1/${pairingId}`;
const claimKey = (pairingId) => `${prefix(pairingId)}/claim`;
const responseKey = (pairingId, browserId) => `${prefix(pairingId)}/response/${browserId}`;
const ackKey = (pairingId, browserId) => `${prefix(pairingId)}/ack/${browserId}`;

async function waitForStablePeer(node, deadline, stableMs = 0) {
  let connectedSince = null;
  while (Date.now() < deadline) {
    if (node.getConnectedPeers().length > 0) {
      connectedSince ??= Date.now();
      if (Date.now() - connectedSince >= stableMs) return true;
    } else {
      connectedSince = null;
    }
    await sleep(100);
  }
  return false;
}

function pairingKey(sharedSecret, pairingId) {
  return createHash('sha256')
    .update('gitpigeon-browser-enrollment-v1\0')
    .update(pairingId)
    .update('\0')
    .update(sharedSecret)
    .digest();
}

function associatedData(kind, pairingId, browserId, publicKey) {
  return Buffer.from(`${kind}\0${pairingId}\0${browserId}\0${publicKey}`, 'utf8');
}

function seal(key, value, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

function openSealed(key, envelope, aad) {
  const iv = Buffer.from(String(envelope?.iv ?? ''), 'base64url');
  const combined = Buffer.from(String(envelope?.ciphertext ?? ''), 'base64url');
  if (iv.length !== 12 || combined.length < 17) throw new Error('Invalid encrypted pairing message');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(combined.subarray(combined.length - 16));
  return JSON.parse(Buffer.concat([
    decipher.update(combined.subarray(0, -16)),
    decipher.final(),
  ]).toString('utf8'));
}

export function createDashboardEnrollment(index, baseUrl = 'https://gitpigeon.dev/', {
  automatic = false,
  nativeDevicePublicKey = null,
} = {}) {
  const pairingId = randomBytes(16).toString('hex');
  const pairingSecret = randomBytes(32).toString('base64url');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const ecdh = createECDH('prime256v1');
  const nativePublicKey = ecdh.generateKeys().toString('base64url');
  const url = new URL(baseUrl);
  const enrollmentValue = [
    pairingId,
    pairingSecret,
    nativePublicKey,
    ...(nativeDevicePublicKey ? [automatic ? 'auto' : 'manual', String(nativeDevicePublicKey)] : []),
  ].join('.');
  if (nativeDevicePublicKey) decodePublicDeviceKey(nativeDevicePublicKey);
  url.hash = `enroll=${encodeURIComponent(enrollmentValue)}`;
  return {
    protocol: PAIRING_PROTOCOL,
    pairingId,
    pairingSecret,
    nativePublicKey,
    code,
    displayCode: `${code.slice(0, 3)} ${code.slice(3)}`,
    automatic,
    nativeDevicePublicKey: nativeDevicePublicKey ? String(nativeDevicePublicKey) : null,
    expiresAt: Date.now() + PAIRING_TTL_MS,
    index,
    ecdh,
    url: url.toString(),
  };
}

function decodePublicDeviceKey(value) {
  const bytes = Buffer.from(String(value ?? ''), 'base64url');
  if (bytes.length !== PUBLIC_KEY_BYTES) throw new Error('Invalid native device key for automatic browser enrollment');
  return bytes;
}

export function decryptEnrollmentClaim(enrollment, claim) {
  if (!claim || claim.protocol !== PAIRING_PROTOCOL || claim.pairingId !== enrollment.pairingId) {
    throw new Error('Invalid browser enrollment claim');
  }
  const browserId = String(claim.browserId ?? '');
  const publicKey = String(claim.publicKey ?? '');
  const publicBytes = Buffer.from(publicKey, 'base64url');
  if (!DEVICE.test(browserId) || publicBytes.length !== PUBLIC_KEY_BYTES) {
    throw new Error('Invalid browser enrollment identity');
  }
  const key = pairingKey(enrollment.ecdh.computeSecret(publicBytes), enrollment.pairingId);
  const value = openSealed(
    key,
    claim,
    associatedData('claim', enrollment.pairingId, browserId, publicKey),
  );
  return { browserId, publicKey, key, value };
}

export function encryptEnrollmentGrant(enrollment, accepted) {
  const value = {
    protocol: PAIRING_PROTOCOL,
    indexId: enrollment.index.indexId,
    secret: enrollment.index.secret,
    browserId: accepted.browserId,
    issuedAt: new Date().toISOString(),
  };
  return seal(
    accepted.key,
    value,
    associatedData('grant', enrollment.pairingId, accepted.browserId, accepted.publicKey),
  );
}

export async function serveDashboardEnrollment(enrollment, {
  logger = {},
  timeoutMs = PAIRING_TTL_MS,
  onReady = () => {},
  federationWarmupMs = 2_000,
} = {}) {
  await installNativeWebRTC();
  const { PeerPigeonNode, DEFAULT_SIGNALING_SERVERS } = await import('peerpigeon');
  const storagePrefix = `${prefix(enrollment.pairingId)}/`;
  const node = new PeerPigeonNode({
    crypto: false,
    networkId: PAIRING_NETWORK_ID,
    sessionId: enrollment.pairingId,
    minPeers: 1,
    maxPeers: 4,
    tolerantPeers: 1,
    autoDiscover: true,
    autoConnect: true,
    signalingServers: productionSignalingServers(DEFAULT_SIGNALING_SERVERS),
    storage: {
      userId: `native-${randomBytes(16).toString('hex')}`,
      sessionId: `${PAIRING_NETWORK_ID}:${enrollment.pairingId}`,
      syncSecret: enrollment.pairingSecret,
      dbName: `gitpigeon-pairing-${enrollment.pairingId}`,
      syncFilter: (_space, key) => String(key).startsWith(storagePrefix),
    },
  });
  node.mesh.on('signaling:log', ({ message } = {}) => logger.debug?.(message));
  node.mesh.on('signaling:connected', ({ signalingServer } = {}) => {
    logger.debug?.(`Pairing signaling connected through ${signalingServer ?? 'a federated relay'}`);
  });
  node.mesh.on('signaling:disconnected', () => logger.debug?.('Pairing signaling disconnected; reconnecting'));
  node.on('error', (error) => logger.debug?.(`Pairing mesh: ${error?.message ?? error}`));
  node.on('peerConnected', (peerId) => logger.debug?.(`Pairing peer connected: ${peerId}`));
  node.on('peerDisconnected', (peerId) => logger.debug?.(`Pairing peer disconnected: ${peerId}`));
  const deadline = Math.min(enrollment.expiresAt, Date.now() + timeoutMs);
  let attempts = 0;
  let lastNonce = null;
  try {
    await node.start();
    if (!node.storage) throw new Error('PeerPigeon pairing storage did not initialize');
    node.storage.subscribeKey('public', claimKey(enrollment.pairingId));
    // Enrollment rooms are deliberately short-lived. Give FreeRTC enough time
    // to publish this peer's provider record before the browser joins, then
    // actively refresh discovery for the rest of the two-minute window.
    if (federationWarmupMs > 0) await sleep(Math.min(federationWarmupMs, Math.max(0, deadline - Date.now())));
    await onReady({ node });
    while (Date.now() < deadline && attempts < 5) {
      if (!await waitForStablePeer(node, deadline)) break;
      logger.debug?.('Pairing channel stable; requesting encrypted browser claim');
      const record = await node.storage.retrieve('public', claimKey(enrollment.pairingId), { timeoutMs: 750 });
      const claim = record?.value;
      const nonce = String(claim?.nonce ?? '');
      if (!nonce || nonce === lastNonce) {
        await sleep(150);
        continue;
      }
      lastNonce = nonce;
      attempts += 1;
      logger.debug?.('Encrypted browser claim received');
      let accepted;
      try {
        accepted = decryptEnrollmentClaim(enrollment, claim);
      } catch {
        continue;
      }
      const supplied = Buffer.from(String(accepted.value?.code ?? ''), 'utf8');
      const expected = Buffer.from(enrollment.code, 'utf8');
      if (!enrollment.automatic
        && (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))) {
        await node.storage.put('public', responseKey(enrollment.pairingId, accepted.browserId), {
          protocol: PAIRING_PROTOCOL,
          pairingId: enrollment.pairingId,
          browserId: accepted.browserId,
          nonce,
          status: 'denied',
          attemptsRemaining: Math.max(0, 5 - attempts),
        });
        continue;
      }
      const grant = encryptEnrollmentGrant(enrollment, accepted);
      const responseNonce = randomBytes(16).toString('hex');
      const response = {
        protocol: PAIRING_PROTOCOL,
        pairingId: enrollment.pairingId,
        browserId: accepted.browserId,
        nonce: responseNonce,
        status: 'granted',
        publicKey: accepted.publicKey,
        ...grant,
      };
      node.storage.subscribeKey('public', ackKey(enrollment.pairingId, accepted.browserId));
      await node.storage.put('public', responseKey(enrollment.pairingId, accepted.browserId), response);
      const ackDeadline = Math.min(deadline, Date.now() + 15_000);
      while (Date.now() < ackDeadline) {
        if (!await waitForStablePeer(node, ackDeadline)) break;
        const ack = await node.storage.retrieve('public', ackKey(enrollment.pairingId, accepted.browserId), { timeoutMs: 500 });
        if (ack?.value?.protocol === PAIRING_PROTOCOL
          && ack.value.browserId === accepted.browserId
          && ack.value.nonce === responseNonce) return { browserId: accepted.browserId };
        await sleep(100);
      }
      throw new Error('The browser did not acknowledge the encrypted enrollment grant');
    }
    if (attempts >= 5) throw new Error('Pairing was locked after five incorrect attempts');
    throw new Error('Pairing expired before the browser was approved');
  } finally {
    await node.destroy().catch(() => {});
  }
}
