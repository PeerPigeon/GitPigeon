import assert from 'node:assert/strict';
import test from 'node:test';

test('a path shielded by a live session is never a retraction target', async (t) => {
  const { mkdtemp, rm, writeFile, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { GitRepository } = await import('../src/git.js');
  const { LiveWorkspace } = await import('../src/live-workspace.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-owned-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await GitRepository.init(root);
  const live = new LiveWorkspace(repository);
  await live.init();
  await writeFile(path.join(root, 'owned.md'), 'being edited right now\n');

  // The realtime session owns owned.md, so the overlay filter removed it
  // from the incoming set — and prepare() read that absence as a remote
  // retraction. With no HEAD copy, retraction is deletion: the sync deleted
  // the very file the session was editing, on every machine.
  const baselines = { 'owned.md': 'someoldbaselinedigestvalue' };
  const snapshot = await live.snapshot();
  const current = snapshot.files.find((file) => file.path === 'owned.md');
  baselines['owned.md'] = current.sha256;

  await live.prepare([], baselines, { except: new Set(['owned.md']) });
  const details = await stat(path.join(root, 'owned.md'));
  assert.ok(details.isFile(), 'the owned file must survive');

  // Without the shield the same call retracts it — but retraction is now
  // quarantine, never deletion: the file leaves the working tree and lands
  // in the trash, restorable.
  await live.prepare([], baselines, {});
  let gone = false;
  try { await stat(path.join(root, 'owned.md')); } catch { gone = true; }
  assert.equal(gone, true, 'unshielded retraction removes it from the working tree');
  const trash = await live.trashSnapshot();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].path, 'owned.md');
  assert.equal(Buffer.from(trash[0].data).toString(), 'being edited right now\n');

  // And it comes back.
  const restored = await live.restoreFromTrash('owned.md');
  assert.equal(restored.restoredTo, 'owned.md');
  assert.ok((await stat(path.join(root, 'owned.md'))).isFile());
});

test('a peer cannot grow node_modules, dist or a build tree through live sync', async (t) => {
  const { mkdtemp, rm, readFile, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { GitRepository } = await import('../src/git.js');
  const { LiveWorkspace } = await import('../src/live-workspace.js');
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-generated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await GitRepository.init(root);
  const live = new LiveWorkspace(repository);
  await live.init();
  const incoming = (file, text) => ({
    path: file, deleted: false, size: text.length, baseSha256: null, executable: false,
    sha256: createHash('sha256').update(text).digest('hex'), data: Buffer.from(text),
  });
  const baselines = {};
  const result = await live.apply([
    incoming('node_modules/pkg/index.js', 'module.exports = 1;\n'),
    incoming('packages/web/dist/bundle.js', 'built\n'),
    incoming('target/debug/app', 'binary\n'),
    incoming('src/app.js', 'export {};\n'),
  ], baselines, 'peer');
  assert.deepEqual(result, { updated: ['src/app.js'], conflicts: [] });
  assert.equal(await readFile(path.join(root, 'src', 'app.js'), 'utf8'), 'export {};\n');
  for (const missing of ['node_modules', 'packages', 'target']) {
    await assert.rejects(stat(path.join(root, missing)), { code: 'ENOENT' }, missing);
  }
  assert.deepEqual(Object.keys(baselines), ['src/app.js']);
  assert.equal(live.isGenerated('node_modules/pkg/index.js'), true);
  assert.equal(live.isGenerated('src/app.js'), false);
});
