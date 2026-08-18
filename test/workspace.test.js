import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceFiles } from '../src/workspace.js';
import { createRepository } from './helpers.js';

test('tracks exact private files through Git info/exclude without adding them to Git', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(path.join(root, 'repository'));
  await writeFile(path.join(repository.root, '.env'), 'TOKEN=secret\n');
  const workspace = new WorkspaceFiles(repository);

  assert.deepEqual(await workspace.track(['.env']), ['.env']);
  assert.deepEqual(await workspace.list(), ['.env']);
  assert.equal((await repository.git(['check-ignore', '.env'])).stdout.trim(), '.env');
  assert.match(await readFile(path.join(repository.gitDir, 'info', 'exclude'), 'utf8'), /^\/\.env$/m);
  assert.equal(await repository.isTracked('.env'), false);
});

test('refuses to privately track a file that already exists in Git history', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-workspace-git-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(path.join(root, 'repository'), 'tracked');
  const workspace = new WorkspaceFiles(repository);

  await assert.rejects(
    workspace.track(['file.txt']),
    /already tracked by Git; run `git rm --cached/,
  );
});
