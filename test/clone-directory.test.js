import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cloneDirectory, defaultCloneDirectory, readSettings, setCloneDirectory } from '../src/clone-directory.js';

test('the clone directory is a machine setting every cloning path reads', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-clone-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = {};

  assert.equal(await cloneDirectory({ root, environment }), defaultCloneDirectory(environment));
  assert.match(defaultCloneDirectory(environment), /Documents[\\/]GitPigeon$/);
  assert.equal(defaultCloneDirectory({ GITPIGEON_CLONE_DIR: '/tmp/elsewhere' }), path.resolve('/tmp/elsewhere'));

  const drive = path.join(root, 'drive', 'GitPigeon');
  assert.equal(await setCloneDirectory(drive, { root }), drive);
  assert.ok((await stat(drive)).isDirectory(), 'the stated directory exists after stating it');
  assert.equal(await cloneDirectory({ root, environment }), drive);
  // The stated directory wins over the environment: it is what the person
  // said, and it reaches processes no environment variable does.
  assert.equal(await cloneDirectory({ root, environment: { GITPIGEON_CLONE_DIR: '/tmp/elsewhere' } }), drive);
  const settings = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(settings.cloneDirectory, drive);

  assert.equal(await setCloneDirectory(null, { root }), null);
  assert.deepEqual(await readSettings({ root }), {});
  assert.equal(await cloneDirectory({ root, environment }), defaultCloneDirectory(environment));

  await assert.rejects(setCloneDirectory('', { root }), /folder path/);
});
