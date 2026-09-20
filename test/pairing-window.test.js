import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PAIRING_MAX_FAILURES,
  PAIRING_WINDOW_MS,
  closePairingWindow,
  normalizePairingPhrase,
  openPairingWindow,
  pairingProof,
  pairingWindowOpen,
  verifyPairingProof,
} from '../src/pairing-identity.js';

async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-pairing-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('the index capability leaves a machine only while someone at it has opened a pairing window', async (t) => {
  const root = await scratch(t);
  // The default is shut. A browser announcing itself on the public approval
  // mesh is not a reason to hand it the index secret.
  assert.equal(await pairingWindowOpen(root), false);

  const now = 1_800_000_000_000;
  const { phrase } = await openPairingWindow(root, { now });
  assert.match(phrase, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(await pairingWindowOpen(root, now + 1_000), true);
  assert.equal(await pairingWindowOpen(root, now + PAIRING_WINDOW_MS + 1), false, 'it shuts on its own');
  assert.equal((await stat(path.join(root, 'pairing-window.json'))).mode & 0o077, 0, 'only this user can read the phrase');

  await closePairingWindow(root);
  assert.equal(await pairingWindowOpen(root, now + 1_000), false);

  // A hand-edited file cannot hold the door open for a year, and a garbled
  // one is shut, not open.
  await writeFile(path.join(root, 'pairing-window.json'), JSON.stringify({ until: new Date(now + 365 * 24 * 60 * 60_000).toISOString(), phrase }));
  assert.equal(await pairingWindowOpen(root, now), false);
  await writeFile(path.join(root, 'pairing-window.json'), 'not json');
  assert.equal(await pairingWindowOpen(root, now), false);
});

test('an open window is not enough: the request must prove the phrase, bound to its own key', async (t) => {
  const root = await scratch(t);
  const now = 1_800_000_000_000;
  const { phrase } = await openPairingWindow(root, { now });
  const mine = { requestId: 'a'.repeat(32), epub: 'my-browser-epub' };
  const proof = pairingProof(phrase, mine);

  assert.equal(await verifyPairingProof(root, { ...mine, proof }, now + 1), true);
  // Typed by a person: case, spaces and dashes do not matter.
  assert.equal(pairingProof(` ${phrase.toLowerCase().replaceAll('-', ' ')} `, mine), proof);
  assert.equal(normalizePairingPhrase('abcd-efgh jkmn'), 'ABCDEFGHJKMN');

  // A proof copied off the mesh is worth nothing to anyone else: it does not
  // fit another key or another request.
  assert.equal(await verifyPairingProof(root, { requestId: mine.requestId, epub: 'attacker-epub', proof }, now + 2), false);
  assert.equal(await verifyPairingProof(root, { requestId: 'b'.repeat(32), epub: mine.epub, proof }, now + 3), false);
  // No proof, or no key to seal to, is not a request for this machine.
  assert.equal(await verifyPairingProof(root, { ...mine }, now + 4), false);
  assert.equal(await verifyPairingProof(root, { requestId: mine.requestId, proof }, now + 5), false);
  // And never after the window.
  assert.equal(await verifyPairingProof(root, { ...mine, proof }, now + PAIRING_WINDOW_MS + 1), false);
});

test('wrong phrases shut the window: it cannot be searched online', async (t) => {
  const root = await scratch(t);
  const now = 1_800_000_000_000;
  const { phrase } = await openPairingWindow(root, { now });
  const request = { requestId: 'c'.repeat(32), epub: 'someone' };
  for (let attempt = 0; attempt < PAIRING_MAX_FAILURES; attempt += 1) {
    assert.equal(await pairingWindowOpen(root, now + attempt), true);
    assert.equal(await verifyPairingProof(root, { ...request, proof: pairingProof('AAAA-AAAA-AAAA', request) }, now + attempt), false);
  }
  assert.equal(await pairingWindowOpen(root, now + 10), false, 'shut after the last wrong guess');
  assert.equal(await verifyPairingProof(root, { ...request, proof: pairingProof(phrase, request) }, now + 11), false, 'even the right phrase is too late');
});

test('the background service checks the window and the proof before any capability moves, in either direction', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const service = source.slice(source.indexOf('async function startPairingService'), source.indexOf('async function runWatchService'));
  const grant = service.indexOf('responder.approve(');
  assert.ok(service.indexOf('pairingWindowOpen(root)') !== -1 && service.indexOf('pairingWindowOpen(root)') < grant);
  assert.ok(service.indexOf('verifyPairingProof(root, request)') !== -1 && service.indexOf('verifyPairingProof(root, request)') < grant);
  // Inbound: a machine joins an index only while its own window is open.
  const adopt = service.slice(service.indexOf('const adopt = async'), service.indexOf('const responder ='));
  assert.ok(adopt.indexOf('pairingWindowOpen(root)') !== -1 && adopt.indexOf('pairingWindowOpen(root)') < adopt.indexOf('adoptMachineIndexCapability('));
  assert.doesNotMatch(service, /Every watcher offers to every browser/);
  // The capability is sealed to the proven key, never sent to whoever relayed the request.
  const mesh = await readFile(new URL('../src/device-approval-mesh.js', import.meta.url), 'utf8');
  const approve = mesh.slice(mesh.indexOf('async approve('), mesh.indexOf('async close('));
  assert.doesNotMatch(approve, /sendEncryptedDirect\(record\.peerId, grant\)/);
});
