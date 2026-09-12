// Storage roles: what a machine keeps, chosen per watcher from the dashboard.
//
// One machine in a fleet has the disk (the ten-terabyte mini); the laptops
// are around to edit and sync through, not to hold history forever. A role
// per watcher says which is which. The record lives in index storage beside
// the fleet update policy, written by browsers and honoured by every watcher.
//
//   archive    keeps every snapshot and chunk it has ever seen for the
//              repositories it serves; nothing is pruned or evicted.
//   standard   today's behaviour: the newest few snapshots per repository.
//   transient  the newest snapshot only — but never below standard while no
//              archive is online holding the fleet's history. Data that
//              exists on no durable machine is not data anyone can drop.
//
// Roles govern cache and snapshot history only. A working tree is never
// removed because of a role; forgetting a repository is an explicit action.

export const STORAGE_ROLES = Object.freeze(['archive', 'standard', 'transient']);
export const DEFAULT_STORAGE_ROLE = 'standard';

export const STANDARD_RETAINED_SNAPSHOTS = 4;
export const TRANSIENT_RETAINED_SNAPSHOTS = 1;
export const RETAIN_RECENT_SNAPSHOTS_MS = 15 * 60_000;

export function isStorageRole(value) {
  return STORAGE_ROLES.includes(String(value ?? ''));
}

export function normalizeStorageRole(value) {
  return isStorageRole(value) ? String(value) : DEFAULT_STORAGE_ROLE;
}

/**
 * What a prune pass may do under a role. `archiveOnline` answers whether at
 * least one archive-role watcher is live right now; a transient machine only
 * thins below the standard floor while that is true.
 */
export function retentionPlan({ role = DEFAULT_STORAGE_ROLE, archiveOnline = false } = {}) {
  const normalized = normalizeStorageRole(role);
  if (normalized === 'archive') {
    return { role: normalized, skip: true, reason: 'archive keeps everything' };
  }
  if (normalized === 'transient' && archiveOnline) {
    return {
      role: normalized,
      skip: false,
      retainSnapshots: TRANSIENT_RETAINED_SNAPSHOTS,
      retainRecentMs: RETAIN_RECENT_SNAPSHOTS_MS,
    };
  }
  return {
    role: normalized,
    skip: false,
    retainSnapshots: STANDARD_RETAINED_SNAPSHOTS,
    retainRecentMs: RETAIN_RECENT_SNAPSHOTS_MS,
    ...(normalized === 'transient' ? { reason: 'no archive online; holding the standard floor' } : {}),
  };
}

/** Free and total bytes of the volume holding `directory`, or null when unknowable. */
export async function diskUsage(directory, statfsImpl = null) {
  try {
    const statfs = statfsImpl ?? (await import('node:fs/promises')).statfs;
    if (typeof statfs !== 'function') return null;
    const stats = await statfs(directory);
    const size = Number(stats.bsize);
    const free = Number(stats.bavail) * size;
    const total = Number(stats.blocks) * size;
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null;
    return { freeBytes: Math.round(free), totalBytes: Math.round(total) };
  } catch {
    return null;
  }
}
