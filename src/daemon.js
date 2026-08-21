import { randomBytes } from 'node:crypto';
import { watch as watchFilesystem } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const STANDALONE = typeof __GITPIGEON_STANDALONE__ === 'boolean'
  ? __GITPIGEON_STANDALONE__
  : process.env.GITPIGEON_STANDALONE === '1';
const ENTRYPOINT = STANDALONE
  ? process.execPath
  : fileURLToPath(new URL('../bin/git-pigeon.js', import.meta.url));
const START_TIMEOUT_MS = 20_000;
const HEARTBEAT_STALE_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 3_000;
const START_LOCK_STALE_MS = 30_000;
export const SERVICE_PROTOCOL_VERSION = 5;
const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isGitPigeonWatcherCommand(command) {
  const value = String(command ?? '');
  const executable = /(?:^|[\s"'])(?:[^\s"']*[\\/])?git-pigeon(?:\.js)?(?:[\s"']|$)/i.test(value);
  const watch = /(?:^|\s)watch(?:\s|$)/.test(value);
  const foreground = /(?:^|\s)--foreground(?:\s|$|=)/.test(value);
  return executable && watch && foreground;
}

export function watcherPidsFromProcessRows(rows, currentPid = process.pid) {
  return [...new Set(rows
    .filter(({ command }) => isGitPigeonWatcherCommand(command))
    .map(({ pid }) => Number(pid))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== currentPid))];
}

export async function listGitPigeonWatcherPids({
  platform = process.platform,
  run = execFileAsync,
} = {}) {
  let rows;
  if (platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = String(stdout).trim() ? JSON.parse(stdout) : [];
    rows = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
      pid: entry.ProcessId,
      command: entry.CommandLine,
    }));
  } else {
    const { stdout } = await run('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    rows = String(stdout).split(/\r?\n/).flatMap((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
    });
  }
  return watcherPidsFromProcessRows(rows);
}

function servicePaths(root) {
  return {
    root,
    state: path.join(root, 'service.json'),
    command: path.join(root, 'service-command.json'),
    log: path.join(root, 'service.log'),
    startLock: path.join(root, 'service-start.lock'),
  };
}

async function writeState(filename, value) {
  const temporary = `${filename}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withServiceStartLock(root, operation) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const { startLock } = servicePaths(root);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await open(startLock, 'wx', 0o600);
      try {
        return await operation();
      } finally {
        await handle.close();
        await rm(startLock, { force: true });
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const details = await stat(startLock);
        if (Date.now() - details.mtimeMs > START_LOCK_STALE_MS) await rm(startLock, { force: true });
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out starting the GitPigeon service at ${root}`);
      await sleep(50);
    }
  }
}

export async function readWatchServiceState(root) {
  try {
    const value = JSON.parse(await readFile(servicePaths(root).state, 'utf8'));
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid)) return null;
    if (!/^[a-f0-9]{64}$/.test(String(value.token))) return null;
    if (!Number.isFinite(Date.parse(value.heartbeatAt))) return null;
    return value;
  } catch {
    return null;
  }
}

export async function watchServiceStatus(root) {
  const state = await readWatchServiceState(root);
  if (!state) return { running: false };
  if (processIsRunning(state.pid) && Date.now() - Date.parse(state.heartbeatAt) <= HEARTBEAT_STALE_MS) {
    return {
      running: true,
      compatible: state.serviceProtocol === SERVICE_PROTOCOL_VERSION,
      ...state,
    };
  }
  return { running: false, stale: true, ...state };
}

export function watchServiceHasRepository(status, repository) {
  return Boolean(
    status?.running
    && status.compatible
    && status.activeRepositories?.includes(path.resolve(repository)),
  );
}

export async function waitForWatchServiceRepository(root, repository, {
  timeoutMs = START_TIMEOUT_MS,
} = {}) {
  const target = path.resolve(repository);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await watchServiceStatus(root);
    if (!status.running) throw new Error('The GitPigeon watcher service stopped before it loaded this repository');
    if (!status.compatible) throw new Error('The running GitPigeon watcher service is from an incompatible build');
    if (watchServiceHasRepository(status, target)) return status;
    const failure = status.repositoryErrors?.[target];
    if (failure) throw new Error(`GitPigeon could not watch ${target}: ${failure}`);
    await sleep(50);
  }
  throw new Error(`The GitPigeon watcher service did not load ${target} within ${timeoutMs}ms`);
}

async function terminateWatcherPids(pids) {
  const targets = [...new Set(pids)]
    .filter((pid) => pid !== process.pid && processIsRunning(pid));
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && targets.some(processIsRunning)) await sleep(50);
  const remaining = targets.filter(processIsRunning);
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
  return targets;
}

export async function startWatchService({
  root,
  pollMs,
  verbose = false,
  entrypoint = ENTRYPOINT,
  findWatcherPids = listGitPigeonWatcherPids,
} = {}) {
  if (!root) throw new Error('GitPigeon service state root is required');
  return await withServiceStartLock(root, async () => {
    const current = await watchServiceStatus(root);
    if (current.running && current.compatible) return { started: false, ...current };

    // Replace every legacy per-repository watcher before creating the one
    // machine service. The startup lock prevents two callers from spawning it.
    const legacyPids = await findWatcherPids();
    await terminateWatcherPids([
      ...(Number.isSafeInteger(current.pid) ? [current.pid] : []),
      ...legacyPids,
    ]);
    const service = servicePaths(root);
    await rm(service.state, { force: true });
    await rm(service.command, { force: true });

    const token = randomBytes(32).toString('hex');
    const output = await open(service.log, 'a', 0o600);
    let child;
    try {
      const args = [
        ...(STANDALONE ? [] : [entrypoint]),
        'watch',
        '--foreground',
        `--service-child=${token}`,
        `--state-dir=${root}`,
      ];
      if (pollMs !== undefined) args.push(`--poll=${pollMs}ms`);
      if (verbose) args.push('--verbose');
      child = spawn(process.execPath, args, {
        cwd: root,
        detached: true,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', output.fd, output.fd],
      });
      child.unref();
    } finally {
      await output.close();
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await readWatchServiceState(root);
      if (state?.token === token && state.ready === true) {
        const status = await watchServiceStatus(root);
        if (status.running) return { started: true, ...status };
      }
      if (!processIsRunning(child.pid)) {
        throw new Error(`GitPigeon service exited during startup; see ${service.log}`);
      }
      await sleep(100);
    }
    throw new Error(`GitPigeon service did not start; see ${service.log}`);
  });
}

export async function stopWatchService(root) {
  const service = servicePaths(root);
  const state = await readWatchServiceState(root);
  if (!state) return { stopped: false, reason: 'not-running' };
  const status = await watchServiceStatus(root);
  if (!status.running) {
    await rm(service.state, { force: true });
    await rm(service.command, { force: true });
    return { stopped: false, reason: 'stale' };
  }
  await writeState(service.command, {
    token: state.token,
    command: 'stop',
    requestedAt: new Date().toISOString(),
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!await readWatchServiceState(root)) return { stopped: true };
    await sleep(50);
  }
  await terminateWatcherPids([state.pid]);
  await rm(service.state, { force: true });
  await rm(service.command, { force: true });
  return { stopped: true, forced: true };
}

export async function createWatchServiceControl(root, token, stop) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const service = servicePaths(root);
  const existing = await watchServiceStatus(root);
  if (existing.running && existing.pid !== process.pid) {
    throw new Error(`GitPigeon service is already running as PID ${existing.pid}`);
  }
  let closed = false;
  let working = false;
  let stopping = false;
  const state = {
    version: 1,
    serviceProtocol: SERVICE_PROTOCOL_VERSION,
    pid: process.pid,
    token,
    ready: false,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    logFile: service.log,
    activeRepositories: [],
    repositoryErrors: {},
  };
  await writeState(service.state, state);
  const poll = async () => {
    if (closed || working) return;
    working = true;
    try {
      state.heartbeatAt = new Date().toISOString();
      await writeState(service.state, state);
      let command = null;
      try {
        command = JSON.parse(await readFile(service.command, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') await rm(service.command, { force: true });
      }
      if (command?.token === token && command?.command === 'stop' && !stopping) {
        stopping = true;
        await rm(service.command, { force: true });
        stop();
      }
    } finally {
      working = false;
    }
  };
  const commandWatcher = watchFilesystem(root, (_event, filename) => {
    const changed = String(filename ?? '');
    if (!changed || changed === path.basename(service.command)) poll().catch(() => {});
  });
  commandWatcher.on('error', () => {});
  const timer = setInterval(() => { poll().catch(() => {}); }, HEARTBEAT_INTERVAL_MS);
  const updateState = async (change) => {
    while (working) await sleep(10);
    working = true;
    try {
      Object.assign(state, change);
      state.heartbeatAt = new Date().toISOString();
      await writeState(service.state, state);
    } finally {
      working = false;
    }
  };
  return {
    async ready() {
      await updateState({ ready: true });
    },
    async setRepositoryState(activeRepositories, repositoryErrors = {}) {
      await updateState({
        activeRepositories: [...new Set(activeRepositories.map((repository) => path.resolve(repository)))].sort(),
        repositoryErrors,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      commandWatcher.close();
      clearInterval(timer);
      while (working) await sleep(10);
      const current = await readWatchServiceState(root);
      if (current?.token === token) await rm(service.state, { force: true });
      await rm(service.command, { force: true });
    },
  };
}
