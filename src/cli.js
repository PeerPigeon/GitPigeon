import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_POLL_MS, DEFAULT_SYNC_WAIT_MS } from './constants.js';
import { RepositoryCache } from './cache.js';
import { createIdentity, loadConfig, saveConfig } from './config.js';
import { GitRepository } from './git.js';
import { createInvite, parseInvite } from './invite.js';
import { connectPeerPigeon } from './peerpigeon.js';
import { RepositorySynchronizer } from './protocol.js';
import { WorkspaceFiles } from './workspace.js';

const HELP = `GitPigeon — real-time peer-to-peer sync for native Git

Usage:
  git pigeon init [--repo-id ID] [--secret KEY] [--signal WSS_URL]
  git pigeon invite
  git pigeon track FILE...
  git pigeon untrack FILE...
  git pigeon tracked
  git pigeon sync [--wait DURATION] [--force]
  git pigeon watch [--poll DURATION]
  git pigeon clone INVITE [DIRECTORY] [--wait DURATION]
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

async function commandInit(args, cwd) {
  const repositoryId = takeOption(args, '--repo-id');
  const secret = takeOption(args, '--secret');
  const signalingServer = takeOption(args, '--signal');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const repository = await GitRepository.discover(cwd);
  try {
    await loadConfig(repository.gitDir);
    throw new Error('GitPigeon is already configured for this repository');
  } catch (error) {
    if (!String(error.message).includes('not configured')) throw error;
  }
  const config = createIdentity({ repositoryId, secret, signalingServer });
  await saveConfig(repository.gitDir, config);
  console.log('GitPigeon initialized. Share this invite only with trusted collaborators:\n');
  console.log(createInvite(config));
  console.log('\nRun `git pigeon watch` to keep this repository synchronized.');
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
  const pollMs = duration(takeOption(args, '--poll'), DEFAULT_POLL_MS);
  if (pollMs < 100) throw new Error('Poll interval must be at least 100ms');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  const log = logger(verbose);
  const { runtime, synchronizer } = await openNetwork(repository, config, log);
  let timer;
  try {
    await synchronizer.start();
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
    log.info(`Watching ${repository.root} as ${config.deviceId.slice(0, 8)} (Ctrl+C to stop)`);

    await new Promise((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    if (timer) clearInterval(timer);
    await synchronizer.stop();
    await runtime.close();
  }
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
  const waitMs = duration(takeOption(args, '--wait'), 10_000);
  const inviteValue = args.shift();
  if (!inviteValue) throw new Error('clone requires a GitPigeon invite');
  const invite = parseInvite(inviteValue);
  const target = path.resolve(cwd, args.shift() ?? `gitpigeon-${invite.repositoryId.slice(0, 8)}`);
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  await ensureCloneDirectory(target);
  const repository = await GitRepository.init(target);
  const config = createIdentity({ ...invite, deviceId: randomBytes(16).toString('hex') });
  await saveConfig(repository.gitDir, config);
  const log = logger(verbose);
  const { runtime, synchronizer } = await openNetwork(repository, config, log);
  try {
    await synchronizer.start({ publish: false });
    if (waitMs > 0) await sleep(waitMs);
    await synchronizer.refresh();
    await synchronizer.publishLocal();
  } finally {
    await synchronizer.stop();
    await runtime.close();
  }
  console.log(`GitPigeon clone ready at ${target}`);
}

async function commandStatus(args, cwd) {
  const json = takeFlag(args, '--json');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  const cache = new RepositoryCache(repository.gitDir);
  const trackedFiles = await new WorkspaceFiles(repository, cache).list();
  const state = await cache.loadState();
  const value = {
    repository: repository.root,
    repositoryId: config.repositoryId,
    deviceId: config.deviceId,
    signalingServer: config.signalingServer ?? 'PeerPigeon automatic discovery',
    refsDigest: await repository.refsDigest(),
    knownDevices: Object.keys(state.heads ?? {}).sort(),
    importedSnapshots: state.imported ?? {},
    trackedFiles,
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
  if (command === 'init') return await commandInit(args, cwd);
  if (command === 'invite') return await commandInvite(args, cwd);
  if (command === 'track') return await commandTrack(args, cwd);
  if (command === 'untrack') return await commandUntrack(args, cwd);
  if (command === 'tracked') return await commandTracked(args, cwd);
  if (command === 'sync') return await commandSync(args, cwd, verbose);
  if (command === 'watch') return await commandWatch(args, cwd, verbose);
  if (command === 'clone') return await commandClone(args, cwd, verbose);
  if (command === 'status') return await commandStatus(args, cwd);
  if (command === 'doctor') return await commandDoctor(args, cwd);
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
