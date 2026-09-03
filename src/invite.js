import { timingSafeEqual } from 'node:crypto';

const ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const SECRET_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export function validateRepositoryId(value) {
  const id = String(value ?? '').trim();
  if (!ID_PATTERN.test(id)) {
    throw new Error('Repository ID must be 8-128 URL-safe characters');
  }
  return id;
}

export function validateSecret(value) {
  const secret = String(value ?? '').trim();
  if (!SECRET_PATTERN.test(secret)) {
    throw new Error('Sync secret must be at least 32 URL-safe characters');
  }
  return secret;
}

export function createInvite({ repositoryId, secret, signalingServer, name }) {
  const id = validateRepositoryId(repositoryId);
  const key = validateSecret(secret);
  const url = new URL(`gitpigeon://sync/${encodeURIComponent(id)}`);
  if (signalingServer) url.searchParams.set('signal', String(signalingServer));
  // The repository's name travels with the capability so a machine joining
  // by this invite adopts it, rather than naming the repository after the
  // folder it happens to clone into.
  const trimmed = typeof name === 'string' ? name.trim().slice(0, 200) : '';
  if (trimmed) url.searchParams.set('n', trimmed);
  url.hash = key;
  return url.toString();
}

export function parseInvite(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error('Invalid GitPigeon invite URL');
  }
  if (url.protocol !== 'gitpigeon:' || url.hostname !== 'sync') {
    throw new Error('Invite must use gitpigeon://sync');
  }
  const repositoryId = validateRepositoryId(decodeURIComponent(url.pathname.replace(/^\//, '')));
  const secret = validateSecret(decodeURIComponent(url.hash.replace(/^#/, '')));
  const signalingServer = url.searchParams.get('signal') || undefined;
  if (signalingServer && !/^wss?:\/\//i.test(signalingServer)) {
    throw new Error('Invite signaling server must use ws:// or wss://');
  }
  const name = (url.searchParams.get('n') || '').trim().slice(0, 200) || undefined;
  return { repositoryId, secret, signalingServer, ...(name ? { name } : {}) };
}

export function secretsEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

