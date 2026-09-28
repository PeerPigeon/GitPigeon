import { currentLanRoomId } from './lan-identity.js';
import { decodeMeshPayload } from './device-approval-mesh.js';
import { createHash } from 'node:crypto';
import { fleetPeer, listFleetPeers } from './fleet-peers.js';
import { preferredFleetIndex, secretFingerprint, shouldOfferIndexToPeer } from './fleet-convergence.js';
import { installNativeWebRTC } from './webrtc.js';

export const LAN_FLEET_PROTOCOL = 'gitpigeon-lan-fleet/1';
const LAN_FLEET_SESSION_ID = 'gitpigeon-lan-fleet-v1';
// A machine states where it is every so often; convergence is an event, and
// this is the backstop for a machine that joined between two of them.
const ANNOUNCE_MS = 15_000;
// One capability per peer per this long, however many announcements arrive.
// The adopting side restarts, comes back, and announces again; without this the
// handover would be re-sent through every second of that.
const OFFER_COOLDOWN_MS = 60_000;

/** What a capability handover is signed over. Binds it to one recipient. */
export function capabilityStatement({ indexId, secretFingerprint: fingerprint, recipientPublicKey }) {
  return `gitpigeon-lan-capability/1\0${indexId}\0${fingerprint}\0${recipientPublicKey}`;
}

/**
 * A one-way name for a key or an index, so an announcement identifies what it
 * is about without handing it over.
 *
 * An announcement goes out on a room every device on the LAN can join. It
 * used to carry this machine's signing key and its SEALING key in the clear —
 * and the sealing key is half of what opens a relayed terminal frame, which
 * is exactly why it was moved inside the encrypted index in the first place.
 * The pairing code a person compares is derived from the signing key. Neither
 * belongs on an open wire in a coffee shop.
 *
 * A peer that has been paired already holds both keys, from the index, so a
 * fingerprint is all it needs to recognise who is speaking; it then checks
 * the signature against the key it pinned. A stranger learns a hash.
 */
export function lanFingerprint(label, value) {
  return createHash('sha256').update(`gitpigeon-lan-${label}/1\0`).update(String(value ?? '')).digest('hex').slice(0, 32);
}

/** What an announcement is signed over. It names, and hands over nothing. */
export function announcementStatement({ keyFingerprint, indexFingerprint, secretFingerprint: fingerprint, statedAt }) {
  return `gitpigeon-lan-here/2\0${keyFingerprint}\0${indexFingerprint}\0${fingerprint}\0${statedAt}`;
}

// An announcement older than this says nothing current about a machine.
const ANNOUNCEMENT_FRESH_MS = 5 * 60_000;

/**
 * The state of one index, as the convergence rule compares them. The index is
 * named by a fingerprint: the rule only ever tests two of these for equality,
 * and the value travels on an open LAN room.
 */
function indexFacts(index) {
  return {
    indexId: lanFingerprint('index', index.indexId),
    secretFingerprint: secretFingerprint(index.secret),
    secretSetAt: index.secretSetAt ?? null,
    pairingComplete: Boolean(index.pairingComplete),
    entries: index.entries?.length ?? 0,
  };
}

/**
 * Machines that have been paired together find each other again on any LAN
 * they share, and agree on one index without anyone typing a phrase.
 *
 * The room is the LAN (lan-identity.js) and it admits nobody by itself: every
 * device on a Wi-Fi can derive its name. Membership is a key this machine
 * pinned while the two were in one readable index (fleet-peers.js), and a
 * capability is sealed to THAT pinned key — never to a key an announcement
 * carried, which is what stops an announcement from being worth forging.
 *
 * This is the piece that was missing when every machine replaced its own index
 * secret once: two machines that had been paired for months went unreadable to
 * each other, kept connecting, and had no way back but a phrase typed on each
 * of them. Now the one whose secret the fleet should keep hands it over.
 */
export async function startLanFleetConvergence({
  root,
  keyPair,
  deviceName = null,
  localIndex,
  onAdopt,
  logger = {},
  // Whether this machine is in pairing mode. A machine says it is looking for
  // a fleet only while it is, and the answer is read fresh each time: pairing
  // mode is opened and shut while the watcher runs.
  seekingFleet = async () => false,
  onSeekingMachine = null,
  roomId = null,
  detectRoom = currentLanRoomId,
  nodeFactory = null,
  announceMs = ANNOUNCE_MS,
  now = () => Date.now(),
} = {}) {
  if (!root) throw new Error('LAN fleet convergence needs the machine state root');
  if (!keyPair?.pub || !keyPair?.epub) throw new Error('LAN fleet convergence needs this machine\'s pairing key pair');
  if (typeof localIndex !== 'function') throw new Error('LAN fleet convergence needs a way to read this machine\'s index');
  if (typeof onAdopt !== 'function') throw new Error('LAN fleet convergence needs somewhere to hand an adopted index');
  const room = roomId ?? await detectRoom();
  if (!room) {
    // No nameable LAN — no gateway, no matching subnet. Silence is the only
    // safe answer: a default room would gather every machine that cannot name
    // its own network into one place.
    logger.debug?.('No LAN room: this machine cannot name its network, so it converges with nobody here.');
    return { room: null, async close() {} };
  }
  const node = await (nodeFactory
    ? nodeFactory({ crypto: { keyPair }, networkId: room, sessionId: LAN_FLEET_SESSION_ID })
    : (async () => {
      await installNativeWebRTC();
      const { PeerPigeonNode } = await import('peerpigeon');
      return new PeerPigeonNode({ crypto: { keyPair }, networkId: room, sessionId: LAN_FLEET_SESSION_ID });
    })());

  let closed = false;
  const offeredAt = new Map();
  const unpinnedSeen = new Set();

  const announce = async () => {
    if (closed) return;
    const index = await localIndex();
    const facts = indexFacts(index);
    const statedAt = new Date(now()).toISOString();
    const keyFingerprint = lanFingerprint('key', keyPair.pub);
    const { signMessage } = await import('unsea');
    node.broadcast({
      protocol: LAN_FLEET_PROTOCOL,
      kind: 'here',
      keyFingerprint,
      statedAt,
      // Signed by the key a peer pinned. It proves who is speaking to someone
      // who already holds that key, and tells a stranger nothing.
      signature: await signMessage(announcementStatement({
        keyFingerprint,
        indexFingerprint: facts.indexId,
        secretFingerprint: facts.secretFingerprint,
        statedAt,
      }), keyPair.priv),
      ...(deviceName ? { deviceName: String(deviceName).slice(0, 120) } : {}),
      // A machine in pairing mode says so, so the fleet on this LAN can show
      // it to the person instead of them having to know it is there. It is a
      // statement of availability and nothing more: what it takes to actually
      // join is unchanged, and no key travels with this.
      ...(await seekingFleet() ? { seeking: true } : {}),
      ...facts,
    });
  };

  const offerTo = async (peer, remote, sealTo) => {
    const index = await localIndex();
    const { signMessage, encryptMessageWithMeta } = await import('unsea');
    const statement = capabilityStatement({
      indexId: index.indexId,
      secretFingerprint: secretFingerprint(index.secret),
      recipientPublicKey: peer.publicKey,
    });
    const payload = {
      protocol: LAN_FLEET_PROTOCOL,
      kind: 'capability',
      from: keyPair.pub,
      to: peer.publicKey,
      signature: await signMessage(statement, keyPair.priv),
      capability: {
        indexId: index.indexId,
        secret: index.secret,
        publisherId: index.publisherId,
        ...(index.secretSetAt ? { secretSetAt: index.secretSetAt } : {}),
      },
    };
    // Sealed to the pinned key, or to one the pinned key signed for itself.
    // Never to a key an announcement merely asserted.
    const cipher = await encryptMessageWithMeta(JSON.stringify(payload), { epub: String(sealTo) });
    node.broadcast({ protocol: LAN_FLEET_PROTOCOL, kind: 'sealed', cipher });
    offeredAt.set(peer.publicKey, now());
    logger.info?.(`Handed this machine's index to ${peer.deviceName ?? remote.deviceName ?? 'a paired machine'} over the LAN; it was on a different secret.`);
  };

  const heard = async (value) => {
    const heardFingerprint = String(value.keyFingerprint ?? '');
    if (!heardFingerprint || heardFingerprint === lanFingerprint('key', keyPair.pub)) return;
    // Only a machine already paired with this one can be recognised: the
    // announcement names a key, and the key itself is held here from when the
    // two were in one readable index.
    const peer = (await listFleetPeers({ root }))
      .find((candidate) => lanFingerprint('key', candidate.publicKey) === heardFingerprint) ?? null;
    // A machine nobody here has met, saying it is looking for a fleet. It is
    // reported so a person can be shown it — "there is a new machine on this
    // network" — and nothing else happens: being on the LAN is not a reason
    // to hand anything over, and this announcement carries no key to hand it
    // over with. Taking it in is a person confirming the code it is showing.
    if (!peer && value.seeking === true && onSeekingMachine) {
      await onSeekingMachine({
        keyFingerprint: heardFingerprint,
        deviceName: value.deviceName ? String(value.deviceName).slice(0, 120) : null,
        statedAt: String(value.statedAt ?? ''),
      });
    }
    if (!peer) {
      // Not a machine this one has been in an index with. It is on the LAN,
      // which is not a credential, so it is nothing to us.
      if (!unpinnedSeen.has(heardFingerprint)) {
        unpinnedSeen.add(heardFingerprint);
        logger.debug?.(`Ignoring an unpinned machine on the LAN room (${heardFingerprint.slice(0, 12)}).`);
      }
      return;
    }
    const remote = {
      indexId: String(value.indexId ?? ''),
      secretFingerprint: String(value.secretFingerprint ?? ''),
      secretSetAt: value.secretSetAt ?? null,
      pairingComplete: Boolean(value.pairingComplete),
      entries: Number(value.entries) || 0,
      deviceName: value.deviceName ? String(value.deviceName).slice(0, 120) : null,
    };
    // The announcement must be current and signed by the key pinned here.
    const statedAt = String(value.statedAt ?? '');
    const age = now() - (Date.parse(statedAt) || 0);
    if (!(age >= -ANNOUNCEMENT_FRESH_MS && age <= ANNOUNCEMENT_FRESH_MS)) return;
    const { verifyMessage } = await import('unsea');
    const spoken = await verifyMessage(announcementStatement({
      keyFingerprint: heardFingerprint,
      indexFingerprint: remote.indexId,
      secretFingerprint: remote.secretFingerprint,
      statedAt,
    }), String(value.signature ?? ''), peer.publicKey).catch(() => false);
    if (!spoken) {
      logger.debug?.(`An announcement naming ${peer.deviceName ?? heardFingerprint.slice(0, 12)} was not signed by the key pinned for it.`);
      return;
    }
    if (!shouldOfferIndexToPeer(indexFacts(await localIndex()), remote)) return;
    if (now() - (offeredAt.get(peer.publicKey) ?? 0) < OFFER_COOLDOWN_MS) return;
    // Sealed only to the key this machine already holds for that peer, from
    // the encrypted index. A machine pinned before sealing keys travelled
    // there has none, and pairs once by phrase rather than being handed a
    // secret on the strength of something announced over the air.
    if (!peer.sealingKey) {
      logger.debug?.(`${remote.deviceName ?? peer.deviceName ?? 'A paired machine'} is on a different index secret, but this machine holds no sealing key for it. Pair it once and it re-converges after that.`);
      return;
    }
    await offerTo(peer, remote, peer.sealingKey);
  };

  const sealed = async (cipher) => {
    const { decryptMessageWithMeta, verifyMessage } = await import('unsea');
    let opened;
    try {
      opened = await decryptMessageWithMeta(cipher, keyPair.epriv);
    } catch {
      // Sealed to another machine on this LAN: not ours to read, and not a
      // fault. Every member broadcasts, so this is the common case.
      return;
    }
    const payload = decodeMeshPayload(opened);
    if (!payload || payload.protocol !== LAN_FLEET_PROTOCOL || payload.kind !== 'capability') return;
    if (payload.to !== keyPair.pub) return;
    const peer = await fleetPeer(String(payload.from ?? ''), { root });
    // Sealed to us proves only that someone knows our public sealing key. What
    // makes this a fleet member's word is the signature, checked against the
    // key this machine pinned — not against anything in the message.
    if (!peer) return;
    const capability = payload.capability ?? {};
    const fingerprint = secretFingerprint(capability.secret);
    if (!fingerprint) return;
    const valid = await verifyMessage(
      capabilityStatement({
        indexId: String(capability.indexId ?? ''),
        secretFingerprint: fingerprint,
        recipientPublicKey: keyPair.pub,
      }),
      String(payload.signature ?? ''),
      peer.publicKey,
    ).catch(() => false);
    if (!valid) {
      logger.debug?.(`A LAN capability did not verify against ${peer.publicKey.slice(0, 12)}; ignored.`);
      return;
    }
    const mine = indexFacts(await localIndex());
    const theirs = {
      // Fingerprinted to match how this machine names its own index; the rule
      // compares these for equality and nothing else.
      indexId: lanFingerprint('index', capability.indexId),
      secretFingerprint: fingerprint,
      secretSetAt: capability.secretSetAt ?? null,
      // A handover is only sent by a machine that decided it wins, and states
      // no repository count. What matters here is that this machine agrees, so
      // a late or replayed offer cannot drag it backwards.
      pairingComplete: true,
      entries: 0,
    };
    if (mine.secretFingerprint === theirs.secretFingerprint) return;
    const { winner, reason } = preferredFleetIndex(mine, theirs);
    if (winner !== 'remote') {
      logger.debug?.(`Declined a LAN capability from ${peer.deviceName ?? peer.publicKey.slice(0, 12)}: this machine's index wins (${reason}).`);
      return;
    }
    logger.info?.(`${peer.deviceName ?? 'A paired machine'} handed over its index on the LAN; joining it and restarting.`);
    await onAdopt(capability, peer);
  };

  const receive = (message) => {
    if (closed || message?.local) return;
    const value = decodeMeshPayload(message.data);
    if (!value || value.protocol !== LAN_FLEET_PROTOCOL) return;
    if (value.kind === 'here') {
      heard(value).catch((error) => logger.debug?.(`LAN fleet announcement: ${error.message}`));
      return;
    }
    if (value.kind === 'sealed' && value.cipher) {
      sealed(value.cipher).catch((error) => logger.debug?.(`LAN fleet capability: ${error.message}`));
    }
  };

  const speak = () => {
    announce().catch((error) => logger.debug?.(`LAN fleet announce: ${error.message}`));
  };
  node.on('message', receive);
  node.on('peerConnected', speak);
  await node.start();
  speak();
  const timer = setInterval(speak, announceMs);
  timer.unref?.();
  logger.debug?.(`LAN fleet room ${room.slice(0, 28)}…: paired machines here re-converge without a phrase.`);

  return {
    room,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      node.off('message', receive);
      node.off('peerConnected', speak);
      await node.destroy().catch((error) => logger.debug?.(`LAN fleet close: ${error.message}`));
    },
  };
}
