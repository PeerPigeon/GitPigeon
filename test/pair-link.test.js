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

test('pair --link prints the link instead of opening a browser', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const command = /async function commandPairLink\(args, verbose\) \{[\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(command, 'commandPairLink should be present');

  // There is nothing to open here: the device joining is elsewhere.
  assert.match(command, /open: false/);
  assert.doesNotMatch(command, /openDashboard/);
  // A rotation invalidates the running service's secret, so it has to restart
  // or the newly paired device will not find it.
  assert.match(command, /if \(pairing\.rotated\)/);
  assert.match(command, /stopWatchService\(root\)/);

  // The code must not travel with the link, and the browser-opening path is
  // skipped entirely in link mode.
  assert.match(source, /Send the code by a different route than the link/);
  assert.match(source, /if \(!open\) return;/);
});
