import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LiveWorkspace } from '../src/live-workspace.js';
import { WorkspaceFiles } from '../src/workspace.js';
import { commitFile, createRepository } from './helpers.js';

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

test('automatically protects ignored files and conventional secrets while skipping generated directories', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-workspace-auto-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(path.join(root, 'repository'));
  await commitFile(
    repository,
    '.gitignore',
    ['private-settings.json', 'node_modules/', '.vinext/', '.wrangler/', '.gitpigeon-build/', '*.tsbuildinfo'].join(String.fromCharCode(10)) + String.fromCharCode(10),
    'ignore local files',
  );
  await writeFile(path.join(repository.root, '.env'), 'TOKEN=automatic\n');
  await writeFile(path.join(repository.root, '.env.example'), 'TOKEN=example\n');
  await writeFile(path.join(repository.root, 'private-settings.json'), '{"local":true}\n');
  await mkdir(path.join(repository.root, 'node_modules', 'example'), { recursive: true });
  await writeFile(path.join(repository.root, 'node_modules', 'example', 'config.json'), '{}\n');

  const generated = [
    ['.vinext', 'fonts', 'font.woff2'],
    ['.wrangler', 'tmp', 'deploy.js'],
    ['.gitpigeon-build', 'sea-config.json'],
  ];
  for (const parts of generated) {
    const filename = path.join(repository.root, ...parts);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, 'generated');
  }
  await writeFile(path.join(repository.root, 'tsconfig.tsbuildinfo'), 'generated');

  const workspace = new WorkspaceFiles(repository);
  await mkdir(path.dirname(workspace.trackedFile), { recursive: true });
  await writeFile(workspace.trackedFile, JSON.stringify({
    version: 1,
    files: [
      '.vinext/fonts/font.woff2',
      '.wrangler/tmp/deploy.js',
      '.gitpigeon-build/sea-config.json',
      'tsconfig.tsbuildinfo',
    ],
    excluded: [],
  }));
  await workspace.init();
  const snapshot = await workspace.snapshot();

  assert.deepEqual(await workspace.list(), ['.env', 'private-settings.json']);
  assert.deepEqual(snapshot.files.map(({ path: file }) => file), ['.env', 'private-settings.json']);
  assert.equal((await repository.git(['check-ignore', '.env'])).stdout.trim(), '.env');
  assert.equal(await repository.isTracked('.env.example'), false);
  const exclude = await readFile(path.join(repository.gitDir, 'info', 'exclude'), 'utf8');
  assert.doesNotMatch(exclude, /vinext|wrangler|gitpigeon-build|tsbuildinfo/);
  await assert.rejects(workspace.track(['tsconfig.tsbuildinfo']), /generated artifact/);

  await workspace.untrack(['.env']);
  await workspace.discover({ force: true });
  assert.deepEqual(await workspace.list(), ['private-settings.json']);
});

test('live synchronization excludes generated build artifacts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-live-generated-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(path.join(root, 'repository'));
  const generated = [
    ['.vinext', 'output.js'],
    ['.wrangler', 'output.js'],
    ['.gitpigeon-build', 'output.js'],
  ];
  for (const parts of generated) {
    const filename = path.join(repository.root, ...parts);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, 'generated');
  }
  await writeFile(path.join(repository.root, 'tsconfig.tsbuildinfo'), 'generated');
  await writeFile(path.join(repository.root, 'app.js'), 'source');

  const snapshot = await new LiveWorkspace(repository).snapshot();
  assert.deepEqual(snapshot.files.map(({ path: file }) => file), ['app.js']);
});
