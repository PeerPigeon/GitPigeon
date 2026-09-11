import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldScanRepository } from '../src/repository-change.js';

test('generated-file and Git bookkeeping bursts do not trigger full repository scans', () => {
  for (const path of [
    'node_modules/pkg/index.js', 'packages/web/node_modules/pkg/index.js', '.next/cache/output',
    '.wrangler/state/db', 'tsconfig.tsbuildinfo', '.git/index.lock', '.git/index',
    '.git/objects/pack/pack-abc.pack', '.git/logs/HEAD', '.git/refs/remotes/peer/main',
    '.git/gitpigeon/state.json', '.git/info/exclude.123-aabbccddee.tmp',
  ]) assert.equal(shouldScanRepository(path), false, path);
});
test('edits, secrets, deletions, branch switches and commits remain observable', () => {
  for (const path of [
    undefined, '', '.git', 'src/app.js', '.env', '.gitignore', 'README.md',
    '.git/HEAD', '.git/refs/heads/main', '.git/refs/tags/v1', '.git/packed-refs',
    '.git/info/exclude', '.git/config',
  ]) assert.equal(shouldScanRepository(path), true, String(path));
  assert.equal(shouldScanRepository('node_modules\\pkg\\index.js'), false);
});
