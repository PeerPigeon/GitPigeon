import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PAIRING_WINDOW_MS, closePairingWindow, openPairingWindow, pairingWindowOpen } from '../src/pairing-identity.js';

test('the index capability leaves a machine only while someone at it has opened a pairing window', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-pairing-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // The default is shut. A browser announcing itself on the public approval
  // mesh is not a reason to hand it the index secret.
  assert.equal(await pairingWindowOpen(root), false);

  const now = 1_800_000_000_000;
  await openPairingWindow(root, { now });
  assert.equal(await pairingWindowOpen(root, now + 1_000), true);
  assert.equal(await pairingWindowOpen(root, now + PAIRING_WINDOW_MS - 1), true);
  assert.equal(await pairingWindowOpen(root, now + PAIRING_WINDOW_MS + 1), false, 'it shuts on its own');
  assert.equal((await stat(path.join(root, 'pairing-window.json'))).mode & 0o077, 0, 'only this user can open it');

  // One window, one browser.
  await closePairingWindow(root);
  assert.equal(await pairingWindowOpen(root, now + 1_000), false);

  // A hand-edited file cannot hold the door open for a year, and a garbled
  // one is shut, not open.
  await writeFile(path.join(root, 'pairing-window.json'), JSON.stringify({ until: new Date(now + 365 * 24 * 60 * 60_000).toISOString() }));
  assert.equal(await pairingWindowOpen(root, now), false);
  await writeFile(path.join(root, 'pairing-window.json'), 'not json');
  assert.equal(await pairingWindowOpen(root, now), false);
});

test('the background service consults the window before it answers any browser', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const tick = source.slice(source.indexOf('async function startPairingService'), source.indexOf('async function runWatchService'));
  const gate = tick.indexOf('pairingWindowOpen(root)');
  const grant = tick.indexOf('responder.approve(');
  assert.ok(gate !== -1 && grant !== -1 && gate < grant, 'the window is checked before the capability is sent');
  assert.doesNotMatch(tick, /Every watcher offers to every browser/);
});
