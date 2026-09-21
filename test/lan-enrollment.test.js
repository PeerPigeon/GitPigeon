import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDeviceEnrollmentRequest, loadOrCreateNativeDeviceIdentity } from '../src/device-grants.js';
import { startLanApprovalService } from '../src/lan-enrollment.js';

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeIndexSession() {
  const records = new Map();
  return {
    records,
    index: { indexId: 'a'.repeat(32) },
    node: {
      getConnectedPeers: () => [],
      storage: {
        put: async (_space, key, value) => { records.set(key, value); },
        get: async () => null,
        retrieve: async () => null,
        delete: async (_space, key) => { records.delete(key); },
        subscribeKey: () => () => {},
      },
    },
  };
}

function shout(port, value) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.send(Buffer.from(JSON.stringify(value)), port, '127.0.0.1', (error) => {
      socket.close();
      if (error) reject(error); else resolve();
    });
  });
}

test('whoever shares the Wi-Fi is not heard unless this machine is being paired', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-lan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stranger = await loadOrCreateNativeDeviceIdentity({ root });
  const session = fakeIndexSession();
  let open = false;
  const heard = [];
  const service = await startLanApprovalService(session, {
    port: 0,
    accepting: async () => open,
    onDeviceRequest: (request) => heard.push(request.deviceName),
  });
  t.after(() => service.close());

  // A cafe: someone on the same network asks to be enrolled. It used to be
  // taken, remembered, logged, and written into this fleet's encrypted index
  // for a dashboard to approve.
  const request = createDeviceEnrollmentRequest(stranger, { port: 40_000, deviceName: 'Someone-Elses-Laptop' });
  await shout(service.port, request);
  await settle();
  assert.deepEqual(heard, []);
  assert.deepEqual(service.pending(), []);
  assert.equal(session.records.size, 0, 'nothing reaches the index');

  // With a pairing window open on THIS machine, the same request is heard.
  open = true;
  await shout(service.port, request);
  await settle();
  assert.deepEqual(heard, ['Someone-Elses-Laptop']);
  assert.equal(service.pending().length, 1);
});
