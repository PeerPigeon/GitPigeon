import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  assembleBundle,
  chunkBundle,
  createShareKey,
  createShareUrl,
  parseShareUrl,
  shareRoomId,
  shareStoragePrefix,
  signHead,
  signProposal,
  signRoster,
  verifyHead,
  verifyProposal,
  verifyRoster,
} from '../src/share.js';

const repositoryId = 'a1b2c3d4e5f60718';

async function pair() {
  const { generateRandomPair } = await import('unsea');
  return await generateRandomPair();
}

test('share URLs round-trip and keep the keys in the fragment', () => {
  const shareKey = createShareKey();
  const ownerPublicKey = 'OWNERPUB.abcdef1234567890';
  const url = createShareUrl({ repositoryId, shareKey, ownerPublicKey });
  assert.ok(url.startsWith('https://gitpigeon.dev/r/'));
  // The fragment never reaches a server; nothing sensitive may sit outside it.
  const beforeFragment = url.slice(0, url.indexOf('#'));
  assert.ok(!beforeFragment.includes(shareKey));
  assert.ok(!beforeFragment.includes(encodeURIComponent(ownerPublicKey)));
  const parsed = parseShareUrl(url);
  assert.equal(parsed.repositoryId, repositoryId);
  assert.equal(parsed.shareKey, shareKey);
  assert.equal(parsed.ownerPublicKey, ownerPublicKey);

  const local = createShareUrl({ repositoryId, shareKey, ownerPublicKey, origin: 'https://localhost:3000' });
  assert.equal(parseShareUrl(local).shareKey, shareKey);
  assert.throws(() => parseShareUrl('https://gitpigeon.dev/x/nope#s=1&o=2'));
});

test('roster and head form a verifiable chain back to the URL anchor', async () => {
  const owner = await pair();
  const device = await pair();
  const stranger = await pair();

  const roster = await signRoster({ repositoryId, signers: [device.pub], version: 1, ownerKeyPair: owner });
  const verified = await verifyRoster(roster, owner.pub);
  assert.ok(verified, 'roster verifies against the owner key');
  assert.ok(verified.signers.includes(device.pub));
  assert.ok(verified.signers.includes(owner.pub), 'the owner key is always a signer');
  assert.equal(await verifyRoster(roster, stranger.pub), null, 'a different anchor rejects the roster');
  assert.equal(await verifyRoster({ ...roster, signers: [...roster.signers, stranger.pub] }, owner.pub), null, 'tampered signer lists fail');

  const bundleSha256 = 'f'.repeat(64);
  const head = await signHead({
    repositoryId,
    refs: { 'refs/heads/main': 'a'.repeat(40) },
    bundleSha256,
    bundleBytes: 12345,
    chunkCount: 1,
    sequence: 3,
    keyPair: device,
  });
  const goodHead = await verifyHead(head, verified);
  assert.ok(goodHead, 'a rostered device publishes a valid head');
  assert.equal(goodHead.refs['refs/heads/main'], 'a'.repeat(40));

  const forged = await signHead({
    repositoryId,
    refs: { 'refs/heads/main': 'b'.repeat(40) },
    bundleSha256,
    bundleBytes: 12345,
    chunkCount: 1,
    sequence: 4,
    keyPair: stranger,
  });
  assert.equal(await verifyHead(forged, verified), null, 'an unrostered key cannot publish a head');
  assert.equal(await verifyHead({ ...head, refs: { 'refs/heads/main': 'c'.repeat(40) } }, verified), null, 'tampered refs fail');
});

test('proposals verify by their own signature; authority stays with the roster', async () => {
  const outsider = await pair();
  const proposal = await signProposal({
    repositoryId,
    title: 'Fix the thing',
    author: 'visitor',
    baseOid: 'a'.repeat(40),
    refName: 'refs/heads/main',
    bundleSha256: 'e'.repeat(64),
    bundleBytes: 512,
    chunkCount: 1,
    keyPair: outsider,
  });
  const verified = await verifyProposal(proposal);
  assert.ok(verified);
  assert.equal(verified.title, 'Fix the thing');
  assert.equal(await verifyProposal({ ...proposal, title: 'Sneaky rename' }), null, 'tampered proposals fail');
});

test('bundles chunk and reassemble content-addressed', () => {
  const buffer = randomBytes(500_000);
  const { sha256, bytes, chunks } = chunkBundle(buffer);
  assert.ok(chunks.length >= 3);
  const rebuilt = assembleBundle(chunks, sha256, bytes);
  assert.ok(rebuilt && rebuilt.equals(buffer));
  assert.equal(assembleBundle(chunks.slice(1), sha256, bytes), null, 'missing chunks fail the digest');
});

test('room and storage names are share-scoped', () => {
  assert.equal(shareRoomId(repositoryId), `gitpigeon:share:${repositoryId}`);
  assert.ok(shareStoragePrefix(repositoryId).startsWith('gitpigeon/share/v1/'));
});
