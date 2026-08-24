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

  // Without the shield the same call deletes it — the regression this guards.
  await live.prepare([], baselines, {});
  let gone = false;
  try { await stat(path.join(root, 'owned.md')); } catch { gone = true; }
  assert.equal(gone, true, 'unshielded retraction removes it (the old behavior)');
});
