import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createPairLink, isPairLink, parsePairLink } from '../src/pair-link.js';

const capability = {
  indexId: 'a'.repeat(32),
  secret: 'z'.repeat(43),
  publisherId: 'b'.repeat(32),
};

test('a pairing link round-trips the capability', () => {
  const link = createPairLink(capability);
  assert.match(link, /^gitpigeon:\/\/pair\//);
  assert.deepEqual(parsePairLink(link), capability);
  assert.equal(isPairLink(link), true);
  // Works without a publisher; the roster supplies it once connected.
  assert.equal(parsePairLink(createPairLink({ ...capability, publisherId: null })).publisherId, null);
});

test('the secret stays in the fragment', () => {
  const link = createPairLink(capability);
  const [beforeHash] = link.split('#');
  // Fragments are not sent to servers and stay out of request logs. This is a
  // bearer capability either way, so it must at least not travel in a path or
  // query the way an ordinary URL would.
  assert.ok(!beforeHash.includes(capability.secret), 'the secret must not be in the path or query');
  assert.ok(link.includes(`#${capability.secret}`));
});

test('a malformed or foreign link is refused', () => {
  assert.throws(() => parsePairLink('https://gitpigeon.dev/#enroll=abc'), /must use gitpigeon:\/\/pair/);
  assert.throws(() => parsePairLink('gitpigeon://sync/abc#def'), /must use gitpigeon:\/\/pair/);
  assert.throws(() => parsePairLink('gitpigeon://pair/short#' + 'z'.repeat(43)), /valid index ID/);
  assert.throws(() => parsePairLink(`gitpigeon://pair/${'a'.repeat(32)}#short`), /valid index secret/);
  assert.throws(() => parsePairLink('nonsense'), /Invalid GitPigeon pairing link/);
  assert.equal(isPairLink('gitpigeon://sync/abc#def'), false);
});

test('pair adopts a link and restarts the service on it', async () => {
  const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const command = /async function commandPairFromLink\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
  assert.ok(command, 'commandPairFromLink should be present');
  assert.match(command, /adoptMachineIndexCapability\(capability, \{ root \}\)/);
  // A service built against the previous index cannot be seen on the adopted
  // one, so it has to come back rather than keep running.
  assert.match(command, /stopWatchService\(root\)/);
  assert.match(command, /startWatchService\(\{ root, verbose \}\)/);
  assert.match(source, /if \(args\[0\] && isPairLink\(args\[0\]\)\)/);
});
