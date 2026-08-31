import { watch as watchFilesystem } from "node:fs";
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { deviceHostName } from './device-name.js';
import { DEFAULT_POLL_MS, DEFAULT_SYNC_WAIT_MS } from './constants.js';
import { RepositoryCache } from './cache.js';
import { CONTROL_CHANNEL, broadcastChannel, onChannelMessage, sendChannelDirect } from './channel.js';
import { createIdentity, loadConfig, saveConfig } from './config.js';
import {
  createWatchServiceControl,
  listGitPigeonWatcherPids,
  spawnDetachedServiceRestart,
  startWatchService,
  stopWatchService,
  waitForWatchServiceRepository,
  watchServiceHasRepository,
  watchServiceStatus,
} from './daemon.js';
import { GitRepository } from './git.js';
import { createInvite, parseInvite } from './invite.js';
import { createShareKey, createShareUrl, parseShareUrl, validateMirrorUrl } from './share.js';
import { connectShareGuest, fetchProposal, listProposals, submitProposal } from './share-service.js';
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
  tombstoneMachinePigeon,
  unregisterMachinePigeon,
} from './machine-index.js';
import {
  loadOrCreateNativeDeviceIdentity,
  openDeviceGrant,
  parseNativeCloneUrl,
  validateNativeClonePayload,
} from './device-grants.js';
import { startDeviceApprovalResponder } from './device-approval-mesh.js';
import { loadPairingKeyPair, localPairingCode } from './pairing-identity.js';
import { requestLanDeviceApproval, startLanApprovalService } from './lan-enrollment.js';
import { installNativeIntegration, refreshNativeCommandShim } from './native-install.js';
import { ControlServer } from './control-server.js';
import { RepositorySynchronizer } from './protocol.js';
import { TerminalServer } from './terminal-server.js';
import { createTerminalHistory, terminalHistoryKey } from './terminal-history.js';
import { RealtimeWorkspaceServer } from './realtime-server.js';
import { WorkspaceFiles, workspaceDigest } from './workspace.js';
import { liveWorkspaceDigest } from './live-workspace.js';
import { clearInstalledUpdate, isNewerVersion, readInstalledUpdate, startAutomaticUpdates } from './auto-update.js';
import { pullPeerUpdateOnce, startPeerUpdates } from './peer-update.js';
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
  git pigeon unwatch [REPO | --id ID]   Stop syncing one (--id tombstones a
                                        repository no machine still watches)
  git pigeon list                       Show what this machine syncs
  git pigeon invite                     Print an invite for one repository
  git pigeon share                      Print a public read-only share link
                                        (holders mirror it; approved devices
                                        edit; forks can propose changes)
       --mirror https://<endpoint>/<bucket>[/<prefix>]
                                        Attach an S3-compatible cloud mirror
                                        (credentials from AWS_* env vars)
       --mirror-nostr [wss://a,wss://b] Attach a Nostr mirror on free public
                                        relays (zero setup; keypair generated
                                        and kept by the watcher)
       --mirror-ipfs <kubo-rpc-url>     Attach an IPFS mirror through a
                                        node's HTTP RPC API (auth from
                                        IPFS_API_AUTHORIZATION if needed)
       --mirror-gateway <url>           Gateway readers use (default ipfs.io)
       --mirror-public <url>            Public base readers fetch from
       --mirror off                     Detach the cloud mirror
  git pigeon propose [--title T]        Offer this branch's commits to the
                                        shared repository's owner
  git pigeon proposals                  List proposals awaiting review
  git pigeon accept ID                  Fetch a proposal as review refs
  git pigeon sync [--wait D] [--force]  Sync once and exit

Private files
  git pigeon track FILE...              Sync a file, never committing it
  git pigeon untrack FILE...            Stop syncing it privately
  git pigeon tracked                    List privately synced files

Background service
  git pigeon start [--poll D]           Start the watcher
  git pigeon restart [--poll D]         Restart it
  git pigeon stop                       Stop it
  git pigeon update [--local]           Update from the latest release, or
                                        with --local, from a paired watcher
                                        on the LAN mesh

Checking on things
  git pigeon status [--json]            Show this repository's sync state
  git pigeon doctor                     Check this machine's setup
  git pigeon version                    Print the installed version
                                        (also --version, -V)

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
/**
 * Committed-only stand-ins for the workspace layers. A SHARED repository
 * runs the exact same synchronizer as a private one — same manifests, same
 * chunks, same channels — on the share room, gated by these: no private
 * files, no live workspace, no trash ever enter a shared publication, and
 * incoming ones have nothing to apply to.
 */
class CommittedOnlyWorkspace {
  async init() {}
  async list() { return []; }
  normalize(value) { return String(value); }
  // The digest must be the real digest of the empty file set: receivers —
  // the browser's validateManifest and this synchronizer's own manifest
  // acceptance — recompute it from the (empty) list and reject a mismatch.
  async snapshot() { return { files: [], digest: workspaceDigest([]) }; }
  async apply() { return { written: [], removed: [] }; }
}

class CommittedOnlyLiveWorkspace {
  async init() {}
  normalize(value) { return String(value); }
  async snapshot() { return { files: [], digest: liveWorkspaceDigest([]) }; }
  async trashSnapshot() { return []; }
  async mirrorTrash() { return []; }
  async prepare() { return { written: [], removed: [] }; }
  async apply() { return { written: [], removed: [] }; }
}

function openNetwork(repository, config, log, serviceInstanceId, machineIndexId, node, ownership = { owns: () => false }, deviceClaim = null, { committedOnly = false, cacheDir = null } = {}) {
  if (!node?.storage) throw new Error('The GitPigeon index mesh is not connected');
  const synchronizer = new RepositorySynchronizer({
    ownsLivePath: (file) => ownership.owns(file),
    deviceClaim,
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
    ...(cacheDir ? { cache: new RepositoryCache(cacheDir) } : {}),
    ...(committedOnly ? {
      workspace: new CommittedOnlyWorkspace(),
      liveWorkspace: new CommittedOnlyLiveWorkspace(),
    } : {}),
  });
  return { synchronizer };
}

async function startIndexedWatchService(options = {}) {
  return await startWatchService({ root: machineIndexRoot(), ...options });
}

function repositorySessionSignature(config) {
  // Registration entries and loaded configs are both fed through here, and
  // reconcile compares the two — so ONLY fields present in both belong in
  // the signature. Including config.share (absent from registrations) made
  // every comparison a mismatch and reconcile closed and reopened the
  // session forever: the browser sat on CONNECTING while the watcher
  // churned. Share changes reload through the explicit service restart in
  // \`git pigeon share\` instead.
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

async function openRepositorySession({ repository, config }, pollMs, log, serviceInstanceId, machineIndexId, node, deviceClaim = null, terminalHistory = null) {
  // Late-bound: the realtime server is created below but the synchronizer
  // needs to consult it for path ownership.
  const ownership = { owns: () => false };
  const { synchronizer } = openNetwork(repository, config, log, serviceInstanceId, machineIndexId, node, ownership, deviceClaim);
  const terminalServer = new TerminalServer({
    node,
    repository,
    secret: config.secret,
    repositoryId: config.repositoryId,
    serviceInstanceId,
    deviceName: deviceHostName(),
    logger: log,
    history: terminalHistory,
  });
  terminalServer.start();
  const realtimeServer = new RealtimeWorkspaceServer({
    node,
    repository,
    secret: config.secret,
    repositoryId: config.repositoryId,
    deviceId: config.deviceId,
    logger: log,
    onFileWritten: () => schedulePublish(),
  });
  // Build offers travel every room these watchers share. The index room is
  // the flakiest link on some networks — watchers whose index connection
  // stalls still hold rock-solid repository rooms, and an update channel
  // that only ever rode the weakest mesh went silent exactly when needed.
  // Commit over the REPOSITORY channel. The index room can be mid-
  // renegotiation while this session's channel is demonstrably alive (live
  // edits flowing, terminal open); an already-connected path must be enough
  // to commit. Same intent-token replay contract as the index-room op.
  const sessionCommitOutcomes = new Map();
  const unsubscribeSessionCommit = onChannelMessage(node, config.repositoryId, CONTROL_CHANNEL, (frame, { peerId, kind }) => {
    // Direct AND broadcast are both accepted: a half-dead channel can eat
    // direct frames while room gossip still routes — the same reason live
    // edits keep flowing when clicks appear to hang.
    if (frame.kind === 'ping' && frame.requestId) {
      // The browser's round-trip probe, gossip-shaped like everything
      // else. The pong travels every path; its arrival IS the proof — and
      // it carries the current head pointer, because storage replication
      // can stand off (vector ties across restarts) while the channel is
      // demonstrably alive. Proof and truth in one small frame.
      (async () => {
        let head = null;
        try {
          const record = await node.storage?.get('public', `gitpigeon/v1/${config.repositoryId}/head/${config.deviceId}`);
          head = record?.value ?? null;
        } catch { /* the pong is proof enough without it */ }
        const pong = { kind: 'pong', requestId: String(frame.requestId), ...(head ? { head } : {}) };
        await Promise.allSettled([
          sendChannelDirect(node, peerId, config.repositoryId, CONTROL_CHANNEL, pong),
          broadcastChannel(node, config.repositoryId, CONTROL_CHANNEL, pong),
        ]);
      })().catch(() => {});
      return;
    }
    if (frame.kind !== 'commit-repository') return;
    void kind;
    (async () => {
      const requestId = String(frame.requestId ?? '');
      if (!requestId) return;
      // The reply must survive the same half-dead channel the request did:
      // send it directly AND broadcast it. requestId scopes it; the intent
      // token makes duplicate delivery harmless.
      const reply = async (payload) => {
        const resultFrame = { kind: 'result', requestId, ...payload };
        await Promise.allSettled([
          sendChannelDirect(node, peerId, config.repositoryId, CONTROL_CHANNEL, resultFrame),
          broadcastChannel(node, config.repositoryId, CONTROL_CHANNEL, resultFrame),
        ]);
      };
      try {
        const token = String(frame.token ?? '');
        if (token && sessionCommitOutcomes.has(token)) {
          await reply({ ok: true, ...sessionCommitOutcomes.get(token) });
          return;
        }
        const message = String(frame.message ?? '').trim().slice(0, 500);
        if (!message) throw new Error('A commit message is required');
        await repository.git(['add', '-A']);
        const status = (await repository.git(['status', '--porcelain'])).stdout.trim();
        if (!status) throw new Error('Nothing to commit — the working tree is clean');
        const identity = [];
        const hasIdentity = await repository.git(['config', 'user.email']).then(
          (result) => Boolean(result.stdout.trim()),
          () => false,
        );
        if (!hasIdentity) {
          const host = deviceHostName();
          identity.push('-c', `user.name=${host}`, '-c', `user.email=gitpigeon@${host}`);
        }
        await repository.git([...identity, 'commit', '-m', message]);
        const commit = (await repository.git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
        log.info(`Committed ${commit} on ${config.repositoryId.slice(0, 8)} from a paired browser (repository channel)`);
        if (token) {
          sessionCommitOutcomes.set(token, { commit });
          while (sessionCommitOutcomes.size > 32) sessionCommitOutcomes.delete(sessionCommitOutcomes.keys().next().value);
        }
        schedulePublish();
        await reply({ ok: true, commit });
      } catch (error) {
        await reply({ ok: false, message: error.message }).catch(() => {});
      }
    })().catch((error) => log.debug?.(`Session commit: ${error.message}`));
  });
  // The counterpart of the goodbye: announce THIS session the moment it
  // opens — and AGAIN whenever a peer connects, because the open-time hello
  // fires into a room nobody has rejoined yet and an announcement nobody
  // hears never happened. Throttled so a reconnect storm is one hello.
  let lastHelloAt = 0;
  const sayHello = () => {
    if (Date.now() - lastHelloAt < 5_000) return;
    lastHelloAt = Date.now();
    broadcastChannel(node, config.repositoryId, CONTROL_CHANNEL, { kind: 'hello' }).catch(() => {});
  };
  sayHello();
  const onHelloPeer = () => sayHello();
  node.on('peerConnected', onHelloPeer);
  const sessionPeerUpdates = startPeerUpdates({
    node,
    root: machineIndexRoot(),
    currentVersion: GITPIGEON_VERSION,
    standalone: IS_STANDALONE,
    logger: log,
    onUpdate: async () => {
      // Same hazard as the index-adopt restart: never orchestrate our own
      // replacement from inside the process being replaced.
      spawnDetachedServiceRestart(machineIndexRoot());
    },
  });
  ownership.owns = (file) => realtimeServer.ownsPath(file);
  // A shared repository serves its public room with the SAME machinery as
  // the private one: the standard synchronizer on a second node whose
  // secret is the share key, gated committed-only — no private files, no
  // live workspace, no trash. One code path; shared is a gate, not a fork.
  let shareSync = null;
  let shareNode = null;
  let shareMirror = null;
  if (config.share) {
    (async () => {
      // The share cache is encrypted under the share key, so a rotated key
      // makes every cached record unreadable: a restart then re-seeds
      // nothing, publishes a presence with no snapshot, and every visitor
      // waits forever on a live watcher with nothing to serve. Keying the
      // cache directory by the share key gives each rotation a fresh cache;
      // dead generations (including the legacy unkeyed dir) are swept.
      const shareCacheRoot = path.join(repository.gitDir, 'gitpigeon');
      const generation = createHash('sha256')
        .update(`gitpigeon-share-cache/1\0${config.share.key}`)
        .digest('hex')
        .slice(0, 16);
      const shareCacheName = `share-cache-${generation}`;
      for (const entry of await readdir(shareCacheRoot, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && entry.name.startsWith('share-cache') && entry.name !== shareCacheName) {
          await rm(path.join(shareCacheRoot, entry.name), { recursive: true, force: true }).catch(() => {});
        }
      }
      shareNode = await connectShareGuest({
        repositoryId: config.repositoryId,
        share: { key: config.share.key },
        signalingServer: config.signalingServer,
        userId: `share-${config.share.role}-${config.deviceId.slice(0, 12)}`,
      });
      // The always-on mirror follows the share node's storage: every record
      // this owner publishes to the share room is room-encrypted by the
      // node's own crypto and uploaded to the configured bucket. Started
      // BEFORE the synchronizer so the initial publish is captured too.
      if (config.share.mirror) {
        try {
          const { IpfsMirrorClient, S3MirrorClient, startShareMirror } = await import('./mirror.js');
          let client;
          if (config.share.mirror.type === 'nostr') {
            const { NostrMirrorClient } = await import('./nostr-mirror.js');
            client = new NostrMirrorClient(config.share.mirror);
          } else {
            client = config.share.mirror.type === 'ipfs'
              ? new IpfsMirrorClient(config.share.mirror)
              : new S3MirrorClient(config.share.mirror);
          }
          shareMirror = startShareMirror({
            node: shareNode,
            repositoryId: config.repositoryId,
            client,
            logger: log,
          });
          log.info(`Share mirror live for ${config.repositoryId.slice(0, 8)} at ${config.share.mirror.publicBaseUrl}`);
        } catch (error) {
          log.error(new Error(`Share mirror for ${config.repositoryId.slice(0, 8)}: ${error.message}`));
        }
      }
      const shareNet = openNetwork(
        repository,
        { ...config, secret: config.share.key },
        log,
        serviceInstanceId,
        machineIndexId,
        shareNode,
        ownership,
        deviceClaim,
        { committedOnly: true, cacheDir: path.join(shareCacheRoot, shareCacheName) },
      );
      shareSync = shareNet.synchronizer;
      await shareSync.start();
      shareMirror?.seedCurrent?.().catch((error) => log.debug?.(`Mirror seed: ${error.message}`));
      log.info(`Share room live for ${config.repositoryId.slice(0, 8)} (${config.share.role})`);
    })().catch((error) => log.error(new Error(`Share room for ${config.repositoryId.slice(0, 8)}: ${error.message}`)));
  }
  let changeTimer;
  let filesystemWatcher;
  let watcherRetryTimer;
  let watcherRetryMs = 5_000;
  let watcherFallbackTimer;
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
        // Committed changes flow to the share room through the same call.
        await shareSync?.publishLocal()?.catch?.(() => {});
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

  const sweepOrphanedTemps = async () => {
    // Failed writes used to strand `<file>.<pid>-<hex>.tmp` beside real
    // files — dozens of them on a machine whose disk was misbehaving.
    const { readdir, rm: remove, stat: statFile } = await import('node:fs/promises');
    const sweep = async (directory, depth) => {
      if (depth > 6) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { await sweep(full, depth + 1); continue; }
        if (!/\.\d+-[0-9a-f]{10}\.tmp$/.test(entry.name)) continue;
        try {
          const details = await statFile(full);
          if (Date.now() - details.mtimeMs > 10 * 60_000) await remove(full, { force: true });
        } catch { /* already gone */ }
      }
    };
    await sweep(repository.root, 0);
    await synchronizer.liveWorkspace?.pruneTrash?.().catch?.(() => {});
  };

  // A repository must NEVER silently lose change detection. `fs.watch` can
  // fail at creation (EMFILE when the process is out of descriptors) or die
  // later through its 'error' event; either way the repo would look watched
  // while nothing publishes. So a failed watcher is retried with backoff,
  // and until one is live a slow digest poll keeps sync moving regardless.
  const startFallbackPolling = () => {
    if (watcherFallbackTimer || stopped) return;
    watcherFallbackTimer = setInterval(() => {
      publishChanges().catch((error) => log.error(error));
    }, 5_000);
  };

  const stopFallbackPolling = () => {
    if (!watcherFallbackTimer) return;
    clearInterval(watcherFallbackTimer);
    watcherFallbackTimer = undefined;
  };

  const scheduleWatcherRetry = () => {
    if (watcherRetryTimer || stopped) return;
    startFallbackPolling();
    watcherRetryTimer = setTimeout(() => {
      watcherRetryTimer = undefined;
      startFilesystemWatcher();
    }, watcherRetryMs);
    watcherRetryMs = Math.min(watcherRetryMs * 2, 60_000);
  };

  const startFilesystemWatcher = () => {
    if (filesystemWatcher || stopped) return;
    try {
      filesystemWatcher = watchFilesystem(repository.root, { recursive: true }, (_event, filename) => {
        const changed = String(filename ?? "").replaceAll("\\", "/");
        if (changed === ".git/gitpigeon" || changed.startsWith(".git/gitpigeon/")) return;
        realtimeServer.filesystemChanged(changed).catch((error) => log.error(error));
        schedulePublish();
      });
      filesystemWatcher.on("error", (error) => {
        log.error(new Error(`Filesystem watcher for ${repository.root} died, retrying: ${error.message}`));
        filesystemWatcher?.close();
        filesystemWatcher = undefined;
        scheduleWatcherRetry();
      });
      watcherRetryMs = 5_000;
      stopFallbackPolling();
    } catch (error) {
      log.error(new Error(`Filesystem watcher for ${repository.root} failed to start, retrying: ${error.message}`));
      scheduleWatcherRetry();
    }
  };

  const activate = async () => {
    if (started || starting || stopped) return;
    starting = true;
    try {
      await realtimeServer.start();
      await synchronizer.start();
      previousDigest = await synchronizer.localDigest();
      started = true;
      startFilesystemWatcher();
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
  sweepOrphanedTemps().catch(() => {});
  const sweepTimer = setInterval(() => { sweepOrphanedTemps().catch(() => {}); }, 15 * 60_000);
  sweepTimer.unref?.();
  activate().catch((error) => log.error(error));
  log.info(`Watching ${repository.root} as ${config.deviceId.slice(0, 8)}`);

  return {
    presenceDiagnostics: () => synchronizer.presenceDiagnostics?.() ?? null,
    writeError: () => realtimeServer.lastWriteError ?? null,
    terminalRelay: (opened, io) => terminalServer.receiveRelayed(opened, io),
    async close() {
      if (stopped) return;
      stopped = true;
      if (changeTimer) clearTimeout(changeTimer);
      clearInterval(sweepTimer);
      filesystemWatcher?.close();
      if (watcherRetryTimer) clearTimeout(watcherRetryTimer);
      stopFallbackPolling();
      if (peerRefreshTimer) clearTimeout(peerRefreshTimer);
      node.off('peerConnected', onPeerConnected);
      // A graceful shutdown says goodbye BEFORE tearing down — as a
      // DURABLE RECORD first, because a frame is one shot into channels
      // that are unreliable at exactly this moment, while a storage record
      // rides retried, anti-entropy replication and persists in every
      // replica until heard. A fresh presence at the next start supersedes
      // it by timestamp; no clearing step exists to forget.
      await node.storage?.put('public', `gitpigeon/v1/${config.repositoryId}/farewell/${config.deviceId}`, {
        protocol: 'gitpigeon/1',
        repositoryId: config.repositoryId,
        deviceId: config.deviceId,
        at: new Date().toISOString(),
      }).catch(() => {});
      const farewell = { kind: 'goodbye' };
      await Promise.race([
        Promise.allSettled([
          broadcastChannel(node, config.repositoryId, CONTROL_CHANNEL, farewell),
          ...node.getConnectedPeers().map((peerId) =>
            sendChannelDirect(node, peerId, config.repositoryId, CONTROL_CHANNEL, farewell)),
        ]),
        sleep(1_500),
      ]);
      node.off('peerConnected', onHelloPeer);
      unsubscribeSessionCommit?.();
      terminalServer.stop();
      realtimeServer.stop();
      await sessionPeerUpdates.stop().catch(() => {});
      shareMirror?.stop();
      await shareSync?.stop()?.catch?.(() => {});
      await shareNode?.destroy()?.catch?.(() => {});
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
async function startPairingService(root, log, { indexDiagnostics = null, onTerminalRelay = null, onShareClone = null } = {}) {
  const keyPair = await loadPairingKeyPair(root);
  const adopt = async (capability) => {
    try {
      if (!capability?.index?.indexId) return;
      const current = await loadMachineIndex({ root });
      // Same index AND same secret is the only nothing-to-do case. Comparing
      // the id alone made a machine left behind by a secret rotation drop the
      // very capability that would have re-admitted it: the id survives
      // rotation, so it said "already there" while staying locked out.
      if (current.indexId === capability.index.indexId
        && current.secret === capability.index.secret) return;
      await adoptMachineIndexCapability(capability.index, { root });
      log.info?.(`Joined GitPigeon index ${String(capability.index.indexId).slice(0, 10)}; restarting`);
      // The restart is NOT this process's job. Stopping ourselves and then
      // spawning our successor from inside the dying process raced our own
      // teardown — a storage error in that window aborted the chain after the
      // stop and before the start, leaving the machine with no watcher at
      // all. The detached helper survives whatever this process does next.
      spawnDetachedServiceRestart(root);
    } catch (error) {
      log.error?.(new Error(`Could not adopt the offered index: ${error.message}`));
    }
  };
  const responder = await startDeviceApprovalResponder({
    logger: log,
    keyPair,
    // Announce this machine for as long as the watcher runs, so a browser that
    // has already paired with one machine still sees the next one. Same node as
    // the responder: one peer per machine on the approval mesh.
    offerDeviceName: deviceHostName(),
    // So a browser that already took this machine in stops asking to approve
    // it again every time it announces.
    ...await (async () => {
      const current = await loadMachineIndex({ root }).catch(() => null);
      return { offerIndexId: current?.indexId ?? null, offerIndexSecret: current?.secret ?? null };
    })(),
    offerDiagnostics: () => ({ build: GITPIGEON_VERSION, ...(indexDiagnostics?.() ?? {}) }),
    onTerminalRelay,
    onShareClone,
    onGrant: adopt,
    // A browser this machine offered itself to can ask it to join the index it
    // settled on, which is how several machines end up together.
    onAdopt: adopt,
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
  // The machine's persistent unsea keypair is the device signature: presence
  // records bind this service instance to the device key, verifiably.
  const deviceClaim = await (async () => {
    try {
      const keyPair = await loadPairingKeyPair(root);
      const { signMessage } = await import('unsea');
      return {
        devicePublicKey: keyPair.pub,
        deviceSignature: await signMessage(`gitpigeon-device-claim/1\0${serviceInstanceId}`, keyPair.priv),
      };
    } catch {
      return null;
    }
  })();
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
  let peerUpdates;
  let automaticUpdates;
  let installedUpdate;
  let controlServer;
  let pairingService;
  let terminalHistory = null;
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
    record.opening = openRepositorySession(prepared, pollMs, log, serviceInstanceId, machineIndexId, machineIndex.node, deviceClaim, terminalHistory)
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
    // One fleet-wide terminal history for every session this service opens,
    // carried in PeerPigeon storage on the index node — mesh only, no file.
    terminalHistory = createTerminalHistory({
      node: machineIndex.node,
      key: terminalHistoryKey(machineIndex.index.indexId),
      deviceId: deviceHostName(),
      logger: log,
    });
    await reconcile();
    // Keep offering to pair for as long as this machine runs, so a browser
    // opened at any time is answered.
    pairingService = await startPairingService(root, log, {
      // Clone-from-share over the LAN mesh: a browser holding a share link
      // asks this machine to mirror the repository. No installer, no deep
      // link, no pairing — the repository simply becomes a first-class
      // citizen of this machine's mesh: cloned, registered, synced, served.
      onShareClone: async (opened, { reply }) => {
        try {
          const requestId = String(opened?.requestId ?? '');
          const parsed = parseShareUrl(String(opened?.shareUrl ?? ''));
          const entries = await listMachinePigeons({ root, activeOnly: false });
          const existing = entries.find((entry) => entry.repositoryId === parsed.repositoryId);
          if (existing) {
            await reply({ requestId, ok: true, already: true, target: existing.repository, deviceName: deviceHostName() });
            return;
          }
          const base = path.resolve(process.env.GITPIGEON_CLONE_DIR ?? path.join(homedir(), 'GitPigeon'));
          await mkdir(base, { recursive: true });
          const target = await availableCloneTarget(
            base,
            safeRepositoryDirectoryName(`shared-${parsed.repositoryId.slice(0, 8)}`, parsed.repositoryId),
          );
          const repository = await GitRepository.init(target);
          let config = createIdentity({ repositoryId: parsed.repositoryId, signalingServer: parsed.signalingServer });
          config = await saveConfig(repository.gitDir, {
            ...config,
            share: { key: parsed.shareKey, ownerPublicKey: parsed.ownerPublicKey, role: 'mirror' },
          });
          await new WorkspaceFiles(repository).init();
          await registerMachinePigeon(repository, config, { root, pid: null, fresh: true });
          await reconcile();
          log.info(`Cloned shared ${parsed.repositoryId.slice(0, 8)} to ${target}; it is now part of this mesh`);
          await reply({ requestId, ok: true, target, deviceName: deviceHostName() });
        } catch (error) {
          log.debug?.(`Share clone failed: ${error.message}`);
          await reply({ requestId: String(opened?.requestId ?? ''), ok: false, message: String(error.message).slice(0, 200) }).catch(() => {});
        }
      },
      // Terminal frames sealed over the pairing mesh route to the session
      // that owns their repository.
      onTerminalRelay: (opened, io) => {
        const frame = opened?.frame;
        if (!frame?.repositoryId) return;
        for (const record of sessions.values()) {
          if (record.prepared?.config?.repositoryId === frame.repositoryId) {
            record.session?.terminalRelay?.(opened, io);
            return;
          }
        }
      },
      indexDiagnostics: () => ({
        ...machineIndex.diagnostics(),
        // Per-repository session health, so a machine whose repo session died
        // says so in every peer's log instead of silently vanishing from
        // terminal rosters.
        sessions: [...sessions.entries()].map(([repository, record]) => ({
          repo: String(record.prepared?.config?.repositoryId ?? repository).slice(0, 8),
          open: Boolean(record.session),
          ...(record.session?.presenceDiagnostics?.() ? { presence: record.session.presenceDiagnostics() } : {}),
          ...(record.session?.writeError?.() ? { writeError: record.session.writeError() } : {}),
          ...(repositoryErrors.get(repository)
            ? { error: String(repositoryErrors.get(repository)).slice(0, 120) }
            : {}),
        })),
      }),
    });
    // Paired peers can remove a repository or rotate the index secret.
    controlServer = new ControlServer({
      node: machineIndex.node,
      indexId: machineIndex.index.indexId,
      root,
      logger: log,
      onChanged: () => reconcile(),
      // A share toggle changes the repo config without changing the session
      // signature, so reconcile alone would keep the old session (and its
      // share room state) running. Close it; reconcile reopens it fresh.
      onShareToggled: async (repositoryPath) => {
        const record = sessions.get(repositoryPath);
        if (record) {
          sessions.delete(repositoryPath);
          await stopSession(record);
        }
      },
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
    if (IS_STANDALONE) {
      // Machines installed before the shim chased current.json keep a stale
      // `git pigeon` on PATH forever; every service start heals it.
      try {
        await refreshNativeCommandShim();
      } catch (error) {
        log.warn(`Could not refresh the git-pigeon command shim: ${error.message}`);
      }
    }
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
    // Watchers also update each other directly over the encrypted index mesh:
    // two machines on one LAN converge on the newest build either of them
    // has, including a build that never went through a release.
    peerUpdates = startPeerUpdates({
      node: machineIndex.node,
      root,
      currentVersion: GITPIGEON_VERSION,
      standalone: IS_STANDALONE,
      logger: log,
      onUpdate: async (update) => {
        installedUpdate = update;
        stop();
      },
    });
    await stopped;
  } finally {
    // `git pigeon stop` waits on the service state file. Remove it FIRST so
    // the command returns instantly; goodbyes and teardown continue behind
    // it — nothing after this line needs the state file.
    if (control) await control.close().catch(() => {});
    automaticUpdates?.stop();
    await peerUpdates?.stop()?.catch?.(() => {});
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
    if (terminalHistory) await terminalHistory.close();
    if (machineIndex) await machineIndex.close();
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
    const repository = await GitRepository.discover(cwd);
    // Discovery walks upward. Running init in a plain folder inside some
    // other repository used to register that whole ancestor — a Pigeon named
    // after a directory the person never mentioned. `git pigeon init` means
    // THIS directory: when the folder is not itself a repository root, it
    // becomes its own repository here and now, ancestors notwithstanding.
    if (path.resolve(repository.root) !== path.resolve(cwd)) {
      const created = await GitRepository.init(cwd);
      console.log(`Initialized a new Git repository at ${cwd} (inside ${repository.root}, which is untouched).`);
      return created;
    }
    return repository;
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
  let invite = null;
  let sharedJoin = null;
  if (inviteValue) {
    try {
      sharedJoin = parseShareUrl(inviteValue);
    } catch {
      invite = parseInvite(inviteValue);
    }
  }
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
    if (sharedJoin) {
      // Joining a SHARE URL: same repository identity, own local secret. The
      // share key admits this machine as a mirror — it carries the
      // repository and keeps it available, but only rostered keys publish.
      config = createIdentity({ repositoryId: sharedJoin.repositoryId, signalingServer: sharedJoin.signalingServer });
      config = await saveConfig(repository.gitDir, {
        ...config,
        share: { key: sharedJoin.shareKey, ownerPublicKey: sharedJoin.ownerPublicKey, role: 'mirror' },
      });
    } else {
      config = createIdentity(invite ?? { repositoryId, secret, signalingServer });
      await saveConfig(repository.gitDir, config);
    }
  }
  const workspace = new WorkspaceFiles(repository);
  await workspace.init();
  const indexRoot = machineIndexRoot();
  const wasRegistered = (await listMachinePigeons({ root: indexRoot, activeOnly: false }))
    .some((entry) => entry.repository === repository.root);
  await registerMachinePigeon(repository, config, {
    root: indexRoot,
    pid: null,
    fresh: true,
  });
  const watcher = await startIndexedWatchService({ verbose });
  await waitForWatchServiceRepository(indexRoot, repository.root);

  if (created && sharedJoin) {
    console.log(`GitPigeon is mirroring the shared repository at ${repository.root}.`);
    console.log('The clone appears as soon as the mesh delivers the first verified head.');
  } else if (created && !invite) {
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
 * State this machine's pairing code and return.
 *
 * This used to start a mesh node and wait for a browser to ask, because the
 * code mixed both peers' keys and so did not exist until then — which held the
 * terminal with nothing on screen. The watcher owns its own code now, so this
 * reads it off disk and prints it immediately.
 */
async function reportPairingCode(root = machineIndexRoot()) {
  const code = await localPairingCode(root);
  console.log(`\n  This machine's pairing code: ${code}`);
  console.log('  Approve this machine in your browser only if it shows the same code.');
  return code;
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
    if (!noEnroll) await reportPairingCode();
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
    // The service offers pairing for as long as it runs, and adopts an index if
    // an approved browser elsewhere hands it one, so this command has nothing
    // to wait for. It used to hold the terminal while it announced itself.
    await startWatchService({ root, verbose });
    console.log('\nThis machine is ready to pair and will keep offering.');
    await reportPairingCode(root);
    const dashboard = process.env.GITPIGEON_DASHBOARD_URL ?? 'https://gitpigeon.dev/';
    console.log(`\nApprove it at ${dashboard} once the code above matches.`);
    openDashboard(dashboard);
    return;
  }
  await commandEnroll([], verbose);
  await reportPairingCode();
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

  const responder = await startDeviceApprovalResponder({
    logger: log,
    keyPair: await loadPairingKeyPair(root),
  });
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

async function commandShare(args, cwd, verbose) {
  const mirrorOption = takeOption(args, '--mirror');
  const mirrorPublic = takeOption(args, '--mirror-public');
  const mirrorIpfs = takeOption(args, '--mirror-ipfs');
  const mirrorGateway = takeOption(args, '--mirror-gateway');
  // --mirror-nostr works bare (default relays) or with a relay list.
  let mirrorNostr;
  let mirrorNostrFlag = false;
  const nostrIndex = args.indexOf('--mirror-nostr');
  if (nostrIndex !== -1) {
    mirrorNostrFlag = true;
    const next = args[nostrIndex + 1];
    if (next !== undefined && !next.startsWith('--')) {
      mirrorNostr = next;
      args.splice(nostrIndex, 2);
    } else {
      args.splice(nostrIndex, 1);
    }
  } else {
    mirrorNostr = takeOption(args, '--mirror-nostr');
    mirrorNostrFlag = mirrorNostr !== undefined;
  }
  const rotate = takeFlag(args, '--rotate');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  if (config.share?.role === 'mirror') {
    throw new Error("This is a mirror of someone else's shared repository.");
  }
  // --rotate is the deliberate new-link action: discard the permanent share
  // identity (active or dormant) and mint a fresh one — new key, new mirror
  // keypair. Every previously distributed link stops working, on purpose.
  if (rotate) {
    delete config.share;
    delete config.shareDormant;
    console.log('Rotating the share identity: every previously shared link is now dead.\n');
  }
  const root = machineIndexRoot();
  const keyPair = await loadPairingKeyPair(root);
  let share = config.share ?? null;
  // One repository, one link, always: a dormant share (stowed by a lock)
  // resumes with its original key, owner, and mirror identity.
  const resumed = !share && Boolean(config.shareDormant);
  if (resumed) share = config.shareDormant;
  const created = !share;
  if (!share) {
    share = { key: createShareKey(), ownerPublicKey: keyPair.pub, role: 'owner' };
  }
  let mirrorChanged = false;
  if (mirrorOption === 'off') {
    mirrorChanged = Boolean(share.mirror);
    delete share.mirror;
  } else if (mirrorNostrFlag) {
    // --mirror-nostr [wss://a,wss://b] — free public relays by default,
    // identity is a keypair generated here and kept across re-runs so the
    // published base (and every copied link) stays stable.
    const { DEFAULT_NOSTR_RELAYS, generateNostrMirrorKey, nostrPublicBase, nostrPublicKey } = await import('./nostr-mirror.js');
    const relays = mirrorNostr
      ? String(mirrorNostr).split(',').map((relay) => relay.trim()).filter(Boolean)
      : [...DEFAULT_NOSTR_RELAYS];
    if (relays.some((relay) => !/^wss?:\/\//.test(relay))) throw new Error('Nostr relays must use wss:// (or ws:// on loopback)');
    const secretKey = share.mirror?.type === 'nostr' && share.mirror.secretKey
      ? share.mirror.secretKey
      : generateNostrMirrorKey();
    share.mirror = {
      type: 'nostr',
      secretKey,
      relays,
      publicBaseUrl: nostrPublicBase(await nostrPublicKey(secretKey), relays),
    };
    mirrorChanged = true;
  } else if (mirrorIpfs) {
    // --mirror-ipfs http(s)://<kubo-rpc-endpoint> — the adapter is pure
    // HTTP against any node's RPC API (LAN box, container, hosted RPC);
    // nothing is installed here. Auth, when the endpoint needs it, comes
    // from IPFS_API_AUTHORIZATION in the environment.
    const { IpfsMirrorClient } = await import('./mirror.js');
    const authorization = process.env.IPFS_API_AUTHORIZATION || null;
    const client = new IpfsMirrorClient({
      apiUrl: mirrorIpfs,
      authorization,
      ...(mirrorGateway ? { gateway: mirrorGateway } : {}),
    });
    const publicBaseUrl = mirrorPublic ?? await client.publicBase();
    share.mirror = {
      type: 'ipfs',
      apiUrl: new URL(mirrorIpfs).origin,
      ...(authorization ? { authorization } : {}),
      gateway: mirrorGateway ?? 'https://ipfs.io',
      publicBaseUrl,
    };
    mirrorChanged = true;
  } else if (mirrorOption) {
    // --mirror https://<endpoint>/<bucket>[/<prefix>] — credentials come
    // from the standard AWS environment, never from the command line where
    // they would land in shell history.
    const url = new URL(validateMirrorUrl(mirrorOption));
    const [bucket, ...prefixParts] = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (!bucket) throw new Error('The mirror URL must include the bucket: https://<endpoint>/<bucket>[/<prefix>]');
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? '';
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? '';
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment for the mirror bucket');
    }
    share.mirror = {
      endpoint: url.origin,
      bucket,
      prefix: prefixParts.join('/'),
      region: process.env.AWS_REGION ?? 'auto',
      accessKeyId,
      secretAccessKey,
      publicBaseUrl: mirrorPublic
        ? validateMirrorUrl(mirrorPublic)
        : validateMirrorUrl(mirrorOption),
    };
    mirrorChanged = true;
  }
  if ((created || resumed) && !share.mirror && !mirrorChanged) {
    // The mirror preference is sticky: a fresh share comes up mirrored the
    // way this repository always mirrors, without being asked again — and a
    // repository with no preference at all defaults to Nostr on the free
    // public relays, so a bare `git pigeon share` never hands out a link
    // that goes dark the moment the watcher does.
    try {
      const { DEFAULT_NOSTR_RELAYS } = await import('./nostr-mirror.js');
      const defaults = config.mirrorDefaults ?? { type: 'nostr', relays: [...DEFAULT_NOSTR_RELAYS] };
      const { buildMirrorFromDefaults } = await import('./mirror.js');
      const rebuilt = await buildMirrorFromDefaults(defaults);
      if (rebuilt) {
        share.mirror = rebuilt;
        mirrorChanged = true;
      }
    } catch (error) {
      console.log(`The configured mirror could not be attached: ${error.message}`);
    }
  }
  let mirrorDefaults = config.mirrorDefaults;
  if (mirrorOption === 'off') {
    mirrorDefaults = undefined;
  } else if (share.mirror?.type === 'nostr') {
    mirrorDefaults = { type: 'nostr', relays: [...share.mirror.relays] };
  } else if (share.mirror?.type === 'ipfs') {
    const { secretKey, publicBaseUrl, ...rest } = share.mirror;
    void secretKey; void publicBaseUrl;
    mirrorDefaults = { ...rest };
  } else if (share.mirror?.type === 's3') {
    mirrorDefaults = { ...share.mirror };
  }
  if (created || resumed || mirrorChanged || rotate) {
    const next = { ...config, share };
    delete next.shareDormant;
    if (mirrorDefaults) next.mirrorDefaults = mirrorDefaults;
    else delete next.mirrorDefaults;
    await saveConfig(repository.gitDir, next);
  }
  const parameters = {
    repositoryId: config.repositoryId,
    shareKey: share.key,
    ownerPublicKey: share.ownerPublicKey,
    signalingServer: config.signalingServer,
    mirror: share.mirror?.publicBaseUrl,
  };
  console.log(created
    ? 'This repository is now shared. Anyone with this link can read and mirror it;'
    : resumed
      ? 'This repository is shared again at its usual link. Anyone with it can read and mirror;'
      : 'This repository is already shared. Anyone with this link can read and mirror it;');
  console.log('only your approved devices can change it.\n');
  console.log(createShareUrl(parameters));
  console.log(`\nLocal dev variant:\n${createShareUrl({ ...parameters, origin: 'https://localhost:3000' })}`);
  if (share.mirror) {
    console.log(`\nAlways-on mirror: ${share.mirror.type === 'nostr'
      ? `Nostr, ${share.mirror.relays.length} relay${share.mirror.relays.length === 1 ? '' : 's'} (${share.mirror.relays.join(', ')})`
      : `${share.mirror.publicBaseUrl} (${share.mirror.type === 'ipfs' ? `IPFS node ${share.mirror.apiUrl}` : `bucket ${share.mirror.bucket}`})`}`);
  }
  if (created || resumed || mirrorChanged || rotate) {
    // The running session predates the share (or its mirror); reopen it.
    const restarted = await stopWatchService(root);
    if (restarted) await startWatchService({ root, verbose });
  }
}

async function shareGuest(config) {
  if (!config.share) {
    throw new Error('This repository is not shared. Owners run `git pigeon share`; visitors init from a share link.');
  }
  const node = await connectShareGuest({
    repositoryId: config.repositoryId,
    share: config.share,
    signalingServer: config.signalingServer,
  });
  const deadline = Date.now() + 30_000;
  while (node.getConnectedPeers().length === 0 && Date.now() < deadline) await sleep(300);
  if (node.getConnectedPeers().length === 0) {
    await node.destroy().catch(() => {});
    throw new Error('No share-room peer is reachable right now.');
  }
  return node;
}

async function commandPropose(args, cwd) {
  const title = takeOption(args, '--title') ?? '';
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  const keyPair = await loadPairingKeyPair(machineIndexRoot());
  const node = await shareGuest(config);
  try {
    const proposal = await submitProposal({
      repository,
      repositoryId: config.repositoryId,
      share: config.share,
      node,
      keyPair,
      title,
      author: deviceHostName(),
    });
    // Let the records replicate off this transient guest before it leaves.
    await sleep(2_000);
    console.log(`Proposed ${proposal.proposalId}${proposal.title ? ` — "${proposal.title}"` : ''}`);
    console.log('An approved device reviews it with `git pigeon proposals` and merges when ready.');
  } finally {
    await node.destroy().catch(() => {});
  }
}

async function commandProposals(args, cwd) {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { config } = await configuredRepository(cwd);
  const node = await shareGuest(config);
  try {
    // A fresh guest needs a moment for the room's records to replicate in.
    let proposals = [];
    const deadline = Date.now() + 10_000;
    for (;;) {
      proposals = await listProposals({ node, repositoryId: config.repositoryId });
      if (proposals.length || Date.now() > deadline) break;
      await sleep(500);
    }
    if (!proposals.length) {
      console.log('No proposals have replicated to this device.');
      return;
    }
    for (const proposal of proposals) {
      console.log(`${proposal.proposalId}  ${proposal.submittedAt}  ${proposal.author || 'unknown'}  ${proposal.title || '(untitled)'}`);
    }
    console.log('\nReview one with `git pigeon accept <id>`.');
  } finally {
    await node.destroy().catch(() => {});
  }
}

async function commandAccept(args, cwd) {
  const wanted = String(args.shift() ?? '').trim();
  if (!wanted) throw new Error('accept requires a proposal id (see `git pigeon proposals`)');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const { repository, config } = await configuredRepository(cwd);
  const node = await shareGuest(config);
  try {
    const proposals = await listProposals({ node, repositoryId: config.repositoryId });
    const matches = proposals.filter((proposal) => proposal.proposalId.startsWith(wanted));
    if (matches.length > 1) throw new Error(`Proposal id ${wanted} is ambiguous.`);
    const proposalId = matches[0]?.proposalId ?? wanted;
    const { proposal, reviewRefs } = await fetchProposal({
      repository,
      repositoryId: config.repositoryId,
      node,
      proposalId,
    });
    console.log(`Fetched "${proposal.title || proposal.proposalId}" for review:`);
    for (const ref of reviewRefs) console.log(`  ${ref}`);
    console.log('\nReview and merge with ordinary git, for example:');
    console.log(`  git diff HEAD...${reviewRefs[0]}`);
    console.log(`  git merge ${reviewRefs[0]}`);
    console.log('Once merged and committed, the watcher publishes the new shared head.');
  } finally {
    await node.destroy().catch(() => {});
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

  let repository;
  let config;
  try {
    ({ repository, config } = await configuredRepository(cwd));
  } catch (error) {
    const message = String(error.message);
    if (!message.includes('Not a Git repository') && !message.includes('not configured')) throw error;
    // `git pigeon watch` in a plain folder means "make this a watched
    // repository": run the exact bootstrap `git pigeon init` performs —
    // `git init` included — which registers the repository and starts the
    // machine-wide watcher. Nothing left to do afterwards.
    return await commandInit([], cwd, verbose);
  }
  const root = machineIndexRoot();
  const wasRegistered = (await listMachinePigeons({ root, activeOnly: false }))
    .some((entry) => entry.repository === repository.root);
  await registerMachinePigeon(repository, config, {
    root,
    pid: null,
    fresh: true,
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
  const repositoryId = takeOption(args, '--id');
  if (repositoryId) {
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const result = await tombstoneMachinePigeon(repositoryId);
    console.log(result.unregistered
      ? `Removed and tombstoned ${repositoryId} in the encrypted PeerPigeon index.`
      : `Tombstoned ${repositoryId} in the encrypted PeerPigeon index. Paired browsers will drop it once the tombstone propagates.`);
    return;
  }
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
  // Unregister the recorded path directly: a clone that was moved or deleted
  // from disk is exactly the registration unwatch exists to clean up, and
  // discovering it as a Git repository can never succeed then.
  await unregisterMachinePigeon({ root: match.root });
  console.log(`Removed ${match.name} from the encrypted PeerPigeon index. The machine-wide service is still running.`);
}

async function commandUpdate(args, verbose) {
  const local = takeFlag(args, '--local');
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  const channel = local ? 'local' : 'remote';
  const log = logger(verbose);
  const root = machineIndexRoot();
  let result;
  if (channel === 'remote') {
    const { downloadReleaseUpdate } = await import('./auto-update.js');
    result = await downloadReleaseUpdate({ root, currentVersion: GITPIGEON_VERSION });
    if (result.unsupported) throw new Error('No release build exists for this platform');
    if (!result.updated) {
      console.log(`GitPigeon ${GITPIGEON_VERSION} is already the newest release.`);
      return;
    }
  } else {
    // The LAN channel: whichever paired watcher runs a newer build offers it
    // over the encrypted index mesh; this machine pulls, verifies and
    // installs it — no release required. Join as a guest node, not a second
    // index service: the full service publishes records and takes the state
    // lock the running watcher already holds, which timed out instead of
    // updating.
    const current = await loadMachineIndex({ root, create: false });
    const { installNativeWebRTC } = await import('./webrtc.js');
    await installNativeWebRTC();
    const { PeerPigeonNode } = await import('peerpigeon');
    const { INDEX_NETWORK_ID } = await import('./machine-index.js');
    const node = new PeerPigeonNode({
      crypto: { roomId: `gitpigeon:index:${current.indexId}`, roomSecret: current.secret },
      networkId: INDEX_NETWORK_ID,
      sessionId: current.indexId,
    });
    await node.start();
    try {
      console.log('Looking for a newer build on the mesh…');
      result = await pullPeerUpdateOnce({
        node,
        root,
        currentVersion: GITPIGEON_VERSION,
        standalone: false,
        logger: log,
        timeoutMs: 60_000,
      });
    } finally {
      await node.destroy().catch(() => {});
    }
    if (!result.updated) {
      console.log(`No paired watcher is offering anything newer than ${GITPIGEON_VERSION}.`);
      return;
    }
  }
  console.log(`Installed GitPigeon ${result.version}; restarting the watcher.`);
  await stopWatchService(root);
  await startWatchService({ root, verbose });
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
  // A share link IS the capability — no sealed grant, no device key. The
  // browser's Clone button hands it straight to the app; this machine
  // becomes a full local clone and a mirror.
  let sharedJoin = null;
  try {
    sharedJoin = parseShareUrl(value);
  } catch { /* not a share link; fall through to the sealed clone flow */ }
  if (sharedJoin) {
    const base = path.resolve(process.env.GITPIGEON_CLONE_DIR ?? path.join(homedir(), 'GitPigeon'));
    await mkdir(base, { recursive: true });
    const target = await availableCloneTarget(
      base,
      safeRepositoryDirectoryName(`shared-${sharedJoin.repositoryId.slice(0, 8)}`, sharedJoin.repositoryId),
    );
    await commandInit([value, target], process.cwd(), verbose);
    console.log(`Mirroring the shared repository at ${target}.`);
    return;
  }
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
  // Outside a configured repository, status is still a real question — is
  // the machine-wide watcher running, and what does it watch? Erroring here
  // made the most natural health check fail exactly where people ran it.
  let configured = null;
  try {
    configured = await configuredRepository(cwd);
  } catch {
    const watcher = await watchServiceStatus(machineIndexRoot());
    const registrations = await listMachinePigeons({ activeOnly: false });
    const repositories = watchedRepositories(registrations).map((repository) => ({
      name: repository.name,
      repositoryId: repository.repositoryId,
      repository: repository.root,
      watching: watcher.running && watchServiceHasRepository(watcher, repository.root),
    }));
    const value = {
      repository: null,
      service: watcher.running ? 'running' : 'stopped',
      watcherPid: watcher.running ? watcher.pid : null,
      repositories,
    };
    if (json) {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    console.log('This directory is not a GitPigeon repository.');
    console.log(`Watcher service:  ${watcher.running ? `running (PID ${watcher.pid})` : 'stopped'}`);
    console.log(`Repositories:     ${repositories.length}`);
    for (const entry of repositories) {
      console.log(`  ${entry.name.padEnd(Math.max(...repositories.map((r) => r.name.length)))}  ${entry.repositoryId.slice(0, 10)}  ${entry.watching ? 'watching' : 'stopped'}  ${entry.repository}`);
    }
    if (!repositories.length) console.log('Run `git pigeon init` in a repository to start syncing one.');
    return;
  }
  const { repository, config } = configured;
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

/**
 * A pkg-installed /usr/local/bin binary is frozen until someone reruns an
 * installer with root, while the auto-updater keeps moving the service ahead
 * of it. That version skew is what let an outdated shim kill a healthy newer
 * service. Every standalone invocation therefore delegates to the newest
 * verified update binary when one is ahead of this build — whatever is on
 * disk at the shim path stops mattering, permanently.
 */
async function delegateToInstalledUpdate(argv) {
  if (!IS_STANDALONE || process.env.GITPIGEON_NO_DELEGATE === '1') return false;
  const installed = await readInstalledUpdate(machineIndexRoot()).catch(() => null);
  if (!installed || !isNewerVersion(installed.releaseVersion, GITPIGEON_VERSION)) return false;
  if (path.resolve(installed.executable) === path.resolve(process.execPath)) return false;
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      const child = spawn(installed.executable, argv, {
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
        // The guard breaks delegation loops when a corrupt update record
        // claims a version ahead of the binary it points at.
        env: { ...process.env, GITPIGEON_NO_DELEGATE: '1' },
      });
      child.on('error', reject);
      child.on('close', (value) => resolve(value ?? 1));
    });
  } catch {
    // The update binary vanished between the record check and the spawn;
    // this build still works, so run the command here instead.
    return false;
  }
  process.exit(code);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  await delegateToInstalledUpdate(argv);
  const args = [...argv];
  const cwd = options.cwd ?? process.cwd();
  const verbose = takeFlag(args, '--verbose');
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === 'version' || command === '--version' || command === '-V') {
    console.log(GITPIGEON_VERSION);
    return;
  }
  if (command === 'init') return await commandInit(args, cwd, verbose);
  if (command === 'install') return await commandInstall(args, verbose);
  if (command === 'enroll') return await commandEnroll(args, verbose);
  if (command === 'list') return await commandList(args);
  if (command === 'pair') return await commandPair(args, verbose);
  if (command === 'invite') return await commandInvite(args, cwd);
  if (command === 'share') return await commandShare(args, cwd, verbose);
  if (command === 'propose') return await commandPropose(args, cwd);
  if (command === 'proposals') return await commandProposals(args, cwd);
  if (command === 'accept') return await commandAccept(args, cwd);
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
  if (command === 'update') return await commandUpdate(args, verbose);
  if (command === 'clone') return await commandClone(args, cwd, verbose);
  if (command === 'protocol') return await commandProtocol(args, verbose);
  if (command === 'terminal-device') return commandTerminalDevice(args);
  if (command === 'status') return await commandStatus(args, cwd);
  if (command === 'doctor') return await commandDoctor(args, cwd);
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
