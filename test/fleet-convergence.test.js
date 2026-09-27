import assert from 'node:assert/strict';
import test from 'node:test';
import { preferredFleetIndex, secretFingerprint, shouldOfferIndexToPeer } from '../src/fleet-convergence.js';

const at = (iso) => new Date(iso).toISOString();

test('a secret is named by a fingerprint that is not usable as one', () => {
  const fingerprint = secretFingerprint('ZmxlZXQtc2VjcmV0LXZhbHVl');
  assert.match(fingerprint, /^[0-9a-f]{32}$/);
  assert.equal(fingerprint, secretFingerprint('ZmxlZXQtc2VjcmV0LXZhbHVl'));
  assert.notEqual(fingerprint, secretFingerprint('ZmxlZXQtc2VjcmV0LXZhbHVm'));
  assert.doesNotMatch(fingerprint, /ZmxlZXQ/);
  assert.equal(secretFingerprint(null), null);
});

test('the secret a browser is paired with wins, so a dashboard is never taken away', () => {
  const local = {
    indexId: 'f00ab7ea24fe377da70fc7148bfdd047',
    secretFingerprint: secretFingerprint('pro-secret'),
    secretSetAt: at('2026-09-21T02:00:00Z'),
    pairingComplete: true,
    entries: 14,
  };
  const remote = {
    indexId: 'f00ab7ea24fe377da70fc7148bfdd047',
    // Newer, and it still loses: someone is sitting at the paired dashboard.
    secretFingerprint: secretFingerprint('air-secret'),
    secretSetAt: at('2026-09-27T01:44:00Z'),
    pairingComplete: false,
    entries: 14,
  };
  assert.equal(preferredFleetIndex(local, remote).winner, 'local');
  assert.equal(preferredFleetIndex(local, remote).reason, 'browser-paired-here');
  // And the mirror: the same two facts, read from the other machine.
  assert.equal(preferredFleetIndex(remote, local).winner, 'remote');
  assert.equal(shouldOfferIndexToPeer(local, remote), true);
  assert.equal(shouldOfferIndexToPeer(remote, local), false);
});

test('otherwise the newer secret wins, and a tie is still decided the same way on both machines', () => {
  const base = { indexId: 'a'.repeat(32), pairingComplete: false, entries: 3 };
  const older = { ...base, secretFingerprint: secretFingerprint('one'), secretSetAt: at('2026-09-01T00:00:00Z') };
  const newer = { ...base, secretFingerprint: secretFingerprint('two'), secretSetAt: at('2026-09-20T00:00:00Z') };
  assert.equal(preferredFleetIndex(older, newer).winner, 'remote');
  assert.equal(preferredFleetIndex(newer, older).winner, 'local');

  // No times stated at all: the order must still be total, and opposite from
  // the two sides, or the machines would hand each other secrets forever.
  const left = { ...base, secretFingerprint: secretFingerprint('left') };
  const right = { ...base, secretFingerprint: secretFingerprint('right') };
  const fromLeft = preferredFleetIndex(left, right);
  const fromRight = preferredFleetIndex(right, left);
  assert.equal(fromLeft.reason, 'tie-break');
  assert.notEqual(fromLeft.winner, fromRight.winner);
  assert.equal(shouldOfferIndexToPeer(left, right) !== shouldOfferIndexToPeer(right, left), true);
});

test('the same secret is nothing to converge, and neither is a fleet this machine is not in', () => {
  const index = {
    indexId: 'b'.repeat(32),
    secretFingerprint: secretFingerprint('shared'),
    secretSetAt: at('2026-09-20T00:00:00Z'),
    pairingComplete: true,
    entries: 2,
  };
  assert.equal(preferredFleetIndex(index, { ...index }).reason, 'same-secret');
  assert.equal(shouldOfferIndexToPeer(index, { ...index }), false);

  // A different index id with repositories here is a different fleet: stay
  // put, the same refusal adoptMachineIndexCapability makes.
  const stranger = { ...index, indexId: 'c'.repeat(32), secretFingerprint: secretFingerprint('theirs') };
  assert.equal(preferredFleetIndex(index, stranger).reason, 'different-index');
  assert.equal(shouldOfferIndexToPeer(index, stranger), false);

  // A machine with nothing registered can still join one.
  const fresh = { ...index, indexId: 'd'.repeat(32), secretFingerprint: secretFingerprint('fresh'), entries: 0 };
  assert.equal(preferredFleetIndex(fresh, index).reason, 'joining-index');
  assert.equal(preferredFleetIndex(fresh, index).winner, 'remote');
  assert.equal(shouldOfferIndexToPeer(index, fresh), true);
});

test('an announcement with nothing in it decides nothing', () => {
  const index = { indexId: 'e'.repeat(32), secretFingerprint: secretFingerprint('mine'), entries: 1 };
  assert.equal(preferredFleetIndex(index, null).winner, 'local');
  assert.equal(preferredFleetIndex(index, { indexId: 'e'.repeat(32) }).reason, 'no-remote');
  assert.equal(shouldOfferIndexToPeer(index, {}), false);
  assert.equal(preferredFleetIndex(null, index).winner, 'remote');
});
