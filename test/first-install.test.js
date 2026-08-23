import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('a first install owns the index instead of waiting to be approved', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const command = /async function commandInstall\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(command, 'commandInstall should be present');

  // With no index of its own this machine is the first device. Sending it to
  // enroll deadlocked a new user: it waited for an already-approved browser
  // while the only open browser waited for this machine.
  assert.match(command, /if \(!enroll && unconfigured\)/);
  // An abandoned or half-finished setup leaves a state file behind, and that
  // machine is still unconfigured, so the absence of a file is not the test.
  assert.match(command, /!existing\.pairingComplete && \(existing\.entries\?\.length \?\? 0\) === 0/);
  assert.match(command, /claimDashboardPairing\(\{ root, force: true \}\)/);
  assert.match(command, /runDashboardPairing\(pairing, verbose\)/);

  // The deadlocking path must come after that check, and only for a machine
  // that is deliberately joining an existing index.
  const firstInstall = command.indexOf('if (!enroll && unconfigured)');
  const enrollCall = command.lastIndexOf('await commandEnroll([], verbose)');
  assert.ok(firstInstall !== -1 && enrollCall !== -1 && firstInstall < enrollCall);
});

test('joining an existing index is still possible on purpose', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const command = /async function commandInstall\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  // --enroll forces the join path even on a fresh machine.
  assert.match(command, /const enroll = takeFlag\(args, '--enroll'\)/);
  assert.match(command, /await commandEnroll\(\[\], verbose\)/);
});
