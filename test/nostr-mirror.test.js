import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  DEFAULT_NOSTR_RELAYS,
  NOSTR_MIRROR_KIND,
  NostrMirrorClient,
  generateNostrMirrorKey,
  nostrPublicBase,
  nostrPublicKey,
  parseNostrBase,
  signedMirrorEvent,
} from '../src/nostr-mirror.js';
import { startFakeNostrRelay } from './fake-nostr-relay.js';

test('mirror events are valid NIP-01: correct id, verifiable signature, replaceable address', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1');
  const secretKey = generateNostrMirrorKey();
  const event = await signedMirrorEvent({
    secretKey,
    recordKey: 'gitpigeon-mirror/v1/repo/public/registry.json',
    content: '{"cipher":1}',
    createdAt: 1_700_000_000,
  });
  assert.equal(event.kind, NOSTR_MIRROR_KIND);
  assert.deepEqual(event.tags, [['d', 'gitpigeon-mirror/v1/repo/public/registry.json']]);
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  assert.equal(event.id, createHash('sha256').update(serialized).digest('hex'));
  assert.ok(schnorr.verify(event.sig, event.id, event.pubkey));
});

test('the public base round-trips and defaults to free relays', async () => {
  const secretKey = generateNostrMirrorKey();
  const base = nostrPublicBase(await nostrPublicKey(secretKey), [...DEFAULT_NOSTR_RELAYS]);
  const parsed = parseNostrBase(base);
  assert.ok(parsed);
  assert.deepEqual(parsed.relays, [...DEFAULT_NOSTR_RELAYS]);
});

test('the client publishes replaceable records to a relay and newer versions win', async () => {
  const relay = await startFakeNostrRelay();
  try {
    const client = new NostrMirrorClient({ secretKey: generateNostrMirrorKey(), relays: [relay.url] });
    await client.put('gitpigeon-mirror/v1/repo/public/registry.json', '{"version":1}');
    await client.put('gitpigeon-mirror/v1/repo/public/registry.json', '{"version":2}');
    await client.put('gitpigeon-mirror/v1/repo/frozen/chunk.json', '{"data":true}');
    client.close();
    assert.equal(relay.eventCount(), 2);
    const registry = [...relay.events.values()].find((event) => event.tags[0][1].endsWith('registry.json'));
    assert.equal(registry.content, '{"version":2}');
  } finally {
    await relay.close();
  }
});

test('any share link finds the mirror: an owner-signed pointer at an address derived from the share key', async () => {
  const { generateRandomPair } = await import('unsea');
  const { createShareKey, sharePointerTag, signMirrorPointer, verifyMirrorPointer } = await import('../src/share.js');
  const { nostrPointerKey, publishNostrPointer } = await import('../src/nostr-mirror.js');
  const owner = await generateRandomPair();
  const stranger = await generateRandomPair();
  const shareKey = createShareKey();
  const repositoryId = 'a'.repeat(32);
  const mirror = nostrPublicBase(await nostrPublicKey(generateNostrMirrorKey()), ['wss://relay.example']);

  // Derived from the share key alone: the link's `s=` is all a reader needs.
  assert.match(nostrPointerKey(shareKey), /^[0-9a-f]{64}$/);
  assert.equal(nostrPointerKey(shareKey), nostrPointerKey(shareKey));
  assert.notEqual(nostrPointerKey(shareKey), nostrPointerKey(createShareKey()));

  const record = await signMirrorPointer({ repositoryId, mirror, ownerKeyPair: owner });
  assert.equal((await verifyMirrorPointer(record, owner.pub))?.mirror, mirror);
  // Every link holder can WRITE at the pointer address, so only the owner's
  // signature makes a pointer believable.
  assert.equal(await verifyMirrorPointer(record, stranger.pub), null);
  assert.equal(await verifyMirrorPointer({ ...record, mirror: 'https://evil.example/bucket' }, owner.pub), null);
  assert.equal(await verifyMirrorPointer(await signMirrorPointer({ repositoryId, mirror, ownerKeyPair: stranger }), owner.pub), null);

  const relay = await startFakeNostrRelay();
  try {
    await publishNostrPointer({ shareKey, tag: sharePointerTag(repositoryId), body: JSON.stringify(record), relays: [relay.url] });
    const [event] = [...relay.events.values()];
    assert.equal(event.pubkey, await nostrPublicKey(nostrPointerKey(shareKey)));
    assert.deepEqual(event.tags, [['d', `gitpigeon-pointer/v1/${repositoryId}`]]);
    assert.equal((await verifyMirrorPointer(JSON.parse(event.content), owner.pub))?.mirror, mirror);
  } finally {
    await relay.close();
  }
});
