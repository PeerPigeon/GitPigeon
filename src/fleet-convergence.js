import { createHash } from 'node:crypto';

/**
 * A secret's name, not the secret. Two machines compare indexes by announcing
 * these on a LAN room anything can listen to, so what identifies a secret must
 * not be usable as one.
 */
export function secretFingerprint(secret) {
  if (!secret) return null;
  return createHash('sha256')
    .update('gitpigeon-secret-id/1\0')
    .update(String(secret))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Which index a reunited fleet settles on.
 *
 * Two machines that were paired together can end up on the same index id with
 * different secrets — each replaces its own once on its first start of a fixed
 * build (rotateForExposureOnce), and neither knows the other did. They still
 * meet: the signaling session is the index id, which a rotation keeps. They
 * just cannot read each other, which looks exactly like nothing being there.
 *
 * Both machines run this on the same pair of facts and must reach the same
 * answer, or they swap secrets forever. So the order is total and clock-free
 * at the end:
 *
 *  1. A secret a BROWSER has completed pairing against wins. Someone is
 *     sitting in front of that dashboard; converging the other way would take
 *     it away from them to no purpose.
 *  2. Otherwise the newer secret wins — a rotation is meant to supersede.
 *  3. Otherwise the greater secret wins. Arbitrary, and the point: it decides.
 */
export function preferredFleetIndex(local, remote) {
  if (!remote?.indexId || !remote?.secretFingerprint) return { winner: 'local', reason: 'no-remote' };
  if (!local?.indexId || !local?.secretFingerprint) return { winner: 'remote', reason: 'no-local' };
  if (local.indexId !== remote.indexId) {
    // Not one fleet re-keyed — two different fleets. A machine with nothing
    // registered can still join one; a machine with repositories stays where
    // it is, the same refusal adoptMachineIndexCapability makes.
    return local.entries > 0
      ? { winner: 'local', reason: 'different-index' }
      : { winner: 'remote', reason: 'joining-index' };
  }
  if (local.secretFingerprint === remote.secretFingerprint) return { winner: 'local', reason: 'same-secret' };
  if (Boolean(local.pairingComplete) !== Boolean(remote.pairingComplete)) {
    return local.pairingComplete
      ? { winner: 'local', reason: 'browser-paired-here' }
      : { winner: 'remote', reason: 'browser-paired-there' };
  }
  const localAt = Date.parse(String(local.secretSetAt ?? '')) || 0;
  const remoteAt = Date.parse(String(remote.secretSetAt ?? '')) || 0;
  if (localAt !== remoteAt) {
    return localAt > remoteAt
      ? { winner: 'local', reason: 'newer-secret-here' }
      : { winner: 'remote', reason: 'newer-secret-there' };
  }
  return local.secretFingerprint > remote.secretFingerprint
    ? { winner: 'local', reason: 'tie-break' }
    : { winner: 'remote', reason: 'tie-break' };
}

/**
 * Whether this machine should hand its index to a pinned peer that announced
 * the state in `remote`. The mirror of the decision above, so exactly one of
 * the two machines moves.
 */
export function shouldOfferIndexToPeer(local, remote) {
  if (!remote?.secretFingerprint || local?.secretFingerprint === remote.secretFingerprint) return false;
  return preferredFleetIndex(local, remote).winner === 'local'
    && (local.indexId === remote.indexId || !(remote.entries > 0));
}
