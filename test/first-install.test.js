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
  assert.match(command, /grantToWaitingBrowser\(root, verbose/);

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

test('a first install never asks anyone to type a code', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));
  const command = /async function commandInstall\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';

  // The enrolment-link page asks the person to type a code. The person is
  // looking at a browser that is already announcing itself, so the watcher
  // grants to it and the browser confirms the code instead.
  assert.match(command, /grantToWaitingBrowser\(root, verbose/);
  assert.doesNotMatch(command, /runDashboardPairing/);
  assert.doesNotMatch(command, /claimDashboardPairing/);

  // An unconfigured machine cannot tell whether it is the first device or one
  // joining an existing setup, so it does both and takes whichever answers.
  // Without announcing, a second machine would quietly start its own index
  // instead of joining, and no approved browser would ever prompt.
  assert.match(command, /requestLanDeviceApproval\(identity/);
  assert.match(command, /adoptMachineIndexCapability\(grant\.index, \{ root \}\)/);
  assert.match(command, /Promise\.race/);

  const helper = /async function grantToWaitingBrowser\([\s\S]*?\n\}\n\n/.exec(source)?.[0] ?? '';
  assert.ok(helper, 'grantToWaitingBrowser should be present');
  // Joining the mesh takes far longer than a few seconds; a short timeout is
  // what made this fall through to the code prompt.
  assert.match(helper, /openAfterMs = 15_000/);
  assert.match(helper, /timeoutMs = 5 \* 60_000/);
  // If it does open a page it is the plain one, which announces itself.
  assert.doesNotMatch(helper, /enrollment\.url/);
  assert.match(helper, /once it shows this code/);
});
