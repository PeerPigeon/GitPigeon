import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceHostName } from '../src/device-name.js';

test('macOS device names use the Bonjour LocalHostName', () => {
  assert.equal(deviceHostName({
    platform: 'darwin',
    fallback: 'Mac',
    readLocalHostName: () => 'Daniels-Mac-mini\n',
  }), 'Daniels-Mac-mini.local');
});

test('device names fall back to the OS hostname', () => {
  assert.equal(deviceHostName({
    platform: 'linux',
    fallback: 'build-host',
  }), 'build-host');
});
