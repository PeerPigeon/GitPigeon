import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// How a mesh forms — peer counts, tolerance, discovery — is PeerPigeon's
// decision alone. GitPigeon capping rooms at five peers with zero tolerance
// left no slack for ghost entries from restarted services: dead peers held
// slots while live negotiations were shed, and the mesh stalled.
test('GitPigeon makes no peer-formation decisions', async () => {
  for (const file of ['peerpigeon.js', 'machine-index.js', 'device-approval-mesh.js', 'dashboard-pairing.js', 'constants.js']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const option of ['minPeers', 'maxPeers', 'tolerantPeers', 'autoDiscover', 'autoConnect']) {
      assert.ok(!source.includes(`${option}:`), `${file} must not set ${option}`);
    }
  }
});
