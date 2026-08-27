import assert from 'node:assert/strict';
import test from 'node:test';
import { IpfsMirrorClient, S3MirrorClient, mirrorObjectKey, startShareMirror } from '../src/mirror.js';

const jsonResponse = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });

test('the S3 client signs path-style puts against any endpoint', async () => {
  const calls = [];
  const client = new S3MirrorClient({
    endpoint: 'https://s3.example.com',
    bucket: 'pigeons',
    prefix: 'shares',
    accessKeyId: 'AKIA_TEST',
    secretAccessKey: 'secret',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, text: async () => '' }; },
  });
  await client.put('gitpigeon-mirror/v1/repo/public/key.json', '{"cipher":1}');
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.ok(url.startsWith('https://s3.example.com/pigeons/shares/gitpigeon-mirror/'));
  assert.equal(options.method, 'PUT');
  assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\//);
  assert.equal(options.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');
});

test('the IPFS client writes MFS records and publishes the root once per burst', async () => {
  const calls = [];
  const client = new IpfsMirrorClient({
    apiUrl: 'https://node.example.com',
    authorization: 'Bearer token',
    gateway: 'https://gateway.example.com',
    publishDebounceMs: 10,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      if (url.includes('files/stat')) return jsonResponse({ Hash: 'bafyroot' });
      if (url.includes('/id')) return jsonResponse({ ID: '12D3KooTest' });
      return jsonResponse({});
    },
  });
  assert.equal(await client.publicBase(), 'https://gateway.example.com/ipns/12D3KooTest');
  await client.put('gitpigeon-mirror/v1/repo/public/a.json', '{"cipher":1}');
  await client.put('gitpigeon-mirror/v1/repo/public/b.json', '{"cipher":2}');
  await client.flushPublish();
  const writes = calls.filter(({ url }) => url.pathname === '/api/v0/files/write');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].url.searchParams.get('arg'), '/gitpigeon-mirror/v1/repo/public/a.json');
  assert.equal(writes[0].url.searchParams.get('create'), 'true');
  assert.equal(writes[0].options.headers.authorization, 'Bearer token');
  // One publish for the burst, pointed at the root the node reported.
  const publishes = calls.filter(({ url }) => url.pathname === '/api/v0/name/publish');
  assert.equal(publishes.length, 1);
  assert.equal(publishes[0].url.searchParams.get('arg'), '/ipfs/bafyroot');
});

test('the mirror follows local writes, seeds the current set, and ignores remote records', async () => {
  const records = new Map([
    ['public gitpigeon/v1/repo1234/registry', { value: { devices: ['device01'] } }],
    ['public gitpigeon/v1/repo1234/head/device01', { value: { snapshotId: 'a'.repeat(64) } }],
    ['public gitpigeon/v1/repo1234/presence/device01', { value: {} }],
    [`frozen gitpigeon/v1/repo1234/manifest/${'a'.repeat(64)}`, { value: { chunks: [{ sha256: 'b'.repeat(64) }] } }],
    [`frozen gitpigeon/v1/repo1234/chunk/${'b'.repeat(64)}`, { value: { data: 'x' } }],
  ]);
  let listener = null;
  const node = {
    crypto: { encryptRoom: async (plaintext) => ({ sealed: plaintext.length }) },
    storage: {
      get: async (space, key) => records.get(`${space} ${key}`) ?? null,
      subscribe: (callback) => { listener = callback; return () => { listener = null; }; },
    },
  };
  const uploads = [];
  const client = { put: async (key) => { uploads.push(key); } };
  const mirror = startShareMirror({ node, repositoryId: 'repo1234', client });
  await mirror.seedCurrent();
  // Registry, presence, durable + snapshot heads, manifest, chunk.
  assert.equal(uploads.length, 5, uploads.join('\n'));
  assert.ok(uploads.includes(mirrorObjectKey('repo1234', 'public', 'gitpigeon/v1/repo1234/registry')));
  assert.ok(uploads.includes(mirrorObjectKey('repo1234', 'frozen', `gitpigeon/v1/repo1234/chunk/${'b'.repeat(64)}`)));
  uploads.length = 0;
  listener({ origin: 'remote', space: 'public', key: 'gitpigeon/v1/repo1234/registry' });
  listener({ origin: 'local', space: 'public', key: 'gitpigeon/v1/repo1234/registry' });
  await mirror.flush();
  assert.deepEqual(uploads, [mirrorObjectKey('repo1234', 'public', 'gitpigeon/v1/repo1234/registry')]);
  mirror.stop();
});
