import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_POLL_MS, DEFAULT_SYNC_WAIT_MS } from './constants.js';
import { RepositoryCache } from './cache.js';
import { createIdentity, loadConfig, saveConfig } from './config.js';
import {
  createWatchControl,
  startWatchDaemon,
  stopWatchDaemon,
  watchDaemonStatus,
} from './daemon.js';
import { GitRepository } from './git.js';
import { createInvite, parseInvite } from './invite.js';
import {
  claimPairingUrl,
  clearMachinePigeons,
  connectMachineIndex,
  listMachinePigeons,
  openDashboard,
  unregisterMachinePigeon,
} from './machine-index.js';
import { connectPeerPigeon } from './peerpigeon.js';
import { RepositorySynchronizer } from './protocol.js';
import { WorkspaceFiles } from './workspace.js';

const HELP = `GitPigeon — real-time peer-to-peer sync for native Git

Usage:
  git pigeon init [INVITE] [DIRECTORY]
  git pigeon list
  git pigeon unwatch [REPOSITORY]
  git pigeon stop
  git pigeon watch [off|--foreground] [--poll DURATION]
  git pigeon invite
  git pigeon track FILE...
  git pigeon untrack FILE...
  git pigeon tracked
  git pigeon sync [--wait DURATION] [--force]
  git pigeon status [--json]
  git pigeon doctor

Durations accept ms, s, or m (for example: 500ms, 10s, 2m).
Because the executable is named git-pigeon, both \`git pigeon\` and
\`git-pigeon\` invoke the same command.`;

function takeOption(args, name) {
  const exact = args.indexOf(name);
  if (exact !== -1) {
    const value = args[exact + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    args.splice(exact, 2);
    return value;
  }
  const prefix = `${name}=`;
  const inline = args.findIndex((arg) => arg.startsWith(prefix));
  if (inline !== -1) return args.splice(inline, 1)[0].slice(prefix.length);
  return undefined;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function duration(value, fallback) {
  if (value === undefined) return fallback;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const scale = match[2] === 'm' ? 60_000 : match[2] === 's' ? 1_000 : 1;
  return Math.max(0, Math.round(Number(match[1]) * scale));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logger(verbose = false) {
  return {
    info: (message) => console.log(`[gitpigeon] ${message}`),
    warn: (message) => console.warn(`[gitpigeon] warning: ${message}`),
    error: (error) => console.error(`[gitpigeon] error: ${error?.message ?? error}`),
    debug: verbose ? (message) => console.log(`[gitpigeon] ${message}`) : () => {},
  };
}

async function configuredRepository(cwd) {
  const repository = await GitRepository.discover(cwd);
  const config = await loadConfig(repository.gitDir);
  return { repository, config };
}

async function openNetwork(repository, config, log) {
  const runtime = await connectPeerPigeon(config, log);
  const synchronizer = new RepositorySynchronizer({ repository, storage: runtime.storage, config, logger: log });
  return { runtime, synchronizer };
}

async function startIndexedWatchDaemon(repository, options = {}) {
  const current = await watchDaemonStatus(repository.gitDir);
  if (current.running) {
    const registered = (await listMachinePigeons({ activeOnly: false }))
      .some((entry) => entry.repository === repository.root && entry.pid === current.pid);
    if (!registered) await stopWatchDaemon(repository);
  }
  return await startWatchDaemon(repository, options);
}

async function discoverOrInitialize(cwd, directory) {
  if (directory) {
    const target = path.resolve(cwd, directory);
    await ensureCloneDirectory(target);
    return await GitRepository.init(target);
  }
  try {
    return await GitRepository.discover(cwd);
  } catch (error) {
    if (!String(error.message).includes('Not a Git repository')) throw error;
    return await GitRepository.init(cwd);
  }
}

async function commandInit(args, cwd, verbose) {
  const repositoryId = takeOption(args, '--repo-id');
  const secret = takeOption(args, '--secret');
  const signalingServer = takeOption(args, '--signal');
  const inviteValue = args.shift();
  const directory = args.shift();
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (directory && !inviteValue) throw new Error('A destination directory requires an invite');
  if (inviteValue && (repositoryId || secret || signalingServer)) {
    throw new Error('An invite cannot be combined with --repo-id, --secret, or --signal');
  }
  const invite = inviteValue ? parseInvite(inviteValue) : null;
  const repository = await discoverOrInitialize(cwd, directory);
  let config = null;
  try {
    config = await loadConfig(repository.gitDir);
  } catch (error) {
    if (!String(error.message).includes('not configured')) throw error;
  }
  if (config && invite && (
    config.repositoryId !== invite.repositoryId || config.secret !== invite.secret
  )) {
    throw new Error('This repository is already configured with a different GitPigeon invite');
  }
  const created = !config;
  if (!config) {
    config = createIdentity(invite ?? { repositoryId, secret, signalingServer });
    await saveConfig(repository.gitDir, config);
  }
  const workspace = new WorkspaceFiles(repository);
  await workspace.init();
  const watcher = await startIndexedWatchDaemon(repository, { verbose });
  const dashboardPairing = await claimPairingUrl({ baseUrl: process.env.GITPIGEON_DASHBOARD_URL });
  if (dashboardPairing) {
    try {
      const opened = openDashboard(dashboardPairing);
      if (opened) console.log('Paired this machine with the GitPigeon dashboard through PeerPigeon.');
      else console.log(`Open this one-time pairing URL:\n${dashboardPairing}`);
    } catch (error) {
      console.warn(`Could not open the GitPigeon dashboard automatically: ${error.message}`);
      console.log(`Open this one-time pairing URL:\n${dashboardPairing}`);
    }
  }

  if (created && !invite) {
    console.log('GitPigeon initialized and watching in the background.');
    console.log('Share this invite only with trusted collaborators:\n');
    console.log(createInvite(config));
  } else if (created) {
    console.log(`GitPigeon joined at ${repository.root} and is syncing in the background.`);
  } else {
    console.log(`GitPigeon is configured and ${watcher.started ? 'now watching' : 'already watching'} in the background.`);
  }
  const discovered = await workspace.list();
  if (discovered.length) console.log(`Private files: ${discovered.length} automatically protected from Git.`);
  console.log('Remove this repository from the encrypted Pigeon index with `git pigeon unwatch`.');
  console.log('Stop every local watcher with `git pigeon stop`.');
}

async function commandInvite(args, cwd) {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { config } = await configuredRepository(cwd);
  console.log(createInvite(config));
}

async function commandTrack(args, cwd) {
  if (!args.length) throw new Error('track requires at least one file path');
  const { repository } = await configuredRepository(cwd);
  const workspace = new WorkspaceFiles(repository);
  const added = await workspace.track(args);
  for (const file of added) console.log(`Tracking privately: ${file}`);
  console.log('These files are excluded from Git and will sync through PeerPigeon.');
}

async function commandUntrack(args, cwd) {
  if (!args.length) throw new Error('untrack requires at least one file path');
  const { repository } = await configuredRepository(cwd);
  const workspace = new WorkspaceFiles(repository);
  const removed = await workspace.untrack(args);
  for (const file of removed) console.log(`No longer tracking privately: ${file}`);
  if (!removed.length) console.log('No matching private files were tracked.');
  else console.log('These paths are no longer excluded from Git on this device.');
}

async function commandTracked(args, cwd) {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository } = await configuredRepository(cwd);
  const files = await new WorkspaceFiles(repository).list();
  if (!files.length) {
    console.log('No private workspace files are tracked.');
    return;
  }
  for (const file of files) console.log(file);
}

async function commandSync(args, cwd, verbose) {
  const waitMs = duration(takeOption(args, '--wait'), DEFAULT_SYNC_WAIT_MS);
  const force = takeFlag(args, '--force');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  const log = logger(verbose);
  const { runtime, synchronizer } = await openNetwork(repository, config, log);
  try {
    await synchronizer.start({ publish: false });
    await synchronizer.publishLocal({ force });
    if (waitMs > 0) await sleep(waitMs);
    await synchronizer.refresh();
    await synchronizer.publishLocal();
  } finally {
    await synchronizer.stop();
    await runtime.close();
  }
}

async function commandWatch(args, cwd, verbose) {
  if (args[0] === 'off') {
    args.shift();
    return await commandUnwatch(args, cwd);
  }
  if (args[0] === 'on') args.shift();
  const pollMs = duration(takeOption(args, '--poll'), DEFAULT_POLL_MS);
  const foreground = takeFlag(args, '--foreground');
  const daemonToken = takeOption(args, '--daemon-child');
  if (pollMs < 100) throw new Error('Poll interval must be at least 100ms');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  if (!foreground && !daemonToken) {
    const result = await startIndexedWatchDaemon(repository, { pollMs, verbose });
    console.log(result.started ? 'GitPigeon is now watching in the background.' : 'GitPigeon is already watching.');
    return;
  }

  const log = logger(verbose);
  let runtime;
  let synchronizer;
  let timer;
  let control;
  let machineIndex;
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    resolveStop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    machineIndex = await connectMachineIndex(repository, config, log);
    ({ runtime, synchronizer } = await openNetwork(repository, config, log));
    await synchronizer.start();
    if (daemonToken) control = await createWatchControl(repository, daemonToken, stop);
    let previousDigest = await synchronizer.localDigest();
    let publishing = false;
    const check = async () => {
      if (publishing) return;
      publishing = true;
      try {
        const nextDigest = await synchronizer.localDigest();
        if (nextDigest !== previousDigest) {
          previousDigest = nextDigest;
          await synchronizer.publishLocal();
        }
      } catch (error) {
        log.error(error);
      } finally {
        publishing = false;
      }
    };
    timer = setInterval(check, pollMs);
    runtime.node.on('peerConnected', () => {
      synchronizer.refresh().catch((error) => log.error(error));
    });
    log.info(`Watching ${repository.root} as ${config.deviceId.slice(0, 8)}${daemonToken ? '' : ' (Ctrl+C to stop)'}`);
    await stopped;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (timer) clearInterval(timer);
    if (synchronizer) await synchronizer.stop();
    if (runtime) await runtime.close();
    if (machineIndex) await machineIndex.close();
    if (control) await control.close();
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function watchedRepositories(registrations) {
  const repositories = new Map();
  for (const registration of registrations) {
    const current = repositories.get(registration.repository) ?? {
      name: path.basename(registration.repository),
      repositoryId: registration.repositoryId,
      root: registration.repository,
      registrations: [],
    };
    current.registrations.push(registration);
    repositories.set(registration.repository, current);
  }
  return [...repositories.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.root.localeCompare(right.root)
  ));
}

async function commandList(args) {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const registrations = await listMachinePigeons();
  const repositories = watchedRepositories(registrations);
  if (!repositories.length) {
    console.log('No repositories are being watched.');
    return;
  }
  const nameWidth = Math.max('NAME'.length, ...repositories.map(({ name }) => name.length));
  console.log(`${'NAME'.padEnd(nameWidth)}  PIGEON      PATH`);
  for (const repository of repositories) {
    console.log(`${repository.name.padEnd(nameWidth)}  ${repository.repositoryId.slice(0, 10)}  ${repository.root}`);
  }
}

async function stopRepository(repository, registrations = []) {
  const result = await stopWatchDaemon(repository);
  const pids = [...new Set(registrations.map(({ pid }) => pid))];
  for (const pid of pids) {
    if (pid !== process.pid && processIsRunning(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* watcher already exited */ }
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(processIsRunning)) await sleep(50);
  const remaining = pids.filter(processIsRunning);
  if (remaining.length) throw new Error(`Could not stop ${remaining.length} GitPigeon watcher${remaining.length === 1 ? '' : 's'} for ${repository.root}`);
  return result.stopped || registrations.length > 0;
}

async function commandUnwatch(args, cwd) {
  const name = args.shift();
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (!name) {
    const { repository } = await configuredRepository(cwd);
    const registrations = (await listMachinePigeons())
      .filter((registration) => registration.repository === repository.root);
    await unregisterMachinePigeon(repository);
    const stopped = await stopRepository(repository, registrations);
    if (stopped) console.log('Stopped watching this repository and removed it from the encrypted PeerPigeon index.');
    else console.log('This repository was not being watched.');
    return;
  }

  const registrations = await listMachinePigeons();
  if (!registrations.length) throw new Error('No repositories are being watched. Run `git pigeon init` in a repository first.');
  const matches = watchedRepositories(registrations)
    .filter((repository) => repository.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!matches.length) throw new Error(`No watched repository is named "${name}". Run \`git pigeon list\` to see the current names.`);
  if (matches.length > 1) {
    throw new Error(`Repository name "${name}" is ambiguous:\n${matches.map(({ root }) => `  ${root}`).join('\n')}`);
  }
  const match = matches[0];
  const repository = await GitRepository.discover(match.root);
  await unregisterMachinePigeon(repository);
  await stopRepository(repository, match.registrations);
  console.log(`Stopped watching ${match.name} and removed it from the encrypted PeerPigeon index.`);
}

async function commandStop(args) {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const registrations = await listMachinePigeons();
  if (!registrations.length) {
    await clearMachinePigeons();
    console.log('The encrypted GitPigeon index is already empty.');
    return;
  }

  const repositories = new Map();
  for (const registration of registrations) {
    const current = repositories.get(registration.repository) ?? [];
    current.push(registration);
    repositories.set(registration.repository, current);
  }

  for (const [root, repositoryRegistrations] of repositories) {
    try {
      const repository = await GitRepository.discover(root);
      await stopWatchDaemon(repository);
    } catch { /* a deleted repository can still have a live foreground watcher */ }
    for (const registration of repositoryRegistrations) {
      if (registration.pid !== process.pid && processIsRunning(registration.pid)) {
        try { process.kill(registration.pid, 'SIGTERM'); } catch { /* watcher already exited */ }
      }
    }
  }

  const pids = [...new Set(registrations.map((registration) => registration.pid))];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(processIsRunning)) await sleep(50);
  const remaining = pids.filter(processIsRunning);
  if (remaining.length) throw new Error(`Could not stop ${remaining.length} local GitPigeon watcher${remaining.length === 1 ? '' : 's'}`);
  await clearMachinePigeons();
  console.log(`Stopped ${repositories.size} watched repositor${repositories.size === 1 ? 'y' : 'ies'} and cleared the encrypted PeerPigeon index.`);
}

async function ensureCloneDirectory(target) {
  try {
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error(`Clone destination is not empty: ${target}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(target, { recursive: true });
  }
}

async function commandClone(args, cwd, verbose) {
  takeOption(args, '--wait');
  const inviteValue = args.shift();
  if (!inviteValue) throw new Error('clone requires a GitPigeon invite');
  const invite = parseInvite(inviteValue);
  const target = args.shift() ?? `gitpigeon-${invite.repositoryId.slice(0, 8)}`;
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  console.warn('`git pigeon clone` is an alias; use `git pigeon init INVITE [DIRECTORY]`.');
  return await commandInit([inviteValue, target], cwd, verbose);
}

async function commandStatus(args, cwd) {
  const json = takeFlag(args, '--json');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  const cache = new RepositoryCache(repository.gitDir);
  const trackedFiles = await new WorkspaceFiles(repository, cache).list();
  const state = await cache.loadState();
  const watcher = await watchDaemonStatus(repository.gitDir);
  const value = {
    repository: repository.root,
    repositoryId: config.repositoryId,
    deviceId: config.deviceId,
    signalingServer: config.signalingServer ?? 'PeerPigeon automatic discovery',
    refsDigest: await repository.refsDigest(),
    knownDevices: Object.keys(state.heads ?? {}).sort(),
    importedSnapshots: state.imported ?? {},
    trackedFiles,
    watching: watcher.running,
    watcherPid: watcher.running ? watcher.pid : null,
  };
  if (json) console.log(JSON.stringify(value, null, 2));
  else {
    console.log(`Repository:       ${value.repository}`);
    console.log(`Pigeon ID:        ${value.repositoryId}`);
    console.log(`Device:           ${value.deviceId}`);
    console.log(`Signaling:        ${value.signalingServer}`);
    console.log(`Known devices:    ${value.knownDevices.length}`);
    console.log(`Local refs digest:${value.refsDigest ? ` ${value.refsDigest}` : ' no commits yet'}`);
    console.log(`Private files:     ${value.trackedFiles.length}`);
    for (const file of value.trackedFiles) console.log(`  ${file}`);
    console.log(`Watching:          ${value.watching ? `yes (PID ${value.watcherPid})` : 'no'}`);
  }
}

async function commandDoctor(args, cwd) {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const repository = await GitRepository.discover(cwd);
  let dependency = 'not installed';
  try {
    const pkg = await import('peerpigeon/package.json', { with: { type: 'json' } });
    dependency = pkg.default?.version ?? 'installed';
  } catch { /* reported below */ }
  console.log(`Node:        ${process.version} (${process.platform}/${process.arch})`);
  console.log(`Git:         ${await repository.version()}`);
  console.log(`PeerPigeon:  ${dependency}`);
  console.log('Pinned SHA:  ee07a5934bda5d05cf9b0f364a13456ba3438a1c');
  console.log(`Repository:  ${repository.root}`);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const args = [...argv];
  const cwd = options.cwd ?? process.cwd();
  const verbose = takeFlag(args, '--verbose');
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === 'init') return await commandInit(args, cwd, verbose);
  if (command === 'list') return await commandList(args);
  if (command === 'invite') return await commandInvite(args, cwd);
  if (command === 'track') return await commandTrack(args, cwd);
  if (command === 'untrack') return await commandUntrack(args, cwd);
  if (command === 'tracked') return await commandTracked(args, cwd);
  if (command === 'sync') return await commandSync(args, cwd, verbose);
  if (command === 'watch') return await commandWatch(args, cwd, verbose);
  if (command === 'unwatch') return await commandUnwatch(args, cwd);
  if (command === 'stop') return await commandStop(args);
  if (command === 'clone') return await commandClone(args, cwd, verbose);
  if (command === 'status') return await commandStatus(args, cwd);
  if (command === 'doctor') return await commandDoctor(args, cwd);
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
