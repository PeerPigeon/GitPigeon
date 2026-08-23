import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDashboardEnrollment } from '../src/dashboard-pairing.js';

test('the enrollment link carries no readable capability', () => {
  const index = { indexId: 'a'.repeat(32), secret: 'z'.repeat(43), publisherId: 'b'.repeat(32) };
  const enrollment = createDashboardEnrollment(index, 'https://gitpigeon.dev/');

  // A device on another network is handed this link, so the capability must not
  // be readable from it. The fragment is ciphertext and the code is required to
  // open it.
  assert.ok(!enrollment.url.includes(index.secret), 'the index secret must not appear in the link');
  assert.ok(!enrollment.url.includes(index.indexId), 'the index ID must not appear in the link');
  assert.match(enrollment.url, /#enroll=/);
  assert.match(enrollment.displayCode, /^[0-9]{3} [0-9]{3}$/);
});

test('pair always prints a link, without a flag', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const command = /async function commandPair\(args, verbose\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(command, 'commandPair should be present');

  // Local discovery and the link run together, so a device on another network
  // is never a separate mode the user has to know about.
  assert.match(command, /startPairingLink\(root, verbose, log\)/);
  assert.doesNotMatch(source, /commandPairLink/);
  assert.doesNotMatch(source, /takeFlag\(args, '--link'\)/);

  const server = /function startPairingLink\([\s\S]*?\n\}\n\n/.exec(source)?.[0] ?? '';
  assert.ok(server, 'startPairingLink should be present');
  // Nothing is opened locally; the device joining is elsewhere.
  assert.doesNotMatch(server, /openDashboard/);
  // A rotation invalidates the running service's secret.
  assert.match(server, /if \(pairing\.rotated\)/);
  assert.match(server, /stopWatchService\(root\)/);
  // The code must not travel with the link.
  assert.match(server, /send it by a different route than the link/);
});
