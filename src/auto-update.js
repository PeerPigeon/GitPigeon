import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// The list, not /releases/latest. GitHub's "latest" is the release object
// created most recently, and a release whose installers finished building
// later than a newer version's is created later: v0.13.109 was marked latest
// after v0.13.110 had shipped, and every machine that updated in that window
// installed the older build. The updater picks the highest complete version.
const RELEASE_URL = 'https://api.github.com/repos/PeerPigeon/GitPigeon/releases?per_page=10';
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/PeerPigeon/GitPigeon/releases/download/';
// GitHub is asked once a day. Builds travel between watchers over the mesh
// (peer-update.js) within a minute of any one of them having a newer one,
// and a browser can push a release to a watcher on demand; four machines
// behind one router polling GitHub's release list every fifteen minutes
// exhausted its sixty-requests-an-hour allowance and then none could update.
const UPDATE_INTERVAL_MS = 24 * 60 * 60_000;
// Almost at once: a machine that comes up out of date should be current
// before anyone notices, not a quarter of a minute later.
const INITIAL_UPDATE_DELAY_MS = 10 * 60_000;
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
  const body = JSON.parse(await responseText(response, MAX_METADATA_BYTES));
  return { release: highestCompleteRelease(body), etag: response.headers.get('etag') ?? null };
}

// A single release object (older tests, a pinned URL) is taken as is; a list
// is reduced to the highest published version that carries its checksums.
export function highestCompleteRelease(body) {
  if (!Array.isArray(body)) return body;
  let best = null;
  for (const release of body) {
    if (!release || release.draft || release.prerelease) continue;
    const version = safeVersion(release.tag_name);
    if (!version) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    if (!assets.some((asset) => asset?.name === 'SHA256SUMS')) continue;
    if (!best || isNewerVersion(version.value, safeVersion(best.tag_name).value)) best = release;
  }
  return best;
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

// The first launch of a freshly written standalone binary pages in over a
// hundred megabytes and loads native modules; an older Intel machine took
// longer than the twenty seconds this used to allow, and the update was
// refused with a bare "Command failed" that said nothing about why.
const VERIFY_TIMEOUT_MS = 90_000;

async function defaultVerifyExecutable(executable) {
  try {
    await execFileAsync(executable, ['--help'], {
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error?.killed || error?.signal === 'SIGTERM'
      ? `did not finish within ${VERIFY_TIMEOUT_MS / 1000}s`
      : error?.signal
        ? `was killed by ${error.signal}`
        : `exited with ${error?.code ?? 'an error'}${String(error?.stderr ?? '').trim() ? `: ${String(error.stderr).trim().split('\n').slice(-3).join(' ')}` : ''}`;
    throw new Error(`The downloaded GitPigeon executable ${detail}`);
  }
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
  await pruneOldUpdates(root, [version.value, currentVersion]).catch(() => { /* disk space, not correctness */ });
  return { updated: true, version: version.value, executable, sha256: expected, etag: latest.etag };
}

/**
 * Every installed release stayed on disk forever: a hundred-megabyte binary
 * per version, sixty-five versions and seven gigabytes on one machine. Only
 * the release just installed and the one still running are kept; the
 * running one goes on the next install.
 */
export async function pruneOldUpdates(root, keepVersions) {
  const { updates } = updatePaths(root);
  const keep = new Set(keepVersions.map((value) => String(value ?? '')).filter(Boolean));
  let entries;
  try { entries = await readdir(updates, { withFileTypes: true }); } catch { return []; }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || keep.has(entry.name) || !/^\d+\.\d+\.\d+/.test(entry.name)) continue;
    await rm(path.join(updates, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
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
