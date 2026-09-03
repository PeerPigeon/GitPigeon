import { createHash, randomBytes } from 'node:crypto';
import { validateRepositoryId, validateSecret } from './invite.js';

/**
 * Public repository sharing.
 *
 * A share is a second, read-tier room for a repository. The share key in the
 * URL admits anyone holding the link: they can read the repository, mirror
 * it (their node replicates the records, so the repository stays available
 * when the owner is offline), and submit proposals. Authority never comes
 * from room membership: the URL carries the owner's public key as the trust
 * anchor, the owner signs a roster of approved signer keys, and only heads
 * signed by a rostered key are accepted by mirrors. A mirror can carry the
 * repository; it cannot forge it.
 *
 * All crypto is unsea (sign/verify) and PeerPigeon room crypto — GitPigeon
 * adds only the record shapes and trust rules.
 */

export const SHARE_NETWORK_ID = 'gitpigeon-share-v1';
export const SHARE_ROSTER_CONTEXT = 'gitpigeon-share-roster/1';
export const SHARE_HEAD_CONTEXT = 'gitpigeon-share-head/1';
export const SHARE_PROPOSAL_CONTEXT = 'gitpigeon-share-proposal/1';
export const SHARE_CHUNK_BYTES = 192 * 1024;
const WEB_SHARE_PATH = /^\/r\/([a-zA-Z0-9_-]{8,128})\/?$/;

export function createShareKey() {
  return randomBytes(32).toString('base64url');
}

export function shareRoomId(repositoryId) {
  return `gitpigeon:share:${validateRepositoryId(repositoryId)}`;
}

export function shareStoragePrefix(repositoryId) {
  return `gitpigeon/share/v1/${validateRepositoryId(repositoryId)}/`;
}

export function shareRosterKey(repositoryId) {
  return `${shareStoragePrefix(repositoryId)}roster`;
}

export function shareHeadKey(repositoryId) {
  return `${shareStoragePrefix(repositoryId)}head`;
}

export function shareBundleChunkKey(repositoryId, bundleSha256, index) {
  return `${shareStoragePrefix(repositoryId)}bundle/${bundleSha256}/${index}`;
}

export function shareBlobChunkKey(repositoryId, blobSha256, index) {
  return `${shareStoragePrefix(repositoryId)}blob/${blobSha256}/${index}`;
}

export function shareProposalKey(repositoryId, proposalId) {
  return `${shareStoragePrefix(repositoryId)}proposal/${proposalId}`;
}

export function shareProposalChunkKey(repositoryId, proposalId, index) {
  return `${shareStoragePrefix(repositoryId)}proposal-chunk/${proposalId}/${index}`;
}

function validPublicKey(value) {
  const key = String(value ?? '').trim();
  if (key.length < 16 || key.length > 512 || /[\s#&]/.test(key)) {
    throw new Error('Invalid share owner public key');
  }
  return key;
}

/**
 * The web form is what gets pasted anywhere public; the native form is what
 * `git pigeon init` accepts directly. Both carry the share key and the
 * owner's public key in the FRAGMENT, which browsers never send to any
 * server — the page host cannot read the repository, only the link holder.
 */
export function createShareUrl({ repositoryId, shareKey, ownerPublicKey, signalingServer, mirror, name, origin = 'https://gitpigeon.dev' }) {
  const id = validateRepositoryId(repositoryId);
  const fragment = new URLSearchParams();
  fragment.set('s', validateSecret(shareKey));
  fragment.set('o', validPublicKey(ownerPublicKey));
  if (signalingServer) fragment.set('signal', String(signalingServer));
  // The always-on mirror rides the link: readers that find no mesh peer
  // fetch room-ciphertext records from this base URL and decrypt them with
  // the share key they already hold.
  if (mirror) fragment.set('m', validateMirrorUrl(mirror));
  // The repository's name rides the link (in the fragment, never sent to a
  // server) so a visitor or adopting watcher shows the repository's own name
  // rather than the folder a clone lands in.
  const trimmedName = typeof name === 'string' ? name.trim().slice(0, 200) : '';
  if (trimmedName) fragment.set('n', trimmedName);
  const url = new URL(`${origin.replace(/\/$/, '')}/r/${encodeURIComponent(id)}`);
  url.hash = fragment.toString();
  return url.toString();
}

export function parseShareUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('Invalid GitPigeon share URL');
  }
  let repositoryId;
  if (url.protocol === 'gitpigeon:' && url.hostname === 'share') {
    repositoryId = validateRepositoryId(decodeURIComponent(url.pathname.replace(/^\//, '')));
  } else if (/^https?:$/.test(url.protocol)) {
    const match = WEB_SHARE_PATH.exec(url.pathname);
    if (!match) throw new Error('Share URL path must be /r/<repository>');
    repositoryId = validateRepositoryId(decodeURIComponent(match[1]));
  } else {
    throw new Error('Share URL must be https or gitpigeon://share');
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const shareKey = validateSecret(fragment.get('s') ?? '');
  const ownerPublicKey = validPublicKey(fragment.get('o') ?? '');
  const signalingServer = fragment.get('signal') || undefined;
  if (signalingServer && !/^wss?:\/\//i.test(signalingServer)) {
    throw new Error('Share signaling server must use ws:// or wss://');
  }
  const mirror = fragment.get('m') ? validateMirrorUrl(fragment.get('m')) : undefined;
  const name = (fragment.get('n') || '').trim().slice(0, 200) || undefined;
  return { repositoryId, shareKey, ownerPublicKey, signalingServer, mirror, ...(name ? { name } : {}) };
}

export function validateMirrorUrl(value) {
  // A Nostr base is not a URL: nostr:<pubkey>?relays=<wss…,wss…>
  if (/^nostr:[0-9a-f]{64}\?relays=.+$/.test(String(value))) return String(value);
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('Mirror URL must be a valid URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Mirror URL must use https');
  }
  if (url.search || url.hash) throw new Error('Mirror URL must not carry a query or fragment');
  return url.toString().replace(/\/$/, '');
}

function sortedDeep(value) {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedDeep(value[key])]));
  }
  return value;
}

function canonical(context, value) {
  return `${context}\0${JSON.stringify(sortedDeep(value))}`;
}

/**
 * The roster names every key allowed to publish authoritative heads. It is
 * signed by the owner key from the URL; a mirror trusts nothing that does
 * not chain back to that anchor. Version is monotonic so a replaced roster
 * cannot be rolled back by replaying an old record.
 */
export async function signRoster({ repositoryId, signers, version, ownerKeyPair }) {
  const { signMessage } = await import('unsea');
  const record = {
    repositoryId: validateRepositoryId(repositoryId),
    signers: [...new Set(signers.map(validPublicKey))].sort(),
    version: Number(version),
    updatedAt: new Date().toISOString(),
  };
  if (!Number.isSafeInteger(record.version) || record.version < 1) throw new Error('Invalid roster version');
  if (!record.signers.includes(validPublicKey(ownerKeyPair.pub))) {
    record.signers = [...record.signers, ownerKeyPair.pub].sort();
  }
  return {
    ...record,
    signature: await signMessage(canonical(SHARE_ROSTER_CONTEXT, record), ownerKeyPair.priv),
  };
}

export async function verifyRoster(record, ownerPublicKey) {
  if (!record || typeof record !== 'object') return null;
  const { signature, ...rest } = record;
  const value = {
    repositoryId: String(rest.repositoryId ?? ''),
    signers: Array.isArray(rest.signers) ? rest.signers.map(String) : [],
    version: Number(rest.version),
    updatedAt: String(rest.updatedAt ?? ''),
  };
  if (!Number.isSafeInteger(value.version) || value.version < 1 || !value.signers.length) return null;
  try {
    const { verifyMessage } = await import('unsea');
    const valid = await verifyMessage(canonical(SHARE_ROSTER_CONTEXT, value), String(signature ?? ''), validPublicKey(ownerPublicKey));
    return valid ? value : null;
  } catch {
    return null;
  }
}

/**
 * A head names the current authoritative state: the refs and the git bundle
 * (chunk-addressed) that carries them. Signed by a rostered device;
 * sequence is monotonic so mirrors reject rollbacks.
 */
export async function signHead({ repositoryId, refs, bundleSha256, bundleBytes, chunkCount, sequence, keyPair, files = [], name = '' }) {
  const { signMessage } = await import('unsea');
  const record = {
    repositoryId: validateRepositoryId(repositoryId),
    name: String(name).trim().slice(0, 200),
    refs: Object.fromEntries(Object.entries(refs ?? {}).map(([name, oid]) => [String(name), String(oid)]).sort(([a], [b]) => a.localeCompare(b))),
    bundleSha256: String(bundleSha256),
    bundleBytes: Number(bundleBytes),
    chunkCount: Number(chunkCount),
    sequence: Number(sequence),
    // The browsable snapshot: committed files by content address, so a
    // browser can read the repository without unpacking a git bundle.
    files: (Array.isArray(files) ? files : []).map((file) => ({
      path: String(file.path),
      size: Number(file.size),
      sha256: String(file.sha256),
      chunkCount: Number(file.chunkCount),
    })).sort((a, b) => a.path.localeCompare(b.path)),
    publishedAt: new Date().toISOString(),
    signedBy: validPublicKey(keyPair.pub),
  };
  if (!/^[a-f0-9]{64}$/.test(record.bundleSha256)) throw new Error('Invalid bundle digest');
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new Error('Invalid head sequence');
  if (!Number.isSafeInteger(record.chunkCount) || record.chunkCount < 1) throw new Error('Invalid chunk count');
  return {
    ...record,
    signature: await signMessage(canonical(SHARE_HEAD_CONTEXT, record), keyPair.priv),
  };
}

export async function verifyHead(record, roster) {
  if (!record || typeof record !== 'object' || !roster) return null;
  const { signature, ...rest } = record;
  const value = {
    repositoryId: String(rest.repositoryId ?? ''),
    name: String(rest.name ?? ''),
    refs: rest.refs && typeof rest.refs === 'object' ? rest.refs : {},
    bundleSha256: String(rest.bundleSha256 ?? ''),
    bundleBytes: Number(rest.bundleBytes),
    chunkCount: Number(rest.chunkCount),
    sequence: Number(rest.sequence),
    files: Array.isArray(rest.files) ? rest.files.map((file) => ({
      path: String(file?.path ?? ''),
      size: Number(file?.size),
      sha256: String(file?.sha256 ?? ''),
      chunkCount: Number(file?.chunkCount),
    })) : [],
    publishedAt: String(rest.publishedAt ?? ''),
    signedBy: String(rest.signedBy ?? ''),
  };
  if (!roster.signers.includes(value.signedBy)) return null;
  if (!/^[a-f0-9]{64}$/.test(value.bundleSha256)) return null;
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) return null;
  try {
    const { verifyMessage } = await import('unsea');
    const valid = await verifyMessage(canonical(SHARE_HEAD_CONTEXT, value), String(signature ?? ''), value.signedBy);
    return valid ? value : null;
  } catch {
    return null;
  }
}

/**
 * A proposal is a signed offer of commits: a git bundle from any link
 * holder. The signer needs no roster entry — identity here is attribution,
 * not authority. Only an owner device acting on the proposal creates a new
 * authoritative head.
 */
export async function signProposal({ repositoryId, title, baseOid, refName, bundleSha256, bundleBytes, chunkCount, keyPair, author }) {
  const { signMessage } = await import('unsea');
  const record = {
    repositoryId: validateRepositoryId(repositoryId),
    proposalId: randomBytes(16).toString('hex'),
    title: String(title ?? '').slice(0, 200),
    author: String(author ?? '').slice(0, 120),
    baseOid: String(baseOid ?? ''),
    refName: String(refName ?? ''),
    bundleSha256: String(bundleSha256),
    bundleBytes: Number(bundleBytes),
    chunkCount: Number(chunkCount),
    submittedAt: new Date().toISOString(),
    signedBy: validPublicKey(keyPair.pub),
  };
  if (!/^[a-f0-9]{64}$/.test(record.bundleSha256)) throw new Error('Invalid bundle digest');
  return {
    ...record,
    signature: await signMessage(canonical(SHARE_PROPOSAL_CONTEXT, record), keyPair.priv),
  };
}

export async function verifyProposal(record) {
  if (!record || typeof record !== 'object') return null;
  const { signature, ...rest } = record;
  const value = {
    repositoryId: String(rest.repositoryId ?? ''),
    proposalId: String(rest.proposalId ?? ''),
    title: String(rest.title ?? ''),
    author: String(rest.author ?? ''),
    baseOid: String(rest.baseOid ?? ''),
    refName: String(rest.refName ?? ''),
    bundleSha256: String(rest.bundleSha256 ?? ''),
    bundleBytes: Number(rest.bundleBytes),
    chunkCount: Number(rest.chunkCount),
    submittedAt: String(rest.submittedAt ?? ''),
    signedBy: String(rest.signedBy ?? ''),
  };
  if (!/^[a-f0-9]{32}$/.test(value.proposalId) || !/^[a-f0-9]{64}$/.test(value.bundleSha256)) return null;
  try {
    const { verifyMessage } = await import('unsea');
    const valid = await verifyMessage(canonical(SHARE_PROPOSAL_CONTEXT, value), String(signature ?? ''), validPublicKey(value.signedBy));
    return valid ? value : null;
  } catch {
    return null;
  }
}

export function chunkBundle(buffer) {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += SHARE_CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, offset + SHARE_CHUNK_BYTES).toString('base64'));
  }
  if (!chunks.length) chunks.push('');
  return { sha256, bytes: buffer.length, chunks };
}

export function assembleBundle(chunks, expectedSha256, expectedBytes) {
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(String(chunk ?? ''), 'base64')));
  if (buffer.length !== Number(expectedBytes)) return null;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return sha256 === expectedSha256 ? buffer : null;
}
