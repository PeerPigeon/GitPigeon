import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeShareDeclarations, preferredShare } from '../src/share-precedence.js';

test('one repository, one share: every side picks the same winner', () => {
  const plain = { key: 'k-plain', ownerPublicKey: 'o1', createdAt: '2026-08-31T22:57:09.860Z' };
  const mirrored = { key: 'k-mirrored', ownerPublicKey: 'o2', createdAt: '2026-09-01T10:00:00.000Z', mirror: 'nostr:ab?relays=wss%3A%2F%2Fr' };
  // A published, always-on share beats a bare one, however old the bare one is.
  assert.equal(preferredShare(plain, mirrored), mirrored);
  assert.equal(preferredShare(mirrored, plain), mirrored);
  // Among bare shares the older wins; a record without a creation time is newest.
  const newer = { key: 'k-newer', ownerPublicKey: 'o3', createdAt: '2026-09-02T00:00:00.000Z' };
  const undated = { key: 'k-undated', ownerPublicKey: 'o4' };
  assert.equal(preferredShare(plain, newer), plain);
  assert.equal(preferredShare(undated, plain), plain);
  // A dead-even tie breaks on the key, the same way everywhere.
  const twinA = { key: 'k-a', ownerPublicKey: 'o5', createdAt: newer.createdAt };
  const twinB = { key: 'k-b', ownerPublicKey: 'o6', createdAt: newer.createdAt };
  assert.equal(preferredShare(twinB, twinA), twinA);
  // The same key is the same share.
  assert.equal(preferredShare(plain, { ...plain }), plain);
  assert.equal(preferredShare(null, plain), plain);
  assert.equal(preferredShare(plain, null), plain);
});

test('declarations of one share merge: the owner contributes mirror and creation time', () => {
  const adopter = { key: 'k', ownerPublicKey: 'o' };
  const owner = { key: 'k', ownerPublicKey: 'o', createdAt: '2026-09-01T10:00:00.000Z', mirror: 'https://bucket.example/x' };
  assert.deepEqual(mergeShareDeclarations(adopter, owner), owner);
  assert.deepEqual(mergeShareDeclarations(owner, adopter), owner);
  assert.equal(mergeShareDeclarations(owner, { key: 'other', ownerPublicKey: 'p' }), owner);
});
