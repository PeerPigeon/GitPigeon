import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeNode } from './fake-node.js';
import { fleetPeer, listFleetPeers, pinFleetPeer } from '../src/fleet-peers.js';
import { secretFingerprint } from '../src/fleet-convergence.js';
import { capabilityStatement, startLanFleetConvergence } from '../src/lan-fleet.js';

const ROOM = 'gitpigeon-lan-v1-f2b666414063a3b6be5a99c23ffdc4110ef87b93';

async function keys() {
  const { generateRandomPair } = await import('unsea');
  return await generateRandomPair();
}

function indexState({ indexId, secret, pairingComplete = false, secretSetAt = null, entries = 0 }) {
  return {
    indexId,
    secret,
    publisherId: 'd'.repeat(32),
    pairingComplete,
    secretSetAt,
    entries: Array.from({ length: entries }, (_, at) => ({ repositoryId: String(at) })),
  };
}

/** One machine: its state directory, pairing keys, node and running service. */
async function machine(t, { name, index, roomId = ROOM }) {
  const root = await mkdtemp(path.join(tmpdir(), `gitpigeon-lan-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyPair = await keys();
  const node = new FakeNode(`${name}-peer`);
  const adopted = [];
  const state = { current: index };
  const service = await startLanFleetConvergence({
    root,
    keyPair,
    deviceName: name,
    roomId,
    nodeFactory: async () => node,
    localIndex: async () => state.current,
    onAdopt: async (capability) => { adopted.push(capability); },
    logger: {},
  });
  t.after(() => service.close());
  return { root, keyPair, node, adopted, state, service };
}

test('a machine only pins peers it has been in a readable index with, and keeps the first pinning time', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-fleet-peers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await listFleetPeers({ root }), []);

  await pinFleetPeer({ root, publicKey: 'pub-air', sealingKey: 'epub-air', deviceName: 'Air', now: 1_000 });
  await pinFleetPeer({ root, publicKey: 'pub-air', sealingKey: 'epub-air-rotated', deviceName: 'Dans Air', now: 9_000 });
  const pinned = await fleetPeer('pub-air', { root });
  assert.equal(pinned.sealingKey, 'epub-air-rotated');
  assert.equal(pinned.deviceName, 'Dans Air');
  assert.equal(pinned.pinnedAt, new Date(1_000).toISOString());
  assert.equal(await fleetPeer('pub-stranger', { root }), null);

  // The file is the machine's own and says nothing secret.
  const written = await readFile(path.join(root, 'fleet-peers.json'), 'utf8');
  assert.match(written, /pub-air/);
  assert.equal((await listFleetPeers({ root })).length, 1);
  assert.equal(await import('../src/fleet-peers.js').then((m) => m.forgetFleetPeer('pub-air', { root })), true);
  assert.deepEqual(await listFleetPeers({ root }), []);
});

test('two paired machines on one LAN converge on the index a browser is paired with, with no phrase', async (t) => {
  const indexId = 'f00ab7ea24fe377da70fc7148bfdd047';
  const pro = await machine(t, {
    name: 'pro',
    index: indexState({
      indexId,
      secret: 'VvDQvHKC-pro-secret-value-0000000000',
      pairingComplete: true,
      secretSetAt: '2026-09-21T02:00:00.000Z',
      entries: 14,
    }),
  });
  const air = await machine(t, {
    name: 'air',
    index: indexState({
      indexId,
      // The Air replaced its own secret later and no browser paired against it.
      secret: 'x8SZ4jwV-air-secret-value-0000000000',
      pairingComplete: false,
      secretSetAt: '2026-09-27T01:44:00.000Z',
      entries: 14,
    }),
  });
  // Each has been in one readable index with the other: that is the pinning.
  await pinFleetPeer({ root: pro.root, publicKey: air.keyPair.pub, sealingKey: air.keyPair.epub, deviceName: 'Air' });
  await pinFleetPeer({ root: air.root, publicKey: pro.keyPair.pub, sealingKey: pro.keyPair.epub, deviceName: 'Pro' });
  pro.node.wireTo(air.node);

  // The Air says where it is; the Pro hears a peer it pinned on a different
  // secret, and it is the one holding the secret the fleet should keep.
  air.node.emit('peerConnected', 'pro-peer');
  pro.node.emit('peerConnected', 'air-peer');
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(air.adopted.length, 1, 'the Air joined the index handed to it');
  assert.equal(air.adopted[0].secret, 'VvDQvHKC-pro-secret-value-0000000000');
  assert.equal(air.adopted[0].indexId, indexId);
  // The minting time travels with the secret, so the Air will not then believe
  // its copy is the newer one and hand it back.
  assert.equal(air.adopted[0].secretSetAt, '2026-09-21T02:00:00.000Z');
  assert.equal(pro.adopted.length, 0, 'the machine with the paired browser stays put');

  // An announcement carries no secret, only a name for one.
  const announcements = pro.node.plain.filter((value) => value.kind === 'here');
  assert.ok(announcements.length > 0);
  for (const value of [...announcements, ...air.node.plain.filter((v) => v.kind === 'here')]) {
    assert.equal(Object.hasOwn(value, 'secret'), false);
    assert.match(value.secretFingerprint, /^[0-9a-f]{32}$/);
  }
});

test('a machine pinned before sealing keys existed still converges, on its own signature', async (t) => {
  const indexId = 'f00ab7ea24fe377da70fc7148bfdd047';
  const pro = await machine(t, {
    name: 'pro',
    index: indexState({
      indexId,
      secret: 'VvDQvHKC-pro-secret-value-0000000000',
      pairingComplete: true,
      secretSetAt: '2026-09-21T02:00:00.000Z',
      entries: 14,
    }),
  });
  const air = await machine(t, {
    name: 'air',
    index: indexState({
      indexId,
      secret: 'x8SZ4jwV-air-secret-value-0000000000',
      secretSetAt: '2026-09-27T01:44:00.000Z',
      entries: 14,
    }),
  });
  // What a record written by a 0.13.143 machine leaves behind: a signing key
  // and NO sealing key. This is the state of a fleet that went unreadable
  // before sealing keys travelled in the index at all.
  await pinFleetPeer({ root: pro.root, publicKey: air.keyPair.pub, sealingKey: null, deviceName: 'Air' });
  await pinFleetPeer({ root: air.root, publicKey: pro.keyPair.pub, sealingKey: null, deviceName: 'Pro' });
  pro.node.wireTo(air.node);

  air.node.emit('peerConnected', 'pro-peer');
  pro.node.emit('peerConnected', 'air-peer');
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(air.adopted.length, 1, 'the handover was sealed to a key the pinned signing key vouched for');
  assert.equal(air.adopted[0].secret, 'VvDQvHKC-pro-secret-value-0000000000');
  // And the pin is complete afterwards, so the next one needs no signature.
  assert.equal((await fleetPeer(air.keyPair.pub, { root: pro.root })).sealingKey, air.keyPair.epub);

  // A sealing key nobody signed for is not usable: same announcement, no
  // signature, and the Pro hands over nothing.
  const quiet = await machine(t, {
    name: 'quiet',
    index: indexState({ indexId, secret: 'quiet-secret-0000000000000000000000', pairingComplete: true, entries: 1 }),
  });
  const other = await keys();
  await pinFleetPeer({ root: quiet.root, publicKey: other.pub, sealingKey: null, deviceName: 'Unsigned' });
  quiet.node.emit('message', {
    local: false,
    fromPeerId: 'unsigned-peer',
    data: {
      protocol: 'gitpigeon-lan-fleet/1',
      kind: 'here',
      publicKey: other.pub,
      sealingKey: other.epub,
      statedAt: new Date().toISOString(),
      indexId,
      secretFingerprint: secretFingerprint('someone-elses-secret'),
      pairingComplete: false,
      entries: 1,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(quiet.node.plain.some((value) => value.kind === 'sealed'), false);
});

test('an unpinned machine on the LAN is heard and given nothing', async (t) => {
  const indexId = 'a'.repeat(32);
  const mine = await machine(t, {
    name: 'mine',
    index: indexState({ indexId, secret: 'mine-secret-0000000000000000000000', pairingComplete: true, entries: 4 }),
  });
  const stranger = await machine(t, {
    name: 'stranger',
    index: indexState({ indexId, secret: 'stranger-secret-000000000000000000' }),
  });
  // Same LAN, same room, never paired: nothing pins anything.
  mine.node.wireTo(stranger.node);
  mine.node.emit('peerConnected', 'stranger-peer');
  stranger.node.emit('peerConnected', 'mine-peer');
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(stranger.adopted.length, 0);
  assert.equal(mine.adopted.length, 0);
  assert.equal(mine.node.plain.some((value) => value.kind === 'sealed'), false, 'nothing was sealed to a stranger');
  assert.equal(stranger.node.plain.some((value) => value.kind === 'sealed'), false);
});

test('a capability that is not signed by the pinned key is refused, however it was sealed', async (t) => {
  const indexId = 'b'.repeat(32);
  const air = await machine(t, {
    name: 'air',
    index: indexState({ indexId, secret: 'air-secret-00000000000000000000000', secretSetAt: '2026-09-01T00:00:00.000Z' }),
  });
  const pro = await keys();
  const impostor = await keys();
  await pinFleetPeer({ root: air.root, publicKey: pro.pub, sealingKey: pro.epub, deviceName: 'Pro' });

  const { encryptMessageWithMeta, signMessage } = await import('unsea');
  const capability = {
    indexId,
    secret: 'impostor-secret-000000000000000000',
    publisherId: 'e'.repeat(32),
    secretSetAt: '2026-09-27T00:00:00.000Z',
  };
  const statement = capabilityStatement({
    indexId,
    secretFingerprint: secretFingerprint(capability.secret),
    recipientPublicKey: air.keyPair.pub,
  });
  // Sealed correctly to the Air, and claiming to be the Pro — but signed by a
  // key the Air never pinned. Knowing a public sealing key is not membership.
  const forged = {
    protocol: 'gitpigeon-lan-fleet/1',
    kind: 'capability',
    from: pro.pub,
    to: air.keyPair.pub,
    signature: await signMessage(statement, impostor.priv),
    capability,
  };
  air.node.emit('message', {
    local: false,
    fromPeerId: 'impostor-peer',
    data: {
      protocol: 'gitpigeon-lan-fleet/1',
      kind: 'sealed',
      cipher: await encryptMessageWithMeta(JSON.stringify(forged), { epub: String(air.keyPair.epub) }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(air.adopted.length, 0, 'an unverifiable capability changes nothing');

  // The same capability, signed by the pinned key, is taken.
  const honest = { ...forged, signature: await signMessage(statement, pro.priv) };
  air.node.emit('message', {
    local: false,
    fromPeerId: 'pro-peer',
    data: {
      protocol: 'gitpigeon-lan-fleet/1',
      kind: 'sealed',
      cipher: await encryptMessageWithMeta(JSON.stringify(honest), { epub: String(air.keyPair.epub) }),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(air.adopted.length, 1);
  assert.equal(air.adopted[0].secret, capability.secret);
});

test('a machine that cannot name its LAN joins no room at all', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-lan-none-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let built = false;
  const service = await startLanFleetConvergence({
    root,
    keyPair: await keys(),
    roomId: null,
    detectRoom: async () => null,
    nodeFactory: async () => { built = true; return new FakeNode('never'); },
    localIndex: async () => indexState({ indexId: 'c'.repeat(32), secret: 'secret-000000000000000000000000000' }),
    onAdopt: async () => { throw new Error('nothing should be adopted'); },
    logger: {},
  });
  t.after(() => service.close());
  assert.equal(service.room, null);
  assert.equal(built, false, 'no node is started without a LAN to name');
});
