import { currentLanRoomId } from './lan-identity.js';
import { decodeMeshPayload } from './device-approval-mesh.js';
import { fleetPeer, pinFleetPeer } from './fleet-peers.js';
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
 * What an announcement is signed over, the sealing key included.
 *
 * A machine pinned from a record written before sealing keys travelled in the
 * index — every machine paired before 0.13.150 — is pinned by its signing key
 * alone, and there is nothing on disk to seal a handover to. Its own signature
 * over its sealing key supplies the missing half from the key that IS pinned,
 * so those machines re-converge too instead of needing a phrase forever.
 */
export function announcementStatement({ publicKey, sealingKey, indexId, secretFingerprint: fingerprint, statedAt }) {
  return `gitpigeon-lan-here/1\0${publicKey}\0${sealingKey}\0${indexId}\0${fingerprint}\0${statedAt}`;
}

// An announcement older than this says nothing current about a machine.
const ANNOUNCEMENT_FRESH_MS = 5 * 60_000;

/** The state of one index, as the convergence rule compares them. */
function indexFacts(index) {
  return {
    indexId: index.indexId,
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
    const { signMessage } = await import('unsea');
    node.broadcast({
      protocol: LAN_FLEET_PROTOCOL,
      kind: 'here',
      publicKey: keyPair.pub,
      sealingKey: keyPair.epub,
      statedAt,
      // Signed by the key a peer pinned, over the sealing key as well: that is
      // what lets a peer pinned before sealing keys existed complete its pin.
      signature: await signMessage(announcementStatement({
        publicKey: keyPair.pub,
        sealingKey: keyPair.epub,
        indexId: facts.indexId,
        secretFingerprint: facts.secretFingerprint,
        statedAt,
      }), keyPair.priv),
      ...(deviceName ? { deviceName: String(deviceName).slice(0, 120) } : {}),
      ...facts,
      publisherId: index.publisherId,
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
    const publicKey = String(value.publicKey ?? '');
    if (!publicKey || publicKey === keyPair.pub) return;
    const peer = await fleetPeer(publicKey, { root });
    if (!peer) {
      // Not a machine this one has been in an index with. It is on the LAN,
      // which is not a credential, so it is nothing to us.
      if (!unpinnedSeen.has(publicKey)) {
        unpinnedSeen.add(publicKey);
        logger.debug?.(`Ignoring an unpinned machine on the LAN room (${publicKey.slice(0, 12)}).`);
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
    if (!shouldOfferIndexToPeer(indexFacts(await localIndex()), remote)) return;
    if (now() - (offeredAt.get(publicKey) ?? 0) < OFFER_COOLDOWN_MS) return;
    // Where the handover can be sealed. The pinned key when there is one;
    // otherwise the one this announcement signed for itself, which only the
    // holder of the pinned signing key could have produced.
    const sealTo = peer.sealingKey ?? await selfSignedSealingKey(peer, value);
    if (!sealTo) {
      logger.debug?.(`${remote.deviceName ?? publicKey.slice(0, 12)} is on a different secret, but stated no sealing key this machine can trust.`);
      return;
    }
    await offerTo(peer, remote, sealTo);
  };

  /**
   * The sealing key an announcement states, accepted only when the pinned
   * signing key signed for it and the statement is current.
   */
  const selfSignedSealingKey = async (peer, value) => {
    const sealingKey = String(value.sealingKey ?? '');
    const statedAt = String(value.statedAt ?? '');
    const age = now() - (Date.parse(statedAt) || 0);
    if (!sealingKey || !value.signature || !(age >= -ANNOUNCEMENT_FRESH_MS && age <= ANNOUNCEMENT_FRESH_MS)) return null;
    const { verifyMessage } = await import('unsea');
    const valid = await verifyMessage(announcementStatement({
      publicKey: peer.publicKey,
      sealingKey,
      indexId: String(value.indexId ?? ''),
      secretFingerprint: String(value.secretFingerprint ?? ''),
      statedAt,
    }), String(value.signature), peer.publicKey).catch(() => false);
    if (!valid) return null;
    // Complete the pin, so the next handover needs no signature check and a
    // machine pinned from a record written before 0.13.150 is fully known.
    await pinFleetPeer({
      root,
      publicKey: peer.publicKey,
      sealingKey,
      deviceName: value.deviceName ? String(value.deviceName) : peer.deviceName,
    }).catch((error) => logger.debug?.(`Completing the pin for ${peer.publicKey.slice(0, 12)}: ${error.message}`));
    return sealingKey;
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
      indexId: String(capability.indexId ?? ''),
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
