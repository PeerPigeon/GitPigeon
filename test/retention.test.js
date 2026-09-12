import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_STORAGE_ROLE,
  STANDARD_RETAINED_SNAPSHOTS,
  TRANSIENT_RETAINED_SNAPSHOTS,
  diskUsage,
  isStorageRole,
  normalizeStorageRole,
  retentionPlan,
} from '../src/retention.js';

test('only the three roles are roles; anything else is standard', () => {
  assert.equal(isStorageRole('archive'), true);
  assert.equal(isStorageRole('transient'), true);
  assert.equal(isStorageRole('forever'), false);
  assert.equal(normalizeStorageRole(undefined), DEFAULT_STORAGE_ROLE);
  assert.equal(normalizeStorageRole('ARCHIVE'), DEFAULT_STORAGE_ROLE);
});

test('an archive never prunes', () => {
  assert.equal(retentionPlan({ role: 'archive', archiveOnline: false }).skip, true);
  assert.equal(retentionPlan({ role: 'archive', archiveOnline: true }).skip, true);
});

test('standard keeps the newest few whatever the fleet looks like', () => {
  for (const archiveOnline of [true, false]) {
    const plan = retentionPlan({ role: 'standard', archiveOnline });
    assert.equal(plan.skip, false);
    assert.equal(plan.retainSnapshots, STANDARD_RETAINED_SNAPSHOTS);
  }
});

test('transient thins to the newest snapshot only while an archive is online', () => {
  const thin = retentionPlan({ role: 'transient', archiveOnline: true });
  assert.equal(thin.retainSnapshots, TRANSIENT_RETAINED_SNAPSHOTS);
  // With no durable copy anywhere, the laptop holds the standard floor: data
  // that exists on no archive is not data anyone may drop.
  const floor = retentionPlan({ role: 'transient', archiveOnline: false });
  assert.equal(floor.retainSnapshots, STANDARD_RETAINED_SNAPSHOTS);
  assert.match(floor.reason, /no archive online/);
});

test('an unknown role is treated as standard, not as permission to prune', () => {
  const plan = retentionPlan({ role: 'ephemeral', archiveOnline: true });
  assert.equal(plan.role, 'standard');
  assert.equal(plan.retainSnapshots, STANDARD_RETAINED_SNAPSHOTS);
});

test('disk usage comes from the volume figures, and unknowable is null', async () => {
  const usage = await diskUsage('/anywhere', async () => ({ bsize: 4096, bavail: 1000, blocks: 4000 }));
  assert.deepEqual(usage, { freeBytes: 4_096_000, totalBytes: 16_384_000 });
  assert.equal(await diskUsage('/anywhere', async () => { throw new Error('nope'); }), null);
  assert.equal(await diskUsage('/anywhere', async () => ({ bsize: 0, bavail: 0, blocks: 0 })), null);
});
