import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { DEFAULT_POLL_MS, DEFAULT_SYNC_WAIT_MS } from './constants.js';
import { RepositoryCache } from './cache.js';
import { createIdentity, loadConfig, saveConfig } from './config.js';
import {
  createWatchServiceControl,
  listGitPigeonWatcherPids,
  startWatchService,
  stopWatchService,
  waitForWatchServiceRepository,
  watchServiceHasRepository,
  watchServiceStatus,
} from './daemon.js';
import { GitRepository } from './git.js';
import { createInvite, parseInvite } from './invite.js';
import { createDashboardEnrollment, serveDashboardEnrollment } from './dashboard-pairing.js';
import {
  adoptMachineIndexCapability,
  claimDashboardPairing,
  completeDashboardPairing,
  connectMachineIndexService,
  listMachinePigeons,
  loadMachineIndex,
  machineIndexRoot,
  markMachinePigeonStopped,
  markMachinePigeonsStopped,
  openDashboard,
  registerMachinePigeon,
  unregisterMachinePigeon,
} from './machine-index.js';
import {
  loadOrCreateNativeDeviceIdentity,
  openDeviceGrant,
  parseNativeCloneUrl,
  validateNativeClonePayload,
} from './device-grants.js';
import { requestLanDeviceApproval, startLanApprovalService } from './lan-enrollment.js';
import { installNativeIntegration } from './native-install.js';
import { connectPeerPigeon } from './peerpigeon.js';
import { RepositorySynchronizer } from './protocol.js';
import { WorkspaceFiles } from './workspace.js';

const HELP = `GitPigeon — real-time peer-to-peer sync for native Git

Usage:
  git pigeon init [INVITE] [DIRECTORY]
  git pigeon install [--enroll | --no-enroll]
  git pigeon enroll
  git pigeon list
  git pigeon pair [--rotate]
  git pigeon unwatch [REPOSITORY]
  git pigeon stop
  git pigeon watch [off] [--poll DURATION]
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

async function openNetwork(repository, config, log, serviceInstanceId, machineIndexId) {
  const runtime = await connectPeerPigeon(config, log);
  const synchronizer = new RepositorySynchronizer({
    repository,
    storage: runtime.storage,
    config,
    logger: log,
    serviceInstanceId,
    machineIndexId,
    streamTransport: runtime.node.mesh,
    storageWritePauseMs: 0,
    // Browser peers retain PeerPigeon records in IndexedDB while the native
    // process starts with memory storage. Let every response merge before the
    // watcher advances mutable repository records.
    mutableRecordSettleMs: 1_000,
  });
  return { runtime, synchronizer };
}

async function startIndexedWatchService(options = {}) {
  return await startWatchService({ root: machineIndexRoot(), ...options });
}

function repositorySessionSignature(config) {
  return JSON.stringify({
    repositoryId: config.repositoryId,
    secret: config.secret,
    deviceId: config.deviceId,
    signalingServer: config.signalingServer ?? null,
  });
}

async function prepareRepositorySession(entry) {
  const repository = await GitRepository.discover(entry.repository);
  const config = await loadConfig(repository.gitDir);
  return { repository, config, signature: repositorySessionSignature(config) };
}

async function openRepositorySession({ repository, config }, pollMs, log, serviceInstanceId, machineIndexId) {
  const { runtime, synchronizer } = await openNetwork(repository, config, log, serviceInstanceId, machineIndexId);
  let timer;
  let peerRefreshTimer;
  let started = false;
  let starting = false;
  let stopped = false;
  let previousDigest;
  let publishing = false;

  const publishChanges = async () => {
    if (!started || publishing || stopped) return;
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

  const activate = async () => {
    if (started || starting || stopped) return;
    starting = true;
    try {
      await synchronizer.start();
      previousDigest = await synchronizer.localDigest();
      started = true;
      timer = setInterval(() => { publishChanges().catch((error) => log.error(error)); }, pollMs);
    } catch (error) {
      log.error(error);
    } finally {
      starting = false;
    }
  };

  runtime.node.on('peerConnected', () => {
    activate().catch((error) => log.error(error));
    if (!started || peerRefreshTimer) return;
    peerRefreshTimer = setTimeout(() => {
      peerRefreshTimer = null;
      if (!stopped && runtime.node.getConnectedPeers().length > 0) {
        synchronizer.refresh().catch((error) => log.error(error));
      }
    }, 250);
  });
  activate().catch((error) => log.error(error));
  log.info(`Watching ${repository.root} as ${config.deviceId.slice(0, 8)}`);

  return {
    async close() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (peerRefreshTimer) clearTimeout(peerRefreshTimer);
      while (starting || publishing) await sleep(10);
      await synchronizer.stop();
      await runtime.close();
    },
  };
}

async function runWatchService({ root, token, pollMs, verbose = false }) {
  const log = logger(verbose);
  const serviceInstanceId = randomBytes(16).toString('hex');
  const machineIndexId = (await loadMachineIndex({ root })).publisherId;
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

  const sessions = new Map();
  const repositoryErrors = new Map();
  let control;
  let machineIndex;
  let lanApprovals;
  let reconciliationTimer;
  let reconciling = false;

  const publishServiceRepositoryState = async () => {
    if (!control) return;
    await control.setRepositoryState(
      [...sessions.entries()]
        .filter(([, record]) => record.session && !record.cancelled)
        .map(([repositoryRoot]) => repositoryRoot),
      Object.fromEntries(repositoryErrors),
    );
  };

  const stopSession = async (record) => {
    record.cancelled = true;
    try {
      const session = record.session ?? await record.opening;
      await session?.close();
    } catch (error) {
      log.error(error);
    }
  };

  const launchSession = async (entry) => {
    const existing = sessions.get(entry.repository);
    const desiredSignature = repositorySessionSignature(entry);
    if (existing?.signature === desiredSignature && !existing.cancelled) {
      // `git pigeon watch` refreshes the durable registration with a null PID
      // before asking this service to load it. If this session is already open,
      // restore the service PID instead of leaving the index/browser view stale.
      if (existing.session && entry.pid !== process.pid) {
        await registerMachinePigeon(existing.prepared.repository, existing.prepared.config, {
          root,
          pid: process.pid,
        });
        repositoryErrors.delete(entry.repository);
        await publishServiceRepositoryState();
      }
      return;
    }
    let prepared;
    try {
      prepared = await prepareRepositorySession(entry);
    } catch (error) {
      repositoryErrors.set(entry.repository, error.message);
      await publishServiceRepositoryState();
      log.error(new Error(`Could not watch ${entry.repository}: ${error.message}`));
      return;
    }
    if (existing) {
      sessions.delete(entry.repository);
      await stopSession(existing);
    }
    const record = {
      prepared,
      signature: prepared.signature,
      cancelled: false,
      session: null,
      opening: null,
    };
    sessions.set(entry.repository, record);
    repositoryErrors.delete(entry.repository);
    await publishServiceRepositoryState();
    record.opening = openRepositorySession(prepared, pollMs, log, serviceInstanceId, machineIndexId)
      .then(async (session) => {
        record.session = session;
        if (record.cancelled) {
          await session.close();
        } else {
          await registerMachinePigeon(prepared.repository, prepared.config, { root, pid: process.pid });
          repositoryErrors.delete(entry.repository);
        }
        await publishServiceRepositoryState();
        return session;
      })
      .catch(async (error) => {
        repositoryErrors.set(entry.repository, error.message);
        log.error(new Error(`Watcher failed for ${entry.repository}: ${error.message}`));
        if (sessions.get(entry.repository) === record) sessions.delete(entry.repository);
        await markMachinePigeonStopped(prepared.repository, { root, pid: process.pid });
        await publishServiceRepositoryState();
        return null;
      });
  };

  const reconcile = async () => {
    if (reconciling || stopping) return;
    reconciling = true;
    try {
      const entries = await listMachinePigeons({ root, activeOnly: false });
      const desired = new Set(entries.map((entry) => entry.repository));
      for (const [repositoryRoot, record] of sessions) {
        if (desired.has(repositoryRoot)) continue;
        sessions.delete(repositoryRoot);
        repositoryErrors.delete(repositoryRoot);
        await stopSession(record);
      }
      for (const entry of entries) await launchSession(entry);
      await publishServiceRepositoryState();
    } catch (error) {
      log.error(error);
    } finally {
      reconciling = false;
    }
  };

  try {
    control = await createWatchServiceControl(root, token, stop);
    await reconcile();
    machineIndex = await connectMachineIndexService(log, { root, serviceInstanceId });
    try {
      lanApprovals = await startLanApprovalService(machineIndex, {
        logger: log,
        onDeviceRequest: (request) => {
          log.info(`Approval requested by ${request.deviceName} on the local LAN`);
        },
      });
      log.debug('LAN device approval listener is ready');
    } catch (error) {
      // Multicast may be disabled by an OS firewall or network policy. The
      // repository watcher and all already-approved devices must keep working.
      log.warn(`LAN device approval is unavailable: ${error.message}`);
    }
    reconciliationTimer = setInterval(() => { reconcile().catch((error) => log.error(error)); }, 500);
    await control.ready();
    log.info(`GitPigeon service is watching ${sessions.size} ${sessions.size === 1 ? 'repository' : 'repositories'} as PID ${process.pid}`);
    await stopped;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (reconciliationTimer) clearInterval(reconciliationTimer);
    while (reconciling) await sleep(10);
    for (const record of sessions.values()) await stopSession(record);
    await markMachinePigeonsStopped({ root, pid: process.pid });
    if (lanApprovals) await lanApprovals.close();
    if (machineIndex) await machineIndex.close();
    if (control) await control.close();
  }
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
  const indexRoot = machineIndexRoot();
  const wasRegistered = (await listMachinePigeons({ root: indexRoot, activeOnly: false }))
    .some((entry) => entry.repository === repository.root);
  await registerMachinePigeon(repository, config, {
    root: indexRoot,
    pid: null,
  });
  const pairing = await claimDashboardPairing();
  if (pairing) {
    // The index capability may have changed. Restart the one service so its
    // PeerPigeon node is created with the durable index's current secret.
    await stopWatchService(indexRoot);
  }
  const watcher = await startIndexedWatchService({ verbose });
  await waitForWatchServiceRepository(indexRoot, repository.root);
  if (pairing) {
    await runDashboardPairing(pairing, verbose);
  }

  if (created && !invite) {
    console.log('GitPigeon initialized and watching in the background.');
    console.log('Share this invite only with trusted collaborators:\n');
    console.log(createInvite(config));
  } else if (created) {
    console.log(`GitPigeon joined at ${repository.root} and is syncing in the background.`);
  } else {
    const state = watcher.started
      ? 'started the machine-wide watcher service'
      : wasRegistered
        ? 'is already registered with the machine-wide watcher service'
        : 'was added to the machine-wide watcher service';
    console.log(`GitPigeon is configured and ${state}.`);
  }
  const discovered = await workspace.list();
  if (discovered.length) console.log(`Private files: ${discovered.length} automatically protected from Git.`);
  console.log('Remove this repository from the encrypted Pigeon index with `git pigeon unwatch`.');
  console.log('Stop the machine-wide GitPigeon service with `git pigeon stop`.');
}

async function runDashboardPairing(pairing, verbose = false, {
  automatic = false,
  nativeDevicePublicKey = null,
} = {}) {
  const persistentDeviceKey = nativeDevicePublicKey
    ?? (await loadOrCreateNativeDeviceIdentity({ root: pairing.root })).publicKey;
  const enrollment = createDashboardEnrollment(
    pairing.index,
    process.env.GITPIGEON_DASHBOARD_URL ?? 'https://gitpigeon.dev/',
    { automatic, nativeDevicePublicKey: persistentDeviceKey },
  );
  if (automatic) {
    console.log('Opening gitpigeon.dev to finish this approved device automatically.');
  } else {
    console.log(`Browser approval code: ${enrollment.displayCode}`);
    console.log('Enter this code at gitpigeon.dev within two minutes.');
  }
  const result = await serveDashboardEnrollment(enrollment, {
    logger: logger(verbose),
    onReady: () => {
      let opened = false;
      try {
        opened = openDashboard(enrollment.url);
      } catch (error) {
        console.warn(`Could not open the GitPigeon dashboard automatically: ${error.message}`);
      }
      if (!opened) console.log(`Open this one-time enrollment URL:\n${enrollment.url}`);
    },
  });
  await completeDashboardPairing(pairing.index, { root: pairing.root });
  console.log(`Securely paired browser ${result.browserId.slice(0, 16)}…; the permanent index secret was never placed in the URL.`);
}

async function commandEnroll(args, verbose) {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const root = machineIndexRoot();
  const identity = await loadOrCreateNativeDeviceIdentity({ root });
  console.log('Looking for an approved GitPigeon browser on the PeerPigeon mesh…');
  const { request, grant } = await requestLanDeviceApproval(identity, {
    logger: logger(verbose),
    onRequest: (value) => {
      console.log(`Authorize “${value.deviceName}” in an already-approved GitPigeon browser.`);
    },
  });
  if (grant.requestId !== request.requestId || !grant.index) {
    throw new Error('The approved device grant did not contain a GitPigeon index capability');
  }
  await stopWatchService(root);
  const index = await adoptMachineIndexCapability(grant.index, { root });
  const pairing = await claimDashboardPairing({ root, force: true });
  await startWatchService({ root, verbose });
  await runDashboardPairing(pairing, verbose, {
    automatic: true,
    nativeDevicePublicKey: identity.publicKey,
  });
  console.log(`This device is now approved for GitPigeon index ${index.indexId.slice(0, 10)}.`);
}

async function commandInstall(args, verbose) {
  const enroll = takeFlag(args, '--enroll');
  const noEnroll = takeFlag(args, '--no-enroll');
  if (enroll && noEnroll) throw new Error('--enroll and --no-enroll cannot be combined');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  await loadOrCreateNativeDeviceIdentity();
  const installed = await installNativeIntegration();
  console.log(`Installed the native git pigeon command at ${installed.commandPath}.`);
  console.log('Registered gitpigeon:// clone links with this operating system.');
  let existing = null;
  try { existing = await loadMachineIndex({ create: false }); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (noEnroll || (!enroll && existing?.pairingComplete)) {
    if (existing) await startWatchService({ root: machineIndexRoot(), verbose });
    return;
  }
  await commandEnroll([], verbose);
}

async function commandPair(args, verbose) {
  const rotate = takeFlag(args, '--rotate');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const root = machineIndexRoot();
  const registrations = await listMachinePigeons({ root, activeOnly: false });
  await stopWatchService(root);
  const pairing = await claimDashboardPairing({ force: true, rotate });
  if (registrations.length) await startWatchService({ root, verbose });
  await runDashboardPairing(pairing, verbose);
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
    await runtime.waitForPeer({ timeoutMs: Math.max(waitMs, DEFAULT_SYNC_WAIT_MS) });
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
  const serviceToken = takeOption(args, '--service-child');
  const stateDir = takeOption(args, '--state-dir');
  const legacyDaemonToken = takeOption(args, '--daemon-child');
  if (pollMs < 100) throw new Error('Poll interval must be at least 100ms');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (legacyDaemonToken) throw new Error('Per-repository GitPigeon watcher processes are no longer supported');
  if (serviceToken) {
    if (!foreground || !stateDir) throw new Error('Invalid GitPigeon service invocation');
    return await runWatchService({ root: path.resolve(stateDir), token: serviceToken, pollMs, verbose });
  }
  if (stateDir) throw new Error('--state-dir is reserved for the GitPigeon service');
  if (foreground) throw new Error('GitPigeon foreground watching is managed by its single machine-wide service');

  const { repository, config } = await configuredRepository(cwd);
  const root = machineIndexRoot();
  const wasRegistered = (await listMachinePigeons({ root, activeOnly: false }))
    .some((entry) => entry.repository === repository.root);
  await registerMachinePigeon(repository, config, {
    root,
    pid: null,
  });
  const result = await startWatchService({ root, pollMs, verbose });
  await waitForWatchServiceRepository(root, repository.root);
  console.log(result.started
    ? 'GitPigeon started the machine-wide background service and is now watching this repository.'
    : wasRegistered
      ? 'GitPigeon is already watching this repository in the machine-wide background service.'
      : 'GitPigeon added this repository to the already-running machine-wide background service.');
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
  const registrations = await listMachinePigeons({ activeOnly: false });
  const service = await watchServiceStatus(machineIndexRoot());
  const repositories = watchedRepositories(registrations);
  if (!repositories.length) {
    console.log('The persistent GitPigeon index is empty.');
    return;
  }
  const nameWidth = Math.max('NAME'.length, ...repositories.map(({ name }) => name.length));
  console.log(`${'NAME'.padEnd(nameWidth)}  PIGEON      STATUS   PATH`);
  for (const repository of repositories) {
    const active = watchServiceHasRepository(service, repository.root);
    console.log(`${repository.name.padEnd(nameWidth)}  ${repository.repositoryId.slice(0, 10)}  ${(active ? 'watching' : 'stopped').padEnd(8)} ${repository.root}`);
  }
}

async function commandUnwatch(args, cwd) {
  const name = args.shift();
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (!name) {
    const { repository } = await configuredRepository(cwd);
    const result = await unregisterMachinePigeon(repository);
    if (result.removed) console.log('Removed this repository from the encrypted PeerPigeon index. The machine-wide service is still running.');
    else console.log('This repository was not being watched.');
    return;
  }

  const registrations = await listMachinePigeons({ activeOnly: false });
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
  console.log(`Removed ${match.name} from the encrypted PeerPigeon index. The machine-wide service is still running.`);
}

export async function commandStop(args, {
  indexRoot,
  findWatcherPids = listGitPigeonWatcherPids,
} = {}) {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const root = indexRoot ?? machineIndexRoot();
  const registrations = await listMachinePigeons({ root, activeOnly: false });
  const stoppedService = await stopWatchService(root);
  let discoveredPids;
  try {
    discoveredPids = await findWatcherPids();
  } catch (error) {
    throw new Error(`Could not enumerate local GitPigeon watcher processes: ${error.message}`);
  }

  const pids = [...new Set([
    ...discoveredPids,
  ])].filter((pid) => pid !== process.pid && processIsRunning(pid));

  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* watcher already exited */ }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(processIsRunning)) await sleep(50);
  let remaining = pids.filter(processIsRunning);
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* watcher already exited */ }
  }
  const forceDeadline = Date.now() + 2_000;
  while (Date.now() < forceDeadline && remaining.some(processIsRunning)) await sleep(50);
  remaining = remaining.filter(processIsRunning);
  if (remaining.length) throw new Error(`Could not stop ${remaining.length} local GitPigeon watcher${remaining.length === 1 ? '' : 's'}`);
  for (const registration of registrations) {
    await markMachinePigeonStopped(
      { root: registration.repository },
      { root, pid: registration.pid },
    );
  }
  if (!stoppedService.stopped && !pids.length) {
    console.log('The GitPigeon watcher service was not running. The persistent encrypted Pigeon index was left intact.');
    return;
  }
  console.log('Stopped the GitPigeon watcher service. The persistent encrypted Pigeon index was left intact.');
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

function safeRepositoryDirectoryName(value, repositoryId) {
  const fallback = `pigeon-${repositoryId.slice(0, 10)}`;
  const name = String(value || fallback)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^\.+|[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return name || fallback;
}

async function availableCloneTarget(base, name) {
  for (let suffix = 1; suffix < 1_000; suffix += 1) {
    const target = path.join(base, suffix === 1 ? name : `${name}-${suffix}`);
    try {
      const entries = await readdir(target);
      if (entries.length === 0) return target;
    } catch (error) {
      if (error?.code === 'ENOENT') return target;
      throw error;
    }
  }
  throw new Error(`Could not choose an unused clone directory below ${base}`);
}

async function commandProtocol(args, verbose) {
  const value = args.shift();
  if (!value) throw new Error('The GitPigeon protocol handler requires an encrypted clone URL');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const identity = await loadOrCreateNativeDeviceIdentity();
  const envelope = parseNativeCloneUrl(value);
  const grant = openDeviceGrant(identity, envelope, { purpose: 'clone' });
  const repository = validateNativeClonePayload(grant);
  const base = path.resolve(process.env.GITPIGEON_CLONE_DIR ?? path.join(homedir(), 'GitPigeon'));
  await mkdir(base, { recursive: true });
  const target = await availableCloneTarget(
    base,
    safeRepositoryDirectoryName(repository.name, repository.repositoryId),
  );
  const invite = createInvite(repository);
  await commandInit([invite, target], process.cwd(), verbose);
  console.log(`Cloned ${repository.name} to ${target}.`);
}

async function commandStatus(args, cwd) {
  const json = takeFlag(args, '--json');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  const cache = new RepositoryCache(repository.gitDir);
  const trackedFiles = await new WorkspaceFiles(repository, cache).list();
  const state = await cache.loadState();
  const watcher = await watchServiceStatus(machineIndexRoot());
  const registered = watchServiceHasRepository(watcher, repository.root);
  const value = {
    repository: repository.root,
    repositoryId: config.repositoryId,
    deviceId: config.deviceId,
    signalingServer: config.signalingServer ?? 'PeerPigeon automatic discovery',
    refsDigest: await repository.refsDigest(),
    knownDevices: Object.keys(state.heads ?? {}).sort(),
    importedSnapshots: state.imported ?? {},
    trackedFiles,
    watching: watcher.running && registered,
    watcherPid: watcher.running && registered ? watcher.pid : null,
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
  if (command === 'install') return await commandInstall(args, verbose);
  if (command === 'enroll') return await commandEnroll(args, verbose);
  if (command === 'list') return await commandList(args);
  if (command === 'pair') return await commandPair(args, verbose);
  if (command === 'invite') return await commandInvite(args, cwd);
  if (command === 'track') return await commandTrack(args, cwd);
  if (command === 'untrack') return await commandUntrack(args, cwd);
  if (command === 'tracked') return await commandTracked(args, cwd);
  if (command === 'sync') return await commandSync(args, cwd, verbose);
  if (command === 'watch') return await commandWatch(args, cwd, verbose);
  if (command === 'unwatch') return await commandUnwatch(args, cwd);
  if (command === 'stop') return await commandStop(args);
  if (command === 'clone') return await commandClone(args, cwd, verbose);
  if (command === 'protocol') return await commandProtocol(args, verbose);
  if (command === 'status') return await commandStatus(args, cwd);
  if (command === 'doctor') return await commandDoctor(args, cwd);
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
