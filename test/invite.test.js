import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvite, parseInvite } from '../src/invite.js';

test('invite round-trips repository, secret, and signaling server', () => {
  const source = {
    repositoryId: 'abcdef0123456789',
    secret: 'abcdefghijklmnopqrstuvwxyz_1234567890-ABCDE',
    signalingServer: 'wss://relay.example.test/ws?region=us',
  };
  assert.deepEqual(parseInvite(createInvite(source)), source);
});

test('invite rejects non-WebSocket signaling servers', () => {
  assert.throws(
    () => parseInvite('gitpigeon://sync/abcdef0123456789?signal=https%3A%2F%2Fexample.test#abcdefghijklmnopqrstuvwxyz_123456'),
    /ws:\/\/ or wss:\/\//,
  );
});

