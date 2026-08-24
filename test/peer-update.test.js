import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PEER_UPDATE_PROTOCOL, startPeerUpdates } from '../src/peer-update.js';

class FakeNode extends EventEmitter {
  constructor() {
    super();
    this.broadcasts = [];
    this.direct = [];
  }

  broadcast(value) { this.broadcasts.push(value); }
  async sendEncryptedDirect(peerId, plaintext) { this.direct.push({ peerId, value: JSON.parse(plaintext) }); }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test('a watcher offers its build and a peer pulls, verifies and installs it', async (t) => {
  const offererRoot = await mkdtemp(path.join(tmpdir(), 'gitpigeon-peer-a-'));
  const fetcherRoot = await mkdtemp(path.join(tmpdir(), 'gitpigeon-peer-b-'));
  t.after(() => Promise.all([
    rm(offererRoot, { recursive: true, force: true }),
    rm(fetcherRoot, { recursive: true, force: true }),
  ]));

  // A stand-in executable: a script that survives the `--help` verification.
  const executable = path.join(offererRoot, 'git-pigeon');
  await writeFile(executable, `#!/bin/sh\nexit 0\n${randomBytes(300 * 1024).toString('hex')}\n`, { mode: 0o755 });
  const expected = createHash('sha256').update(await readFile(executable)).digest('hex');

  const offererNode = new FakeNode();
  const fetcherNode = new FakeNode();
  const offerer = startPeerUpdates({
    node: offererNode,
    root: offererRoot,
    currentVersion: '9.9.9',
    executable,
    standalone: true,
    platform: 'darwin',
    arch: 'arm64',
  });
  let installed = null;
  const fetcher = startPeerUpdates({
    node: fetcherNode,
    root: fetcherRoot,
    currentVersion: '1.0.0',
    standalone: true,
    platform: 'darwin',
    arch: 'arm64',
    onUpdate: (update) => { installed = update; },
  });
  t.after(() => Promise.all([offerer.stop(), fetcher.stop()]));
  await settle();

  // The offer travels the encrypted index room as a broadcast.
  const offer = offererNode.broadcasts.find((value) => value?.kind === 'offer');
  assert.ok(offer, 'the newer watcher should offer its build');
  assert.equal(offer.protocol, PEER_UPDATE_PROTOCOL);
  assert.equal(offer.version, '9.9.9');
  assert.equal(offer.sha256, expected);

  // Bridge the two fakes: fetch requests reach the offerer, chunks return.
  let hops = 0;
  const pump = async () => {
    for (;;) {
      const request = fetcherNode.direct.shift();
      if (request) {
        hops += 1;
        offererNode.emit('message', { local: false, encrypted: true, fromPeerId: 'fetcher', data: JSON.stringify(request.value) });
        await settle();
        continue;
      }
      const chunk = offererNode.direct.shift();
      if (chunk) {
        fetcherNode.emit('message', { local: false, encrypted: true, fromPeerId: 'offerer', data: JSON.stringify(chunk.value) });
        await settle();
        continue;
      }
      return;
    }
  };

  fetcherNode.emit('message', { local: false, encrypted: true, fromPeerId: 'offerer', data: JSON.stringify(offer) });
  await settle();
  await pump();
  // Digesting and verifying the assembled executable is asynchronous; wait
  // for the install rather than racing it.
  for (let i = 0; i < 200 && !installed; i += 1) {
    await pump();
    await settle();
  }

  assert.ok(installed, 'the older watcher should install the peer build');
  assert.equal(installed.version, '9.9.9');
  assert.ok(hops > 1, 'the executable should transfer in multiple chunks');
  const record = JSON.parse(await readFile(path.join(fetcherRoot, 'updates', 'current.json'), 'utf8'));
  assert.equal(record.releaseVersion, '9.9.9');
  assert.equal(record.channel, 'peer');
  assert.equal(record.sha256, expected);
  const data = await readFile(record.executable);
  assert.equal(createHash('sha256').update(data).digest('hex'), expected);

  // An equal-or-older offer is ignored entirely.
  const before = fetcherNode.direct.length;
  fetcherNode.emit('message', { local: false, encrypted: true, fromPeerId: 'offerer', data: JSON.stringify({ ...offer, version: '1.0.0' }) });
  await settle();
  assert.equal(fetcherNode.direct.length, before);
});

test('a dropped chunk is re-requested instead of wedging the fetch', async (t) => {
  const offererRoot = await mkdtemp(path.join(tmpdir(), 'gitpigeon-drop-a-'));
  const fetcherRoot = await mkdtemp(path.join(tmpdir(), 'gitpigeon-drop-b-'));
  t.after(() => Promise.all([
    rm(offererRoot, { recursive: true, force: true }),
    rm(fetcherRoot, { recursive: true, force: true }),
  ]));
  const executable = path.join(offererRoot, 'git-pigeon');
  await writeFile(executable, `#!/bin/sh\nexit 0\n${randomBytes(400 * 1024).toString('hex')}\n`, { mode: 0o755 });

  const offererNode = new FakeNode();
  const fetcherNode = new FakeNode();
  const offerer = startPeerUpdates({
    node: offererNode, root: offererRoot, currentVersion: '9.9.9',
    executable, standalone: true, platform: 'darwin', arch: 'arm64',
  });
  let installed = null;
  const fetcher = startPeerUpdates({
    node: fetcherNode, root: fetcherRoot, currentVersion: '1.0.0',
    standalone: true, platform: 'darwin', arch: 'arm64',
    onUpdate: (update) => { installed = update; },
  });
  t.after(() => Promise.all([offerer.stop(), fetcher.stop()]));
  await settle();
  const offer = offererNode.broadcasts.find((value) => value?.kind === 'offer');
  fetcherNode.emit('message', { local: false, encrypted: true, fromPeerId: 'offerer', data: JSON.stringify(offer) });
  await settle();

  // DROP the first request outright — the wedge case: nothing arrives, so the
  // old code never asked again and the machine-wide flag stayed locked.
  const dropped = fetcherNode.direct.shift();
  assert.ok(dropped, 'a first chunk request was sent');

  // The retry timer must re-ask within a few seconds; bridge everything from
  // then on.
  const until = Date.now() + 15_000;
  while (Date.now() < until && !installed) {
    const request = fetcherNode.direct.shift();
    if (request) {
      offererNode.emit('message', { local: false, encrypted: true, fromPeerId: 'fetcher', data: JSON.stringify(request.value) });
      await settle();
      continue;
    }
    const chunk = offererNode.direct.shift();
    if (chunk) {
      fetcherNode.emit('message', { local: false, encrypted: true, fromPeerId: 'offerer', data: JSON.stringify(chunk.value) });
      await settle();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(installed, 'the fetch recovered from the dropped request');
  assert.equal(installed.version, '9.9.9');
});
