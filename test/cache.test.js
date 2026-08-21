import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RepositoryCache } from '../src/cache.js';

function manifest(snapshotId, createdAt, chunks, files = [], liveFiles = []) {
  return { snapshotId, createdAt, chunks, files, liveFiles };
}

test('snapshot cache pruning retains current and recent snapshots without leaking old chunks', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new RepositoryCache(path.join(root, '.git'));
  await cache.init();

  const ids = ['a', 'b', 'c', 'd'].map((value) => value.repeat(64));
  const chunks = ['1', '2', '3', '4', '5'].map((value) => value.repeat(64));
  for (const digest of chunks) await cache.writeChunk(digest, Buffer.from(digest));
  await cache.writeManifest(manifest(ids[0], '2026-01-01T00:00:00.000Z', [
    { sha256: chunks[0], size: 64 },
    { sha256: chunks[1], size: 64 },
  ]));
  await cache.writeManifest(manifest(ids[1], '2026-01-02T00:00:00.000Z', [
    { sha256: chunks[0], size: 64 },
    { sha256: chunks[2], size: 64 },
  ]));
  await cache.writeManifest(manifest(ids[2], '2026-01-03T00:00:00.000Z', [], [
    { chunks: [{ sha256: chunks[3], size: 64 }] },
  ]));
  await cache.writeManifest(manifest(ids[3], '2026-01-04T00:00:00.000Z', [], [], [
    { chunks: [{ sha256: chunks[4], size: 64 }] },
  ]));

  const result = await cache.prune({ keepSnapshotIds: [ids[0]], retainSnapshots: 2 });

  assert.deepEqual(result, {
    skipped: false,
    removedManifests: 1,
    removedChunks: 1,
    retainedManifests: 3,
  });
  assert.deepEqual((await cache.listManifests()).sort(), [ids[0], ids[2], ids[3]].sort());
  assert.deepEqual((await readdir(cache.chunkDirectory)).sort(), [
    chunks[0], chunks[1], chunks[3], chunks[4],
  ].sort());
  await assert.rejects(access(cache.manifestPath(ids[1])));
  await assert.rejects(access(cache.chunkPath(chunks[2])));
});
