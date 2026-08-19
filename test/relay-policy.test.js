import assert from 'node:assert/strict';
import test from 'node:test';
import { productionSignalingServers } from '../src/relay-policy.js';

test('keeps automatic relay selection on production FreeRTC endpoints', () => {
  assert.deepEqual(productionSignalingServers([
    'wss://peer.ooo/ws',
    'wss://freertc-worker-dev.draeder.workers.dev/ws',
    'wss://decentralize.ooo/ws',
  ]), [
    'wss://peer.ooo/ws',
    'wss://decentralize.ooo/ws',
  ]);
});

test('does not erase an otherwise usable custom candidate list', () => {
  assert.deepEqual(productionSignalingServers([
    'wss://freertc-worker-dev.draeder.workers.dev/ws',
  ]), [
    'wss://freertc-worker-dev.draeder.workers.dev/ws',
  ]);
});
