/**
 * One repository, one share, one link — fleet-wide.
 *
 * Two machines can each have minted a share for the same repository (a
 * share made before fleet adoption existed, or two people unlocking at
 * once). Browsers used to take the share from whichever record they read
 * first, so the link in the address bar and the lock on the sidebar changed
 * with which watcher happened to be awake. Every side now converges on the
 * same winner, decided from the shares alone, in this order:
 *
 *  1. a share with an always-on mirror beats one without — it is the one
 *     that was published and keeps answering when every watcher sleeps;
 *  2. the older share beats the newer (a record without a creation time
 *     counts as newest);
 *  3. the smaller key, as a tie-break nobody has to agree on out of band.
 *
 * The same rule lives in the dashboard (lib/gitpigeon/share-precedence.ts).
 */
export function preferredShare(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.key === b.key) return a;
  const aMirror = Boolean(a.mirror);
  const bMirror = Boolean(b.mirror);
  if (aMirror !== bMirror) return aMirror ? a : b;
  const aCreated = Date.parse(String(a.createdAt ?? '')) || Number.POSITIVE_INFINITY;
  const bCreated = Date.parse(String(b.createdAt ?? '')) || Number.POSITIVE_INFINITY;
  if (aCreated !== bCreated) return aCreated < bCreated ? a : b;
  return String(a.key) < String(b.key) ? a : b;
}

/** Two declarations of the SAME share, merged: any side's mirror and creation time count. */
export function mergeShareDeclarations(a, b) {
  if (!a) return b;
  if (!b || a.key !== b.key) return a;
  return {
    ...a,
    ...(a.mirror ? {} : b.mirror ? { mirror: b.mirror } : {}),
    ...(a.createdAt ? {} : b.createdAt ? { createdAt: b.createdAt } : {}),
    ...(a.ownerPublicKey ? {} : b.ownerPublicKey ? { ownerPublicKey: b.ownerPublicKey } : {}),
  };
}
