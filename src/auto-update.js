import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RELEASE_URL = 'https://api.github.com/repos/PeerPigeon/GitPigeon/releases/latest';
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/PeerPigeon/GitPigeon/releases/download/';
const UPDATE_INTERVAL_MS = 15 * 60_000;
const INITIAL_UPDATE_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 256 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;

function updatePaths(root) {
  const updates = path.join(path.resolve(root), 'updates');
  return { updates, current: path.join(updates, 'current.json') };
}

function safeVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { value: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, parts: match.slice(1).map(Number) };
}

export function isNewerVersion(candidate, current) {
  const left = safeVersion(candidate);
  const right = safeVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] > right.parts[index];
  }
  return false;
}

export function updateAssetName(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'GitPigeon-macos-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'GitPigeon-macos-x64';
  if (platform === 'linux' && arch === 'x64') return 'GitPigeon-linux-x64';
  if (platform === 'win32' && arch === 'x64') return 'GitPigeon-windows-x64.exe';
  return null;
}

async function responseText(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new Error('GitPigeon update response is too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error('GitPigeon update response is too large');
  return new TextDecoder().decode(bytes);
}

function requestSignal(signal) {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function releaseRequest(fetchImpl, { etag, signal } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'GitPigeon-auto-update',
    'x-github-api-version': '2022-11-28',
  };
  if (etag) headers['if-none-match'] = etag;
  const response = await fetchImpl(RELEASE_URL, { headers, redirect: 'follow', signal: requestSignal(signal) });
  if (response.status === 304) return { unchanged: true, etag };
  if (!response.ok) throw new Error(`GitHub release check failed with HTTP ${response.status}`);
  const release = JSON.parse(await responseText(response, MAX_METADATA_BYTES));
  return { release, etag: response.headers.get('etag') ?? null };
}

function releaseAsset(release, name) {
  const asset = Array.isArray(release?.assets) && release.assets.find((entry) => entry?.name === name);
  const url = String(asset?.browser_download_url ?? '');
  if (!asset || !url.startsWith(RELEASE_DOWNLOAD_PREFIX)) throw new Error(`GitPigeon release is missing ${name}`);
  return { ...asset, browser_download_url: url };
}

function checksumFor(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === name) return match[1].toLowerCase();
  }
  throw new Error(`GitPigeon release checksum is missing ${name}`);
}

async function downloadExecutable(fetchImpl, asset, destination, expected, signal) {
  if (Number(asset.size) > MAX_EXECUTABLE_BYTES) throw new Error('GitPigeon update executable is too large');
  const response = await fetchImpl(asset.browser_download_url, { redirect: 'follow', signal: requestSignal(signal) });
  if (!response.ok || !response.body) throw new Error(`GitPigeon update download failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_EXECUTABLE_BYTES) throw new Error('GitPigeon update executable is too large');
  const digest = createHash('sha256');
  let received = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_EXECUTABLE_BYTES) return callback(new Error('GitPigeon update executable is too large'));
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(destination, { mode: 0o755 }));
  const actual = digest.digest('hex');
  if (actual !== expected) throw new Error('GitPigeon update checksum verification failed');
  return actual;
}

async function defaultVerifyExecutable(executable) {
  await execFileAsync(executable, ['--help'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function writeCurrentUpdate(root, value) {
  const { updates, current } = updatePaths(root);
  await mkdir(updates, { recursive: true, mode: 0o700 });
  const temporary = `${current}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, current);
}

export async function readInstalledUpdate(root) {
  try {
    const { updates, current } = updatePaths(root);
    const value = JSON.parse(await readFile(current, 'utf8'));
    const executable = path.resolve(String(value?.executable ?? ''));
    if (value?.version !== 1 || !safeVersion(value.releaseVersion)) return null;
    if (!executable.startsWith(`${path.resolve(updates)}${path.sep}`)) return null;
    if (!/^[a-f0-9]{64}$/.test(String(value.sha256))) return null;
    const details = await stat(executable);
    if (!details.isFile()) return null;
    return { ...value, executable };
  } catch {
    return null;
  }
}

export async function clearInstalledUpdate(root, executable) {
  const installed = await readInstalledUpdate(root);
  if (!installed || (executable && path.resolve(executable) !== installed.executable)) return false;
  await rm(updatePaths(root).current, { force: true });
  return true;
}

export async function downloadReleaseUpdate({
  root,
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  etag,
  signal,
  verifyExecutable = defaultVerifyExecutable,
} = {}) {
  const name = updateAssetName(platform, arch);
  if (!name) return { updated: false, unsupported: true, etag };
  const latest = await releaseRequest(fetchImpl, { etag, signal });
  if (latest.unchanged) return { updated: false, unchanged: true, etag: latest.etag };
  const version = safeVersion(latest.release?.tag_name);
  if (!version || !isNewerVersion(version.value, currentVersion)) {
    return { updated: false, current: true, etag: latest.etag };
  }
  const executableAsset = releaseAsset(latest.release, name);
  const checksumsAsset = releaseAsset(latest.release, 'SHA256SUMS');
  const checksumsResponse = await fetchImpl(checksumsAsset.browser_download_url, {
    redirect: 'follow',
    signal: requestSignal(signal),
  });
  if (!checksumsResponse.ok) throw new Error(`GitPigeon checksum download failed with HTTP ${checksumsResponse.status}`);
  const expected = checksumFor(await responseText(checksumsResponse, MAX_CHECKSUM_BYTES), name);
  if (executableAsset.digest && executableAsset.digest !== `sha256:${expected}`) {
    throw new Error('GitPigeon release asset digest does not match SHA256SUMS');
  }

  const directory = path.join(updatePaths(root).updates, version.value);
  const executable = path.join(directory, platform === 'win32' ? 'git-pigeon.exe' : 'git-pigeon');
  const temporary = `${executable}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await downloadExecutable(fetchImpl, executableAsset, temporary, expected, signal);
    await chmod(temporary, 0o755);
    await verifyExecutable(temporary);
    await rm(executable, { force: true });
    await rename(temporary, executable);
    await writeCurrentUpdate(root, {
      version: 1,
      releaseVersion: version.value,
      executable,
      sha256: expected,
      installedAt: new Date().toISOString(),
    });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { updated: true, version: version.value, executable, sha256: expected, etag: latest.etag };
}

export function startAutomaticUpdates({
  enabled,
  root,
  currentVersion,
  logger = console,
  onUpdate,
  initialDelayMs = INITIAL_UPDATE_DELAY_MS,
  intervalMs = UPDATE_INTERVAL_MS,
  fetchImpl = fetch,
} = {}) {
  if (!enabled) return { stop() {} };
  let stopped = false;
  let timer = null;
  let etag = null;
  let checking = false;
  const controller = new AbortController();
  const schedule = (delay) => {
    if (stopped) return;
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  const run = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const result = await downloadReleaseUpdate({ root, currentVersion, fetchImpl, etag, signal: controller.signal });
      etag = result.etag ?? etag;
      if (result.updated) {
        stopped = true;
        logger.info(`GitPigeon ${result.version} was verified and installed; restarting the watcher`);
        await onUpdate?.(result);
        return;
      }
    } catch (error) {
      if (!stopped && error?.name !== 'AbortError') logger.warn(`GitPigeon automatic update check failed: ${error.message}`);
    } finally {
      checking = false;
      if (!stopped) schedule(intervalMs);
    }
  };
  schedule(initialDelayMs);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      controller.abort();
    },
  };
}
