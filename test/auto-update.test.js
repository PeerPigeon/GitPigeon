import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  downloadReleaseUpdate,
  isNewerVersion,
  readInstalledUpdate,
  startAutomaticUpdates,
  updateAssetName,
} from '../src/auto-update.js';

test('compares stable release versions without downgrading', () => {
  assert.equal(isNewerVersion('v0.1.11', '0.1.10'), true);
  assert.equal(isNewerVersion('0.2.0', '0.1.99'), true);
  assert.equal(isNewerVersion('0.1.10', '0.1.10'), false);
  assert.equal(isNewerVersion('0.1.9', '0.1.10'), false);
  assert.equal(isNewerVersion('not-a-version', '0.1.10'), false);
});

test('selects only release executables built for the current platform', () => {
  assert.equal(updateAssetName('darwin', 'arm64'), 'GitPigeon-macos-arm64');
  assert.equal(updateAssetName('darwin', 'x64'), 'GitPigeon-macos-x64');
  assert.equal(updateAssetName('linux', 'x64'), 'GitPigeon-linux-x64');
  assert.equal(updateAssetName('win32', 'x64'), 'GitPigeon-windows-x64.exe');
  assert.equal(updateAssetName('linux', 'arm64'), null);
});

test('downloads, verifies, and atomically selects a newer watcher executable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gitpigeon-update-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = 'GitPigeon-macos-arm64';
  const binary = Buffer.from('verified GitPigeon executable');
  const digest = createHash('sha256').update(binary).digest('hex');
  const base = 'https://github.com/PeerPigeon/GitPigeon/releases/download/v0.1.11/';
  const release = {
    tag_name: 'v0.1.11',
    assets: [
      { name, browser_download_url: `${base}${name}`, size: binary.length, digest: `sha256:${digest}` },
      { name: 'SHA256SUMS', browser_download_url: `${base}SHA256SUMS`, size: 100 },
    ],
  };
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes('/releases/latest')) return new Response(JSON.stringify(release), { headers: { etag: '"release-11"' } });
    if (url.endsWith('/SHA256SUMS')) return new Response(`${digest}  ${name}\n`);
    if (url.endsWith(`/${name}`)) return new Response(binary);
    return new Response('missing', { status: 404 });
  };
  let verified;
  const result = await downloadReleaseUpdate({
    root,
    currentVersion: '0.1.10',
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl,
    verifyExecutable: async (executable) => { verified = await readFile(executable, 'utf8'); },
  });

  assert.equal(result.updated, true);
  assert.equal(result.version, '0.1.11');
  assert.equal(result.etag, '"release-11"');
  assert.equal(verified, binary.toString());
  assert.equal(await readFile(result.executable, 'utf8'), binary.toString());
  assert.equal((await readInstalledUpdate(root)).executable, result.executable);
  assert.equal(requests.length, 3);
});

test('does not download assets when the latest release is already running', async () => {
  let requests = 0;
  const result = await downloadReleaseUpdate({
    root: '/unused',
    currentVersion: '0.1.11',
    platform: 'darwin',
    arch: 'arm64',
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ tag_name: 'v0.1.11', assets: [] }));
    },
  });
  assert.equal(result.updated, false);
  assert.equal(result.current, true);
  assert.equal(requests, 1);
});

test('automatic release polling stays single-flight and stops cleanly', async () => {
  let active = 0;
  let maximumActive = 0;
  let requests = 0;
  const updater = startAutomaticUpdates({
    enabled: true,
    root: '/unused',
    currentVersion: '0.1.11',
    initialDelayMs: 0,
    intervalMs: 5,
    fetchImpl: async () => {
      requests += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return new Response(JSON.stringify({ tag_name: 'v0.1.11', assets: [] }));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 55));
  updater.stop();
  const stoppedAt = requests;
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(maximumActive, 1);
  assert.ok(stoppedAt >= 2);
  assert.equal(requests, stoppedAt);
});
