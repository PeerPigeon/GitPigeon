import assert from 'node:assert/strict';
import test from 'node:test';

import { pruneStaleIndexRecords } from '../src/machine-index.js';

test('stale device-request buckets and superseded snapshot heads are pruned, current ones kept', async () => {
  const now = 1_000_000_000_000;
  const index = 'f'.repeat(32), repo = 'a'.repeat(32), device = 'b'.repeat(32);
  const oldBucket = Math.floor((now - 2 * 60 * 60_000) / 5_000), freshBucket = Math.floor(now / 5_000);
  const current = '1'.repeat(64), old = '2'.repeat(64);
  const records = new Map([
    [`gitpigeon/index/v1/${index}/device-requests/${oldBucket}`, {}],
    [`gitpigeon/index/v1/${index}/device-requests/${freshBucket}`, {}],
    [`gitpigeon/v1/${repo}/head/${device}`, { snapshotId: current }],
    [`gitpigeon/v1/${repo}/head/${device}/${current}`, { snapshotId: current }],
    [`gitpigeon/v1/${repo}/head/${device}/${old}`, { snapshotId: old }],
    [`gitpigeon/index/v1/${index}/publisher/${'c'.repeat(32)}`, { pigeons: [] }],
  ]);
  const storage = {
    async list() { return [...records].map(([key, value]) => ({ key, value })); },
    async deleteSystem(_space, key) { return records.delete(key); },
  };
  const removed = await pruneStaleIndexRecords(storage, now);
  assert.equal(removed, 2);
  assert.deepEqual([...records.keys()].sort(), [
    `gitpigeon/index/v1/${index}/device-requests/${freshBucket}`,
    `gitpigeon/index/v1/${index}/publisher/${'c'.repeat(32)}`,
    `gitpigeon/v1/${repo}/head/${device}`,
    `gitpigeon/v1/${repo}/head/${device}/${current}`,
  ].sort());
});
