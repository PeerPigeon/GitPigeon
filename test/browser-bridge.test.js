import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  listBrowserBridgeRegistrations,
  registerBrowserBridge,
  startBrowserBridgeService,
} from '../src/browser-bridge.js';
import { createIdentity } from '../src/config.js';
import { createRepository } from './helpers.js';

test('browser bridge indexes every local watcher without a browser invite', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-browser-bridge-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstRepository = await createRepository(path.join(root, 'alpha'));
  const secondRepository = await createRepository(path.join(root, 'beta'));
  const token = 'b'.repeat(64);
  const firstConfig = createIdentity({
    repositoryId: 'alpha-pigeon',
    secret: 'a'.repeat(64),
    deviceId: 'alpha-device',
  });
  const secondConfig = createIdentity({
    repositoryId: 'beta-pigeon',
    secret: 'b'.repeat(64),
    deviceId: 'beta-device',
  });
  const service = await startBrowserBridgeService({ port: 0, token });
  const first = await registerBrowserBridge(firstRepository, firstConfig, {
    port: service.port,
    token,
    ensureService: false,
  });
  const second = await registerBrowserBridge(secondRepository, secondConfig, {
    port: service.port,
    token,
    ensureService: false,
  });
  t.after(async () => {
    await second.close();
    await first.close();
    await service.close();
  });

  assert.equal(first.owner, false);
  assert.equal(second.owner, false);
  assert.deepEqual(
    (await listBrowserBridgeRegistrations({ port: first.port, token })).map(({ repositoryId, repository, pid }) => ({ repositoryId, repository, pid })),
    [
      { repositoryId: 'alpha-pigeon', repository: firstRepository.root, pid: process.pid },
      { repositoryId: 'beta-pigeon', repository: secondRepository.root, pid: process.pid },
    ],
  );
  const endpoint = `http://127.0.0.1:${first.port}/v1/pigeons`;
  const response = await fetch(endpoint, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    version: 1,
    pigeons: [
      {
        repositoryId: 'alpha-pigeon',
        secret: 'a'.repeat(64),
        name: 'alpha',
        watcherCount: 1,
      },
      {
        repositoryId: 'beta-pigeon',
        secret: 'b'.repeat(64),
        name: 'beta',
        watcherCount: 1,
      },
    ],
  });
  assert.equal((await fetch(endpoint, { headers: { Origin: 'https://malicious.example' } })).status, 403);

  await second.close();
  const afterClose = await fetch(endpoint, { headers: { Origin: 'http://localhost:3000' } });
  assert.deepEqual((await afterClose.json()).pigeons.map((pigeon) => pigeon.repositoryId), ['alpha-pigeon']);
  assert.deepEqual(
    (await listBrowserBridgeRegistrations({ port: first.port, token })).map(({ repositoryId }) => repositoryId),
    ['alpha-pigeon'],
  );

  await first.close();
  const empty = await fetch(endpoint, { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { version: 1, pigeons: [] });
});
