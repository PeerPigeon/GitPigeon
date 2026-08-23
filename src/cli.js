import { watch as watchFilesystem } from "node:fs";
import { randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { deviceHostName } from './device-name.js';
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
import { isPairLink, parsePairLink } from './pair-link.js';
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
import { startDeviceApprovalResponder } from './device-approval-mesh.js';
import { requestLanDeviceApproval, startLanApprovalService } from './lan-enrollment.js';
import { installNativeIntegration } from './native-install.js';
import { ControlServer } from './control-server.js';
import { RepositorySynchronizer } from './protocol.js';
import { TerminalServer } from './terminal-server.js';
import { RealtimeWorkspaceServer } from './realtime-server.js';
import { WorkspaceFiles } from './workspace.js';
import { clearInstalledUpdate, startAutomaticUpdates } from './auto-update.js';
import { GITPIGEON_VERSION, IS_STANDALONE } from './version.js';

const HELP = `GitPigeon — real-time peer-to-peer sync for native Git

Getting started
  1. Install GitPigeon on this machine.
  2. Open gitpigeon.dev and run \`git pigeon pair\`, then confirm the code.
  3. In any repository you want to sync, run \`git pigeon init\`.

Pair a browser or device
  git pigeon pair                       Approve whatever is waiting, and
                                        print a link for a device elsewhere
  git pigeon pair LINK                  Join an index from a pairing link
  git pigeon pair --rotate              Replace the index secret first
                                        (everything paired pairs again)

Repositories
  git pigeon init [INVITE] [DIR]        Start syncing a repository
  git pigeon unwatch [REPO]             Stop syncing one
  git pigeon list                       Show what this machine syncs
  git pigeon invite                     Print an invite for one repository
  git pigeon sync [--wait D] [--force]  Sync once and exit

Private files
  git pigeon track FILE...              Sync a file, never committing it
  git pigeon untrack FILE...            Stop syncing it privately
  git pigeon tracked                    List privately synced files

Background service
  git pigeon start [--poll D]           Start the watcher
  git pigeon restart [--poll D]         Restart it
  git pigeon stop                       Stop it

Checking on things
  git pigeon status [--json]            Show this repository's sync state
  git pigeon doctor                     Check this machine's setup

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

function commandTerminalDevice(args) {
  let devices = [];
  try {
    const value = JSON.parse(Buffer.from(process.env.GITPIGEON_DEVICE_ROSTER ?? '', 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length > 0 && value.length <= 64) {
      devices = value.map((entry) => String(entry?.name ?? 'device').slice(0, 120));
    }
  } catch { /* invalid rosters are reported below */ }
  const command = args.shift() ?? 'list';
  if (args.length) throw new Error('Usage: device list | device <number>');
  if (command === 'list') {
    if (!devices.length) throw new Error('No GitPigeon terminal devices are available.');
    devices.forEach((name, index) => console.log(`${index}  ${index === 0 ? '[this device] ' : ''}${name}`));
    return;
  }
  if (/^\d+$/.test(command) && Number(command) < devices.length) {
    process.stdout.write(`\u001b]777;gitpigeon-device=${Number(command)}\u0007`);
    return;
  }
  throw new Error('Usage: device list | device <number>');
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

// One node, one room. Every repository rides the machine's single index node,
// which is what browsers already do, instead of opening a PeerPigeon room per
// repository that no browser ever joins.
function openNetwork(repository, config, log, serviceInstanceId, machineIndexId, node) {
  if (!node?.storage) throw new Error('The GitPigeon index mesh is not connected');
  const synchronizer = new RepositorySynchronizer({
    repository,
    storage: node.storage,
    config,
    logger: log,
    serviceInstanceId,
    machineIndexId,
    deviceName: deviceHostName(),
    // The snapshot channel rides PeerPigeon's encrypted, mesh-routed direct
    // messages, so it takes the node facade rather than the raw mesh.
    streamTransport: node,
    storageWritePauseMs: 0,
  });
  return { synchronizer };
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

async function openRepositorySession({ repository, config }, pollMs, log, serviceInstanceId, machineIndexId, node) {
  const { synchronizer } = openNetwork(repository, config, log, serviceInstanceId, machineIndexId, node);
  const terminalServer = new TerminalServer({
    node,
    repository,
    secret: config.secret,
    repositoryId: config.repositoryId,
    serviceInstanceId,
    deviceName: deviceHostName(),
    logger: log,
  });
  terminalServer.start();
  const realtimeServer = new RealtimeWorkspaceServer({
    node,
    repository,
    secret: config.secret,
    repositoryId: config.repositoryId,
    logger: log,
    onFileWritten: () => schedulePublish(),
  });
  let changeTimer;
  let filesystemWatcher;
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

  const schedulePublish = () => {
    if (changeTimer) clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      changeTimer = null;
      publishChanges().catch((error) => log.error(error));
    }, pollMs);
  };

  const activate = async () => {
    if (started || starting || stopped) return;
    starting = true;
    try {
      await realtimeServer.start();
      await synchronizer.start();
      previousDigest = await synchronizer.localDigest();
      started = true;
      filesystemWatcher = watchFilesystem(repository.root, { recursive: true }, (_event, filename) => {
        const changed = String(filename ?? "").replaceAll("\\", "/");
        if (changed === ".git/gitpigeon" || changed.startsWith(".git/gitpigeon/")) return;
        realtimeServer.filesystemChanged(changed).catch((error) => log.error(error));
        schedulePublish();
      });
      filesystemWatcher.on("error", (error) => log.error(error));
    } catch (error) {
      log.error(error);
    } finally {
      starting = false;
    }
  };

  const onPeerConnected = () => {
    activate().catch((error) => log.error(error));
    if (!started || peerRefreshTimer) return;
    peerRefreshTimer = setTimeout(() => {
      peerRefreshTimer = null;
      if (!stopped && node.getConnectedPeers().length > 0) {
        synchronizer.refresh().catch((error) => log.error(error));
      }
    }, 250);
  };
  node.on('peerConnected', onPeerConnected);
  activate().catch((error) => log.error(error));
  log.info(`Watching ${repository.root} as ${config.deviceId.slice(0, 8)}`);

  return {
    async close() {
      if (stopped) return;
      stopped = true;
      if (changeTimer) clearTimeout(changeTimer);
      filesystemWatcher?.close();
      if (peerRefreshTimer) clearTimeout(peerRefreshTimer);
      node.off('peerConnected', onPeerConnected);
      terminalServer.stop();
      realtimeServer.stop();
      while (starting || publishing) await sleep(10);
      await synchronizer.stop();
      // The node belongs to the machine index service, not to this session.
    },
  };
}

/**
 * Offer pairing for as long as this machine is running, with no deadline.
 *
 * Pairing used to be offered only while `install` or `pair` sat in the
 * foreground, and only for a few minutes. Install two machines, open a browser
 * a minute later, and nothing answered because both commands had already
 * exited. The watcher is the long-lived thing, so it is what listens.
 */
async function startPairingService(root, log) {
  const responder = await startDeviceApprovalResponder({
    logger: log,
    // A browser this machine offered itself to can ask it to join the index it
    // settled on, which is how several machines end up together.
    onAdopt: async (capability) => {
      if (!capability?.index?.indexId) return;
      const current = await loadMachineIndex({ root });
      if (current.indexId === capability.index.indexId) return;
      await adoptMachineIndexCapability(capability.index, { root });
      log.info?.(`Joined GitPigeon index ${String(capability.index.indexId).slice(0, 10)}; restarting`);
      await stopWatchService(root);
      await startWatchService({ root });
    },
  });
  const offered = new Set();
  let closed = false;

  const tick = async () => {
    if (closed) return;
    const index = await loadMachineIndex({ root });
    // Every watcher offers to every browser that is not yet approved. Gating
    // this on a stored "already paired" flag was worse than useless: the flag
    // could be set while no browser held anything, and the machine would then
    // refuse to pair with any browser ever again. The person confirming the
    // code in the browser is the check that matters.
    const identity = await loadOrCreateNativeDeviceIdentity({ root });
    for (const request of responder.pending()) {
      if (request.requesterKind !== 'browser' || offered.has(request.requestId)) continue;
      offered.add(request.requestId);
      const code = await responder.codeFor(request.requestId).catch(() => null);
      if (!code) continue;
      log.info?.(`${request.deviceName} is asking to pair. Approve it there if it shows ${code}.`);
      const { confirmed } = await responder.approve(request.requestId, {
        index: { indexId: index.indexId, secret: index.secret, publisherId: index.publisherId },
        nativeDevicePublicKey: identity.publicKey,
        deviceName: deviceHostName(),
        repositories: [],
      });
      if (!confirmed) continue;
      await completeDashboardPairing(index, { root }).catch((error) => log.debug?.(error.message));
      log.info?.(`Paired ${request.deviceName}.`);
    }
  };

  const timer = setInterval(() => { tick().catch((error) => log.debug?.(error.message)); }, 1_000);
  timer.unref?.();
  tick().catch((error) => log.debug?.(error.message));
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await responder.close().catch(() => {});
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
  let indexWatcher;
  let reconciling = false;
  let automaticUpdates;
  let installedUpdate;
  let controlServer;
  let pairingService;
  let restartAfterRotation = false;

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
    record.opening = openRepositorySession(prepared, pollMs, log, serviceInstanceId, machineIndexId, machineIndex.node)
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
    // Every session rides the machine index node, so nothing can start before
    // it exists.
    if (reconciling || stopping || !machineIndex) return;
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

  const scheduleReconcile = () => {
    if (reconciliationTimer) clearTimeout(reconciliationTimer);
    reconciliationTimer = setTimeout(() => {
      reconciliationTimer = null;
      reconcile().catch((error) => log.error(error));
    }, 100);
  };

  try {
    control = await createWatchServiceControl(root, token, stop);
    machineIndex = await connectMachineIndexService(log, {
      root,
      serviceInstanceId,
      onRemoteRepositories: async (repositories) => {
        const added = await materializeGrantedRepositories(repositories, { root });
        if (!added.length) return;
        log.info("PeerPigeon index added " + added.length + " shared " + (added.length === 1 ? "repository" : "repositories"));
        await reconcile();
      },
    });
    await reconcile();
    // Keep offering to pair for as long as this machine runs, so a browser
    // opened at any time is answered.
    pairingService = await startPairingService(root, log);
    // Paired peers can remove a repository or rotate the index secret.
    controlServer = new ControlServer({
      node: machineIndex.node,
      indexId: machineIndex.index.indexId,
      root,
      logger: log,
      onChanged: () => reconcile(),
      onRotated: () => {
        // The node was built with the previous secret, so it can no longer
        // reach anything paired with the new one. Restart rather than keep
        // running a mesh session nobody can decrypt.
        restartAfterRotation = true;
        stop();
      },
    });
    controlServer.start();
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
    indexWatcher = watchFilesystem(root, (_event, filename) => {
      if (String(filename ?? "") === "index.json") scheduleReconcile();
    });
    indexWatcher.on("error", (error) => log.error(error));
    await control.ready();
    log.info(`GitPigeon service is watching ${sessions.size} ${sessions.size === 1 ? 'repository' : 'repositories'} as PID ${process.pid}`);
    automaticUpdates = startAutomaticUpdates({
      enabled: IS_STANDALONE,
      root,
      currentVersion: GITPIGEON_VERSION,
      logger: log,
      onUpdate: async (update) => {
        installedUpdate = update;
        stop();
      },
    });
    await stopped;
  } finally {
    automaticUpdates?.stop();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (reconciliationTimer) clearTimeout(reconciliationTimer);
    indexWatcher?.close();
    while (reconciling) await sleep(10);
    for (const record of sessions.values()) await stopSession(record);
    await markMachinePigeonsStopped({ root, pid: process.pid });
    controlServer?.stop();
    if (pairingService) await pairingService.close();
    if (lanApprovals) await lanApprovals.close();
    if (machineIndex) await machineIndex.close();
    if (control) await control.close();
  }
  if (restartAfterRotation && !installedUpdate) {
    log.info('Restarting the watcher service on the rotated index secret');
    await startWatchService({ root, pollMs, verbose });
    return;
  }
  if (installedUpdate) {
    try {
      await startWatchService({ root, pollMs, verbose });
    } catch (error) {
      await clearInstalledUpdate(root, installedUpdate.executable);
      log.error(new Error(`GitPigeon ${installedUpdate.version} could not start; restoring ${GITPIGEON_VERSION}: ${error.message}`));
      await startWatchService({ root, pollMs, verbose, entrypoint: process.execPath });
    }
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
  const watcher = await startIndexedWatchService({ verbose });
  await waitForWatchServiceRepository(indexRoot, repository.root);

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
  // Registering a repository is not pairing a browser. Running the enrolment
  // flow from here interrupted an unrelated command and asked for a code as
  // though a browser already paired with this machine were a new one.
  const machineIndex = await loadMachineIndex({ root: indexRoot });
  if (!machineIndex.pairingComplete) {
    console.log('\nNo browser is paired with this machine yet. Run `git pigeon pair` to add one.');
  }
  const discovered = await workspace.list();
  if (discovered.length) console.log(`Private files: ${discovered.length} automatically protected from Git.`);
  console.log('Remove this repository from the encrypted Pigeon index with `git pigeon unwatch`.');
  console.log('Stop the machine-wide GitPigeon service with `git pigeon stop`.');
}

async function runDashboardPairing(pairing, verbose = false, {
  automatic = false,
  nativeDevicePublicKey = null,
  open = true,
} = {}) {
  const persistentDeviceKey = nativeDevicePublicKey
    ?? (await loadOrCreateNativeDeviceIdentity({ root: pairing.root })).publicKey;
  const enrollment = createDashboardEnrollment(
    pairing.index,
    process.env.GITPIGEON_DASHBOARD_URL ?? 'https://gitpigeon.dev/',
    { automatic, nativeDevicePublicKey: persistentDeviceKey },
  );
  if (!open) {
    // The device joining is somewhere else entirely, so there is nothing to
    // open here. The capability travels encrypted inside the link fragment and
    // is useless without the code, which goes over a different channel.
    console.log('\nSend this one-time link to the device you want to add:\n');
    console.log(`  ${enrollment.url}\n`);
    console.log(`Then read it this code so it can decrypt the link: ${enrollment.displayCode}`);
    console.log('The link expires in two minutes. Send the code by a different route than the link.\n');
    console.log('Waiting for that device to accept…');
  } else if (automatic) {
    console.log('Opening gitpigeon.dev to finish this approved device automatically.');
  } else {
    console.log(`Browser approval code: ${enrollment.displayCode}`);
    console.log('Enter this code at gitpigeon.dev within two minutes.');
  }
  const result = await serveDashboardEnrollment(enrollment, {
    logger: logger(verbose),
    onReady: () => {
      if (!open) return;
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
  const added = await materializeGrantedRepositories(grant.repositories, { root });
  const pairing = await claimDashboardPairing({ root, force: true });
  await startWatchService({ root, verbose });
  await Promise.all(added.map(({ repository }) => (
    waitForWatchServiceRepository(root, repository.root)
  )));
  await runDashboardPairing(pairing, verbose, {
    automatic: true,
    nativeDevicePublicKey: identity.publicKey,
  });
  if (added.length) console.log("Added " + added.length + " shared " + (added.length === 1 ? "repository" : "repositories") + " to the persistent native index.");
  console.log(`This device is now approved for GitPigeon index ${index.indexId.slice(0, 10)}.`);
}

/**
 * Print the code each browser should be showing, so the person can compare it
 * without going to find the service log. The background service does the
 * granting; this only reports, and gives up so the terminal comes back.
 */
async function reportPairingCodes(log, { timeoutMs = 2 * 60_000 } = {}) {
  let responder;
  try {
    responder = await startDeviceApprovalResponder({ logger: log });
  } catch (error) {
    log.debug?.(`Pairing discovery unavailable: ${error.message}`);
    return;
  }
  const seen = new Set();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      for (const request of responder.pending()) {
        if (request.requesterKind !== 'browser' || seen.has(request.requestId)) continue;
        const code = await responder.codeFor(request.requestId).catch(() => null);
        if (!code) continue;
        seen.add(request.requestId);
        console.log(`\n  ${request.deviceName} is asking to pair.`);
        console.log(`  Approve it there if it shows this code: ${code}\n`);
      }
      await sleep(500);
    }
    if (!seen.size) {
      console.log('\nNo browser asked to pair yet. This machine keeps offering;');
      console.log('run `git pigeon pair` to see codes again.');
    }
  } finally {
    await responder.close().catch(() => {});
  }
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
    // An already-paired machine still pairs new browsers, and the person
    // installing still needs the code to compare. Returning silently here left
    // them with nothing on screen at all.
    if (!noEnroll) await reportPairingCodes(logger(verbose));
    return;
  }
  // A machine that has never paired a browser and has no repositories is the
  // first device, not one joining somebody else's — whether or not a state file
  // happens to exist. Sending it to enroll deadlocked a new user: it waited for
  // an already-approved browser, while the only browser open was waiting for
  // this machine. Here it owns the index and approves the browser instead.
  //
  // Keying this on the absence of a file was not enough: an abandoned or
  // half-finished setup leaves one behind, and that machine is still
  // unconfigured.
  const unconfigured = !existing
    || (!existing.pairingComplete && (existing.entries?.length ?? 0) === 0);
  if (!enroll && unconfigured) {
    const root = machineIndexRoot();
    const log = logger(verbose);
    // The service offers pairing for as long as it runs, so this command does
    // not need to hold the terminal open waiting for a browser.
    await startWatchService({ root, verbose });
    console.log('\nThis machine is ready to pair and will keep offering.');

    // It may also be joining a setup that already exists, which only an
    // approved browser elsewhere can authorize. Announce for a while so that
    // browser can prompt, then leave the service listening either way.
    const identity = await loadOrCreateNativeDeviceIdentity({ root });
    const joined = await requestLanDeviceApproval(identity, {
      timeoutMs: 30_000,
      logger: log,
      onRequest: () => console.log('Announced this machine to any approved GitPigeon browser.'),
    }).catch(() => null);

    if (joined?.grant?.index) {
      await stopWatchService(root);
      const index = await adoptMachineIndexCapability(joined.grant.index, { root });
      const added = await materializeGrantedRepositories(joined.grant.repositories, { root });
      await startWatchService({ root, verbose });
      if (added.length) console.log(`Added ${added.length} shared ${added.length === 1 ? 'repository' : 'repositories'}.`);
      console.log(`This device joined GitPigeon index ${index.indexId.slice(0, 10)}.`);
      await reportPairingCodes(log);
      return;
    }

    const dashboard = process.env.GITPIGEON_DASHBOARD_URL ?? 'https://gitpigeon.dev/';
    console.log(`\nOpen ${dashboard} and approve this machine when it shows a code.`);
    openDashboard(dashboard);
    await reportPairingCodes(log);
    return;
  }
  await commandEnroll([], verbose);
  await reportPairingCodes(logger(verbose));
}

async function commandPairDashboard(args, verbose) {
  const rotate = takeFlag(args, '--rotate');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const root = machineIndexRoot();
  const registrations = await listMachinePigeons({ root, activeOnly: false });
  await stopWatchService(root);
  const pairing = await claimDashboardPairing({ force: true, rotate });
  if (registrations.length) await startWatchService({ root, verbose });
  await runDashboardPairing(pairing, verbose);
}

// Joining the mesh, dialling a peer, and receiving a gossip announcement takes
// far longer than it feels like it should. Saying anything about what is or is
// not out there before that has had time to happen is just wrong, so the hint
// waits for the mesh to connect and then for a real window on top of that.
const DISCOVERY_HINT_MS = 20_000;

function pairingLabel(request) {
  if (request.requesterKind === 'browser') {
    const where = request.platform && request.platform !== 'browser' ? ` on ${request.platform}` : '';
    return `${request.deviceName}${where} (browser)`;
  }
  return `${request.deviceName} (${request.platform}/${request.arch})`;
}

async function readLine(prompt) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/**
 * A one-time link for a device that cannot hear this machine's discovery
 * announcements — anything on another network. The capability travels
 * encrypted inside the fragment and needs a separate six-digit code to open,
 * so an intercepted link is not enough on its own.
 *
 * Served alongside local discovery so both routes are always available; the
 * short expiry is refreshed for as long as the command is waiting.
 */
function startPairingLink(root, verbose, log) {
  let cancelled = false;
  let current = null;
  const serve = async () => {
    while (!cancelled) {
      const pairing = await claimDashboardPairing({ root, force: true, rotate: false });
      if (!pairing) return null;
      if (pairing.rotated) {
        // The running service still holds the previous secret, so it has to
        // come back on the new one or the paired device will not find it.
        await stopWatchService(root);
        await startWatchService({ root, verbose });
      }
      const identity = await loadOrCreateNativeDeviceIdentity({ root });
      const enrollment = createDashboardEnrollment(
        pairing.index,
        process.env.GITPIGEON_DASHBOARD_URL ?? 'https://gitpigeon.dev/',
        { automatic: false, nativeDevicePublicKey: identity.publicKey },
      );
      current = enrollment;
      console.log('\nOr send this one-time link to a device on another network:\n');
      console.log(`  ${enrollment.url}\n`);
      console.log(`  code ${enrollment.displayCode}   (send it by a different route than the link)\n`);
      try {
        const result = await serveDashboardEnrollment(enrollment, { logger: log });
        if (cancelled) return null;
        await completeDashboardPairing(pairing.index, { root });
        return result;
      } catch (error) {
        if (cancelled) return null;
        // The window is deliberately short. Issue a fresh one rather than
        // leaving a dead link on screen while the command is still waiting.
        log.debug?.(`Pairing link expired: ${error.message}`);
      }
    }
    return null;
  };
  return {
    accepted: serve(),
    get enrollment() { return current; },
    cancel() { cancelled = true; },
  };
}

/**
 * Join an index from a link the browser issued. This is the direction discovery
 * cannot cover: a machine on another network never hears announcements from
 * here, so the capability is carried to it instead.
 */
async function commandPairFromLink(value, verbose) {
  const capability = parsePairLink(value);
  const root = machineIndexRoot();
  await adoptMachineIndexCapability(capability, { root });
  console.log(`Joined the Pigeon index ${capability.indexId.slice(0, 10)}.`);
  // The service was built against whatever index this machine had before, so
  // it has to come back on the adopted one to be visible at all.
  await stopWatchService(root);
  const watcher = await startWatchService({ root, verbose });
  console.log(`Watcher service running as PID ${watcher.pid}.`);
  console.log('This machine now appears in that browser. Run `git pigeon init` in a repository to sync one.');
}

async function commandPair(args, verbose) {
  if (args[0] && isPairLink(args[0])) {
    const link = args.shift();
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    return await commandPairFromLink(link, verbose);
  }
  if (takeFlag(args, '--dashboard')) return await commandPairDashboard(args, verbose);
  // `--rotate` only ever meant anything to the dashboard enrollment flow.
  if (args.includes('--rotate')) return await commandPairDashboard(args, verbose);
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (!process.stdin.isTTY) {
    throw new Error('`git pigeon pair` is interactive. Run it in a terminal, or use `git pigeon pair --dashboard`.');
  }

  const root = machineIndexRoot();
  const log = logger(verbose);
  const index = await loadMachineIndex({ root });
  const identity = await loadOrCreateNativeDeviceIdentity({ root });

  console.log('Looking for a device or browser asking to pair…');

  // Both routes run at once: local discovery for anything on this network, and
  // a one-time link for anything that is not.
  const link = startPairingLink(root, verbose, log);
  let linkAccepted = false;
  link.accepted.then((result) => {
    if (!result) return;
    linkAccepted = true;
    console.log(`\nPaired ${result.browserId.slice(0, 16)}… through the one-time link.`);
  }).catch((error) => log.debug?.(error.message));

  const responder = await startDeviceApprovalResponder({ logger: log });
  let connectedAt = null;
  let announcedConnection = false;
  responder.node.mesh.on('signaling:connected', () => { connectedAt ??= Date.now(); });
  let announced = new Set();
  let explained = false;
  try {
    while (true) {
      if (linkAccepted) return;
      const pending = responder.pending();
      if (connectedAt && !announcedConnection) {
        announcedConnection = true;
        console.log('Connected to the mesh. Press Ctrl+C to stop.');
      }
      // Never open a page, and never claim nothing is out there until the mesh
      // has actually been up long enough to have heard it. Only an unpaired
      // browser announces itself, so a tab opened from here would be paired
      // already and stay just as silent as the one the user already had open.
      if (!pending.length && !explained && connectedAt && Date.now() - connectedAt >= DISCOVERY_HINT_MS) {
        explained = true;
        const dashboard = process.env.GITPIGEON_DASHBOARD_URL ?? 'https://gitpigeon.dev/';
        console.log(`\nStill nothing asking to pair. Open ${dashboard} on the device you want to add,`);
        console.log('and leave it on the pairing screen.');
        console.log('A browser that is already paired will not appear here. To pair one again, clear');
        console.log('its GitPigeon site data or use a private window.\n');
      }
      for (const request of pending) {
        if (announced.has(request.requestId)) continue;
        announced.add(request.requestId);
        console.log(`Found ${pairingLabel(request)} asking to pair.`);
      }
      announced = new Set(pending.map((request) => request.requestId));
      if (!pending.length) {
        await sleep(500);
        continue;
      }

      console.log('\nDevices asking to pair:\n');
      for (const [position, request] of pending.entries()) {
        console.log(`  ${position + 1}  ${pairingLabel(request)}`);
        try {
          console.log(`     code ${await responder.codeFor(request.requestId)}`);
        } catch (error) {
          console.log(`     code unavailable (${error.message})`);
        }
      }
      console.log('');
      const answer = await readLine('Approve which number? (Enter to refresh, q to quit) ');
      if (answer.toLowerCase() === 'q') return;
      if (!answer) continue;
      const choice = Number.parseInt(answer, 10);
      if (!Number.isSafeInteger(choice) || choice < 1 || choice > pending.length) {
        console.log(`\nThere is no device ${answer}.\n`);
        continue;
      }
      const request = pending[choice - 1];
      let code;
      try {
        code = await responder.codeFor(request.requestId);
      } catch (error) {
        console.log(`\nCould not read that device's key yet: ${error.message}\n`);
        continue;
      }
      console.log(`\n${pairingLabel(request)} should be showing this code:\n`);
      console.log(`     ${code}\n`);
      const matches = await readLine('Does that match what you see there? (y/N) ');
      if (matches.toLowerCase() !== 'y' && matches.toLowerCase() !== 'yes') {
        console.log('\nNot approved. If the codes differ, something else is asking to pair.\n');
        continue;
      }

      const repositories = (await listMachinePigeons({ root, activeOnly: false })).map((entry) => ({
        repositoryId: entry.repositoryId,
        secret: entry.secret,
        name: entry.name,
        ...(entry.signalingServer ? { signalingServer: entry.signalingServer } : {}),
      }));
      console.log('\nSending the encrypted grant…');
      const { confirmed } = await responder.approve(request.requestId, {
        index: {
          indexId: index.indexId,
          secret: index.secret,
          publisherId: index.publisherId,
        },
        nativeDevicePublicKey: identity.publicKey,
        deviceName: deviceHostName(),
        repositories,
      });
      if (!confirmed) {
        console.log(`\n${pairingLabel(request)} did not confirm the grant.`);
        console.log('It may have been closed or lost its connection. Reload it and run `git pigeon pair` again.');
        return;
      }
      await completeDashboardPairing(index, { root }).catch((error) => log.debug?.(error.message));
      console.log(`\nPaired ${pairingLabel(request)}.`);
      // Pairing alone left the machine serving nothing, so the browser showed
      // zero device peers with nothing to confirm against. The service joins
      // the encrypted index whether or not any repository is registered, so a
      // paired machine is visible as a peer immediately.
      const count = repositories.length
        ? `${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`
        : 'no repositories yet';
      try {
        const watcher = await startWatchService({ root, verbose });
        console.log(watcher.started
          ? `Started the watcher service (PID ${watcher.pid}) with ${count}.`
          : `The watcher service is already running (PID ${watcher.pid}) with ${count}.`);
        console.log('This machine now appears as a device peer in the browser.');
      } catch (error) {
        console.log(`\nCould not start the watcher service: ${error.message}`);
        console.log('Run `git pigeon start` to retry; until it runs the browser sees no device peer.');
        return;
      }
      if (!repositories.length) {
        console.log('\nRun `git pigeon init` inside a repository to start syncing one.');
      }
      return;
    }
  } finally {
    link.cancel();
    await responder.close();
  }
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

function waitForAnyPeer(node, timeoutMs) {
  if (node.getConnectedPeers().length > 0) return Promise.resolve(node.getConnectedPeers()[0]);
  return new Promise((resolve, reject) => {
    const connected = (peerId) => {
      clearTimeout(timer);
      node.off('peerConnected', connected);
      resolve(peerId);
    };
    const timer = setTimeout(() => {
      node.off('peerConnected', connected);
      reject(new Error('No GitPigeon peer connected before the timeout'));
    }, Math.max(1, timeoutMs));
    node.on('peerConnected', connected);
  });
}

async function commandSync(args, cwd, verbose) {
  const waitMs = duration(takeOption(args, '--wait'), DEFAULT_SYNC_WAIT_MS);
  const force = takeFlag(args, '--force');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  const log = logger(verbose);
  // A one-shot sync joins the same single room as the watcher rather than
  // opening a private repository room that no other peer is in.
  const index = await connectMachineIndexService(log, { root: machineIndexRoot() });
  const { synchronizer } = openNetwork(repository, config, log, undefined, undefined, index.node);
  try {
    await waitForAnyPeer(index.node, Math.max(waitMs, DEFAULT_SYNC_WAIT_MS));
    await synchronizer.start({ publish: false });
    await synchronizer.publishLocal({ force });
    if (waitMs > 0) await sleep(waitMs);
    await synchronizer.refresh();
    await synchronizer.publishLocal();
  } finally {
    await synchronizer.stop();
    await index.close();
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

export async function commandStart(args, {
  verbose = false,
  indexRoot,
  restart = false,
  startService = startWatchService,
  stopService = stopWatchService,
  waitForRepository = waitForWatchServiceRepository,
} = {}) {
  const pollMs = duration(takeOption(args, '--poll'), DEFAULT_POLL_MS);
  if (pollMs < 100) throw new Error('Poll interval must be at least 100ms');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const root = indexRoot ?? machineIndexRoot();
  const repositories = watchedRepositories(
    await listMachinePigeons({ root, activeOnly: false }),
  );
  // A paired machine is a peer on the mesh whether or not it has repositories
  // yet, and the service joins the encrypted index either way. Refusing to run
  // on an empty index left a freshly paired machine invisible with no way to
  // confirm it, short of registering a repository first.
  if (!repositories.length) {
    // `restart` has to stop the running service here too. Skipping it meant
    // `git pigeon restart` reported success on an empty index without
    // restarting anything, so a service holding stale state kept running.
    if (restart) await stopService(root);
    const empty = await startService({ root, pollMs, verbose });
    console.log(empty.started
      ? `GitPigeon started the machine-wide background service (PID ${empty.pid}) with no repositories yet.`
      : `The GitPigeon watcher service is already running (PID ${empty.pid}) with no repositories yet.`);
    console.log('This machine appears as a device peer. Run `git pigeon init` in a repository to sync one.');
    return;
  }

  if (restart) await stopService(root);
  const result = await startService({ root, pollMs, verbose });
  await Promise.all(repositories.map((repository) => (
    waitForRepository(root, repository.root)
  )));
  const count = repositories.length;
  console.log(restart
    ? `GitPigeon restarted the machine-wide background service and is watching ${count} ${count === 1 ? 'repository' : 'repositories'}.`
    : result.started
    ? `GitPigeon started the machine-wide background service and is watching ${count} ${count === 1 ? 'repository' : 'repositories'}.`
    : `The GitPigeon watcher service is already running and watching ${count} ${count === 1 ? 'repository' : 'repositories'}.`);
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

export async function materializeGrantedRepositories(values, {
  root = machineIndexRoot(),
  base = path.resolve(process.env.GITPIGEON_CLONE_DIR ?? path.join(homedir(), "GitPigeon")),
} = {}) {
  if (!Array.isArray(values)) return [];
  if (values.length > 1_000) throw new Error("The approved GitPigeon index contains too many repositories");
  const capabilities = [];
  const seen = new Set();
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const capability = validateNativeClonePayload(value);
    if (seen.has(capability.repositoryId)) continue;
    seen.add(capability.repositoryId);
    capabilities.push(capability);
  }
  const existing = await listMachinePigeons({ root, activeOnly: false });
  const registered = new Set(existing.map((entry) => entry.repositoryId));
  await mkdir(base, { recursive: true });
  const added = [];
  for (const capability of capabilities) {
    if (registered.has(capability.repositoryId)) continue;
    const target = await availableCloneTarget(
      base,
      safeRepositoryDirectoryName(capability.name, capability.repositoryId),
    );
    await ensureCloneDirectory(target);
    const repository = await GitRepository.init(target);
    const config = createIdentity(capability);
    await saveConfig(repository.gitDir, config);
    await new WorkspaceFiles(repository).init();
    await registerMachinePigeon(repository, config, { root, pid: null });
    registered.add(capability.repositoryId);
    added.push({ repository, config, capability });
  }
  return added;
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
  if (command === 'start' || command === 'restart') {
    return await commandStart(args, { verbose, restart: command === 'restart' });
  }
  if (command === 'stop') return await commandStop(args);
  if (command === 'clone') return await commandClone(args, cwd, verbose);
  if (command === 'protocol') return await commandProtocol(args, verbose);
  if (command === 'terminal-device') return commandTerminalDevice(args);
  if (command === 'status') return await commandStatus(args, cwd);
  if (command === 'doctor') return await commandDoctor(args, cwd);
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
