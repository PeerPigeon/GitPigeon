import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryRoomTopology } from '../src/constants.js';

test('native repository peers retain every member of a small room', () => {
  assert.deepEqual(repositoryRoomTopology(), { minPeers: 32, maxPeers: 32 });
});
