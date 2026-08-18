import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRepository, commitFile } from './helpers.js';

test('imports a bundle into native remote refs and fast-forwards an empty checkout', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-git-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createRepository(path.join(root, 'source'), 'hello');
  const target = await createRepository(path.join(root, 'target'));
  const bundle = await source.createBundle();
  t.after(bundle.dispose);
  const filename = path.join(root, 'snapshot.bundle');
  await writeFile(filename, bundle.data);

  const result = await target.importBundle(filename, 'device-one');
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.updated.includes('main'));
  assert.equal(await readFile(path.join(target.root, 'file.txt'), 'utf8'), 'hello');
  assert.equal(
    (await target.git(['rev-parse', 'main'])).stdout.trim(),
    (await source.git(['rev-parse', 'main'])).stdout.trim(),
  );
});

test('keeps divergent branches and exposes the remote snapshot for an explicit merge', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-diverge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await createRepository(path.join(root, 'source'), 'base');
  const target = await createRepository(path.join(root, 'target'));

  let bundle = await source.createBundle();
  let filename = path.join(root, 'first.bundle');
  await writeFile(filename, bundle.data);
  await target.importBundle(filename, 'device-one');
  await bundle.dispose();

  await commitFile(source, 'source.txt', 'source', 'source change');
  await commitFile(target, 'target.txt', 'target', 'target change');
  const localBefore = (await target.git(['rev-parse', 'main'])).stdout.trim();
  bundle = await source.createBundle();
  filename = path.join(root, 'second.bundle');
  await writeFile(filename, bundle.data);
  const result = await target.importBundle(filename, 'device-one');
  await bundle.dispose();

  assert.equal((await target.git(['rev-parse', 'main'])).stdout.trim(), localBefore);
  assert.deepEqual(result.conflicts.map(({ branch, reason }) => ({ branch, reason })), [
    { branch: 'main', reason: 'diverged' },
  ]);
  assert.ok((await target.git(['rev-parse', 'refs/remotes/pigeon/device-one/heads/main'])).stdout.trim());
});

test('checks out a non-main branch when cloning into an empty repository', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-trunk-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'source');
  const source = await createRepository(sourcePath);
  await source.git(['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  await commitFile(source, 'trunk.txt', 'trunk', 'trunk commit');
  const target = await createRepository(path.join(root, 'target'));
  const bundle = await source.createBundle();
  t.after(bundle.dispose);
  const filename = path.join(root, 'trunk.bundle');
  await writeFile(filename, bundle.data);

  await target.importBundle(filename, 'device-trunk');

  assert.equal((await target.git(['branch', '--show-current'])).stdout.trim(), 'trunk');
  assert.equal(await readFile(path.join(target.root, 'trunk.txt'), 'utf8'), 'trunk');
});
