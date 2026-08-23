import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('a first install leaves something listening rather than a deadline', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));
  const command = /async function commandInstall\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(command, 'commandInstall should be present');

  // Installing two machines and opening a browser a minute later answered
  // nothing, because pairing was only offered while this command was in the
  // foreground. The service listens instead, with no deadline.
  assert.match(command, /startWatchService\(\{ root, verbose \}\)/);
  assert.match(command, /keep offering/);
  assert.doesNotMatch(command, /grantToWaitingBrowser/);

  // It may instead be joining a setup that already exists, which only an
  // approved browser elsewhere can authorize — but the running service does
  // that, so this command waits for nothing and returns the prompt.
  assert.doesNotMatch(command, /requestLanDeviceApproval\(identity/);
  assert.doesNotMatch(command, /timeoutMs/);

  // The enrolment page asks the person to type a code; nothing here uses it.
  assert.doesNotMatch(command, /runDashboardPairing/);
  assert.doesNotMatch(command, /claimDashboardPairing/);
});

test('the watcher keeps offering to pair with no deadline', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));
  const service = /async function startPairingService\([\s\S]*?\n\}\n\n/.exec(source)?.[0] ?? '';
  assert.ok(service, 'startPairingService should be present');

  assert.doesNotMatch(service, /timeoutMs/);
  assert.doesNotMatch(service, /deadline/);
  // Every watcher offers to every browser that is not yet approved. Gating on
  // a stored "already paired" flag could leave a machine refusing to pair
  // forever while no browser actually held anything.
  assert.doesNotMatch(service, /if \(index\.pairingComplete\) return;/);
  assert.match(service, /completeDashboardPairing\(index, \{ root \}\)/);
  assert.match(source, /pairingService = await startPairingService\(root, log, \{/);
  // The machine reports what its index half is doing on every announcement,
  // so a watcher whose index node cannot reach anyone still says so through
  // the mesh it can reach.
  assert.match(source, /indexDiagnostics: \(\) => machineIndex\.diagnostics\(\)/);
});

test('joining an existing index is still possible on purpose', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const command = /async function commandInstall\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  // --enroll forces the join path even on a fresh machine.
  assert.match(command, /const enroll = takeFlag\(args, '--enroll'\)/);
  assert.match(command, /await commandEnroll\(\[\], verbose\)/);
});

test('init registers a repository without enrolling a browser', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));
  const command = /async function commandInit\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(command, 'commandInit should be present');

  // init ran the enrolment flow whenever pairingComplete was false, which asked
  // for a code as though an already-paired browser were new.
  assert.doesNotMatch(command, /runDashboardPairing/);
  assert.doesNotMatch(command, /claimDashboardPairing/);
  assert.match(command, /No browser is paired with this machine yet/);
});

test('a mesh pairing is recorded, so later commands know about it', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));

  // Nothing on the mesh path set pairingComplete, so it stayed false forever
  // and every later command behaved as though no browser had ever paired.
  const grants = source.split('completeDashboardPairing(index, { root })').length - 1;
  assert.ok(grants >= 2, `both pairing paths should record the pairing, found ${grants}`);
});

test('install prints the code the browser should be showing', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));
  const command = /async function commandInstall\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  const reporter = /async function reportPairingCode\([\s\S]*?\n\}\n\n/.exec(source)?.[0] ?? '';
  assert.ok(reporter, 'reportPairingCode should be present');

  // The code used to mix both peers' keys, so it did not exist until a browser
  // asked: install had nothing to print and held the terminal waiting instead.
  // The watcher owns its code now, so this reads it off disk and returns.
  assert.match(reporter, /localPairingCode\(root\)/);
  assert.match(reporter, /only if it shows the same code/);
  assert.doesNotMatch(reporter, /startDeviceApprovalResponder/);
  assert.doesNotMatch(reporter, /while \(/);

  const branches = command.split('reportPairingCode(').length - 1;
  assert.ok(branches >= 3, `every install path should report a code, found ${branches}`);
});

test('a rotated secret is adopted, not mistaken for already-joined', async () => {
  const source = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/cli.js', import.meta.url), 'utf8'));
  // Rotation keeps the index id. Deciding "nothing to do" on the id alone made
  // a machine left behind by a rotation drop the capability that would have
  // re-admitted it — approved in the browser, ignored on the machine.
  assert.match(source, /current\.indexId === capability\.index\.indexId\n\s*&& current\.secret === capability\.index\.secret\) return;/);

  const machineIndex = await import('node:fs/promises')
    .then(({ readFile }) => readFile(new URL('../src/machine-index.js', import.meta.url), 'utf8'));
  assert.match(machineIndex, /value\.entries\.length > 0 && value\.indexId !== indexId/);
});
