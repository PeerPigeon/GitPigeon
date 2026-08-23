const INDEX_ID = /^[a-f0-9]{32}$/;
const SECRET = /^[a-zA-Z0-9_-]{32,256}$/;
const PUBLISHER_ID = /^[a-f0-9]{32}$/;

// A browser-issued link that lets a machine on any network join this index.
//
// The index secret travels in the fragment, exactly like the existing
// `gitpigeon://sync` repository invite. That makes the link a bearer
// capability: whoever holds it can join, so it is worth no less protection
// than the secret itself. Revoking is the answer if one leaks, and that is
// what rotating the index secret does.
export const PAIR_LINK_HOST = 'pair';

export function createPairLink({ indexId, secret, publisherId = null }) {
  const id = String(indexId ?? '');
  const key = String(secret ?? '');
  if (!INDEX_ID.test(id)) throw new Error('Invalid GitPigeon index ID');
  if (!SECRET.test(key)) throw new Error('Invalid GitPigeon index secret');
  const url = new URL(`gitpigeon://${PAIR_LINK_HOST}/${id}`);
  const publisher = String(publisherId ?? '');
  url.hash = PUBLISHER_ID.test(publisher) ? `${key}.${publisher}` : key;
  return url.toString();
}

export function parsePairLink(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Invalid GitPigeon pairing link');
  }
  if (url.protocol !== 'gitpigeon:' || url.hostname !== PAIR_LINK_HOST) {
    throw new Error('A pairing link must use gitpigeon://pair');
  }
  const indexId = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!INDEX_ID.test(indexId)) throw new Error('That pairing link has no valid index ID');
  const [secret, publisherId = ''] = decodeURIComponent(url.hash.replace(/^#/, '')).split('.');
  if (!SECRET.test(String(secret))) throw new Error('That pairing link has no valid index secret');
  return {
    indexId,
    secret: String(secret),
    publisherId: PUBLISHER_ID.test(publisherId) ? publisherId : null,
  };
}

export function isPairLink(value) {
  return /^gitpigeon:\/\/pair\//i.test(String(value ?? '').trim());
}
