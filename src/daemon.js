import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RepositoryCache } from './cache.js';

const ENTRYPOINT = fileURLToPath(new URL('../bin/git-pigeon.js', import.meta.url));
const START_TIMEOUT_MS = 20_000;
const HEARTBEAT_STALE_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paths(gitDir) {
  const root = path.join(gitDir, 'gitpigeon');
  return {
    root,
    state: path.join(root, 'watch.json'),
    command: path.join(root, 'watch-command.json'),
    log: path.join(root, 'watch.log'),
  };
}

async function writeState(filename, value) {
  const temporary = `${filename}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}

export async function readWatchState(gitDir) {
  try {
    const value = JSON.parse(await readFile(paths(gitDir).state, 'utf8'));
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid)) return null;
    if (!/^[a-f0-9]{64}$/.test(String(value.token))) return null;
    if (!Number.isFinite(Date.parse(value.heartbeatAt))) return null;
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

export async function watchDaemonStatus(gitDir) {
  const state = await readWatchState(gitDir);
  if (!state) return { running: false };
  try {
    process.kill(state.pid, 0);
    if (Date.now() - Date.parse(state.heartbeatAt) <= HEARTBEAT_STALE_MS) {
      return { running: true, ...state };
    }
  } catch { /* stale state handled below */ }
  return { running: false, stale: true, ...state };
}

export async function startWatchDaemon(repository, {
  pollMs,
  verbose = false,
  entrypoint = ENTRYPOINT,
} = {}) {
  const cache = new RepositoryCache(repository.gitDir);
  await cache.init();
  const current = await watchDaemonStatus(repository.gitDir);
  if (current.running) return { started: false, ...current };
  if (current.stale) {
    await rm(paths(repository.gitDir).state, { force: true });
    await rm(paths(repository.gitDir).command, { force: true });
  }

  const token = randomBytes(32).toString('hex');
  const watchPaths = paths(repository.gitDir);
  const output = await open(watchPaths.log, 'a', 0o600);
  let child;
  try {
    const args = [entrypoint, 'watch', '--foreground', `--daemon-child=${token}`];
    if (pollMs !== undefined) args.push(`--poll=${pollMs}ms`);
    if (verbose) args.push('--verbose');
    child = spawn(process.execPath, args, {
      cwd: repository.root,
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
    const state = await readWatchState(repository.gitDir);
    if (state?.token === token) {
      const status = await watchDaemonStatus(repository.gitDir);
      if (status.running) return { started: true, ...status };
    }
    try {
      process.kill(child.pid, 0);
    } catch {
      throw new Error(`GitPigeon watcher exited during startup; see ${watchPaths.log}`);
    }
    await sleep(100);
  }
  throw new Error(`GitPigeon watcher did not start; see ${watchPaths.log}`);
}

export async function stopWatchDaemon(repository) {
  const state = await readWatchState(repository.gitDir);
  if (!state) return { stopped: false, reason: 'not-running' };
  const status = await watchDaemonStatus(repository.gitDir);
  if (!status.running) {
    await rm(paths(repository.gitDir).state, { force: true });
    await rm(paths(repository.gitDir).command, { force: true });
    return { stopped: false, reason: 'stale' };
  }
  await writeState(paths(repository.gitDir).command, {
    token: state.token,
    command: 'stop',
    requestedAt: new Date().toISOString(),
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!await readWatchState(repository.gitDir)) return { stopped: true };
    await sleep(50);
  }
  const current = await readWatchState(repository.gitDir);
  if (current?.token === state.token) {
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* process already exited */ }
    const forceDeadline = Date.now() + 2_000;
    while (Date.now() < forceDeadline) {
      try {
        process.kill(state.pid, 0);
      } catch {
        break;
      }
      await sleep(50);
    }
    try { process.kill(state.pid, 'SIGKILL'); } catch { /* process already exited */ }
    await rm(paths(repository.gitDir).state, { force: true });
    await rm(paths(repository.gitDir).command, { force: true });
    return { stopped: true, forced: true };
  }
  return { stopped: true };
}

export async function createWatchControl(repository, token, stop) {
  await new RepositoryCache(repository.gitDir).init();
  const watchPaths = paths(repository.gitDir);
  let closed = false;
  let working = false;
  let stopping = false;
  const state = {
    version: 1,
    pid: process.pid,
    token,
    repository: repository.root,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    logFile: watchPaths.log,
  };
  await writeState(watchPaths.state, state);
  const poll = async () => {
    if (closed || working) return;
    working = true;
    try {
      state.heartbeatAt = new Date().toISOString();
      await writeState(watchPaths.state, state);
      let command = null;
      try {
        command = JSON.parse(await readFile(watchPaths.command, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') await rm(watchPaths.command, { force: true });
      }
      if (command?.token === token && command?.command === 'stop' && !stopping) {
        stopping = true;
        await rm(watchPaths.command, { force: true });
        stop();
      }
    } finally {
      working = false;
    }
  };
  const timer = setInterval(() => { poll().catch(() => {}); }, 250);
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      while (working) await sleep(10);
      const current = await readWatchState(repository.gitDir);
      if (current?.token === token) await rm(watchPaths.state, { force: true });
      await rm(watchPaths.command, { force: true });
    },
  };
}
