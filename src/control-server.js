import path from 'node:path';
import { CONTROL_CHANNEL, onChannelMessage, sendChannelDirect } from './channel.js';
import {
  loadMachineIndex,
  listMachinePigeons,
  registerMachinePigeon,
  rotateMachineIndexSecret,
  unregisterMachinePigeon,
} from './machine-index.js';

// Commands a paired peer can issue against this machine's index.
//
// The channel rides PeerPigeon's room encryption, so only a peer holding the
// index secret can be understood at all. That is the same capability needed to
// read the index, so it is the right bar for changing it.
export const CONTROL_PROTOCOL = 'gitpigeon/control/1';

const REPOSITORY_ID = /^[a-zA-Z0-9_-]{8,128}$/;

export class ControlServer {
  constructor({ node, indexId, root, logger = {}, onChanged = async () => {}, onRotated = () => {}, onShareToggled = async () => {} }) {
    this.node = node;
    this.indexId = indexId;
    this.root = root;
    this.logger = logger;
    this.onChanged = onChanged;
    this.onRotated = onRotated;
    this.onShareToggled = onShareToggled;
    this.unsubscribe = null;
  }

  start() {
    if (this.unsubscribe || !this.node) return;
    this.unsubscribe = onChannelMessage(this.node, this.indexId, CONTROL_CHANNEL, (frame, { peerId, kind }) => {
      if (kind !== 'direct') return;
      this.#handle(peerId, frame).catch((error) => this.logger.debug?.(`Control command: ${error.message}`));
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async #handle(peerId, frame) {
    const requestId = String(frame.requestId ?? '');
    if (!requestId) return;
    try {
      const result = await this.#run(frame);
      await this.#reply(peerId, { kind: 'result', requestId, ok: true, ...result });
    } catch (error) {
      await this.#reply(peerId, { kind: 'result', requestId, ok: false, message: error.message });
    }
  }

  async #run(frame) {
    if (frame.kind === 'remove-repository') {
      // `repositoryId` is reserved by the channel envelope for the room this
      // frame belongs to, so the target is named separately.
      const repositoryId = String(frame.targetRepositoryId ?? '');
      if (!REPOSITORY_ID.test(repositoryId)) throw new Error('Invalid repository ID');
      const entries = await listMachinePigeons({ root: this.root, activeOnly: false });
      const entry = entries.find((candidate) => candidate.repositoryId === repositoryId);
      if (!entry) throw new Error('That repository is not registered on this machine');
      const { removed } = await unregisterMachinePigeon({ root: entry.repository }, { root: this.root });
      await this.onChanged();
      this.logger.info?.(`Removed ${path.basename(entry.repository)} from the Pigeon index`);
      return { removed, name: entry.name };
    }
    if (frame.kind === 'rotate-index') {
      // Real revocation. Every paired peer loses access until it pairs again,
      // because the capability they hold is this secret.
      const rotated = await rotateMachineIndexSecret({ root: this.root });
      this.logger.warn?.('Rotated the Pigeon index secret; every paired device and browser must pair again');
      // Reply before the restart tears this node down, or the caller is left
      // waiting on an answer that can no longer be sent.
      setTimeout(() => {
        try { this.onRotated(); } catch (error) { this.logger.error?.(error); }
      }, 250).unref?.();
      return { indexId: rotated.indexId };
    }
    if (frame.kind === 'set-repository-sharing') {
      // One repository, one link, ALWAYS. Unlock resumes the repository's
      // permanent share identity — key, owner anchor, and mirror keypair —
      // minting one only the first time. Lock stops publishing but stows
      // the identity dormant instead of deleting it, so the link every
      // reader already holds comes back to life on the next unlock. Lock
      // is a pause, not a revocation.
      const repositoryId = String(frame.targetRepositoryId ?? '');
      const shared = Boolean(frame.shared);
      if (!REPOSITORY_ID.test(repositoryId)) throw new Error('Invalid repository ID');
      const entries = await listMachinePigeons({ root: this.root, activeOnly: false });
      const entry = entries.find((candidate) => candidate.repositoryId === repositoryId);
      if (!entry) throw new Error('That repository is not registered on this machine');
      const { GitRepository } = await import('./git.js');
      const { loadConfig, saveConfig } = await import('./config.js');
      const repository = await GitRepository.discover(entry.repository);
      let config = await loadConfig(repository.gitDir);
      if (shared && config.share?.role === 'mirror') {
        throw new Error("This is a mirror of someone else's shared repository");
      }
      if (shared && !config.share) {
        const { shareDormant, ...rest } = config;
        let share = shareDormant ?? null;
        if (!share) {
          const { createShareKey } = await import('./share.js');
          const { loadPairingKeyPair } = await import('./pairing-identity.js');
          const keyPair = await loadPairingKeyPair(this.root);
          share = { key: createShareKey(), ownerPublicKey: keyPair.pub, role: 'owner' };
        }
        // The mirror preference is sticky, and — same rule as `git pigeon
        // share` — a bare share defaults to Nostr on the free public relays.
        // The dashboard used to mint mirrorless shares whenever no preference
        // existed, so a link shared from the browser had no cloud mirror at
        // all while the CLI's did.
        if (!share.mirror) {
          try {
            const { buildMirrorFromDefaults } = await import('./mirror.js');
            const { DEFAULT_NOSTR_RELAYS } = await import('./nostr-mirror.js');
            const defaults = rest.mirrorDefaults ?? { type: 'nostr', relays: [...DEFAULT_NOSTR_RELAYS] };
            const rebuilt = await buildMirrorFromDefaults(defaults);
            if (rebuilt) share.mirror = rebuilt;
          } catch (error) {
            this.logger.warn?.(`Mirror could not be attached: ${error.message}`);
          }
        }
        config = await saveConfig(repository.gitDir, { ...rest, share });
        this.logger.info?.(`Shared ${path.basename(entry.repository)} publicly${shareDormant ? ' at its usual link' : ''}${share.mirror ? ' with its mirror attached' : ''}`);
      } else if (!shared && config.share) {
        // Lock is an owner action: a machine that merely adopted the fleet
        // share stowing its copy would flap back on the next sync while the
        // owner kept publishing. Refusing here lets the browser's control
        // fan-over reach the owning machine.
        if (config.share.role === 'mirror') {
          throw new Error('This repository is shared by another machine; the lock happens there');
        }
        const { share, ...rest } = config;
        config = await saveConfig(repository.gitDir, { ...rest, shareDormant: share });
        // A lock travels as a stated fact: every adopter and browser drops
        // this key on sight, instead of guessing from the share going quiet.
        const { markShareEnded } = await import('./machine-index.js');
        await markShareEnded(entry.repositoryId, share.key, { root: this.root });
        this.logger.info?.(`Locked ${path.basename(entry.repository)}; the same link resumes on the next unlock`);
      }
      await registerMachinePigeon(repository, config, { root: this.root });
      // Answer NOW. The session reload behind a toggle takes seconds (room
      // teardown and rejoin) and the browser only needs the new state, not
      // the reload — awaiting it made every click feel broken.
      setTimeout(() => {
        Promise.resolve(this.onShareToggled(entry.repository))
          .then(() => this.onChanged())
          .catch((error) => this.logger.debug?.(`Share toggle reload: ${error.message}`));
      }, 0).unref?.();
      return {
        shared: Boolean(config.share),
        ...(config.share ? { shareKey: config.share.key, ownerPublicKey: config.share.ownerPublicKey } : {}),
      };
    }
    if (frame.kind === 'set-share-mirror') {
      // Configure (or remove) the always-on S3-compatible mirror from the
      // browser. Credentials arrive over the paired index room's encrypted
      // channel and land only in the repository's 0600 config — the index
      // record and the share link carry the PUBLIC base URL alone.
      const repositoryId = String(frame.targetRepositoryId ?? '');
      if (!REPOSITORY_ID.test(repositoryId)) throw new Error('Invalid repository ID');
      const entries = await listMachinePigeons({ root: this.root, activeOnly: false });
      const entry = entries.find((candidate) => candidate.repositoryId === repositoryId);
      if (!entry) throw new Error('That repository is not registered on this machine');
      const { GitRepository } = await import('./git.js');
      const { loadConfig, saveConfig } = await import('./config.js');
      const repository = await GitRepository.discover(entry.repository);
      const config = await loadConfig(repository.gitDir);
      if (!config.share) throw new Error('Unlock (share) the repository before configuring its mirror');
      // The mirror identity (and its secret key) belongs to the machine that
      // owns the share; configuring it on an adopted copy would mint a second
      // identity the published link knows nothing about.
      if (config.share.role !== 'owner') throw new Error('The mirror is configured on the machine that owns the share');
      let mirror = null;
      if (frame.mirror && frame.mirror.type === 'nostr') {
        // Zero-setup default: free public relays, identity generated here
        // and kept across reconfigurations so every copied link stays valid.
        const { DEFAULT_NOSTR_RELAYS, generateNostrMirrorKey, nostrPublicBase, nostrPublicKey } = await import('./nostr-mirror.js');
        const requested = Array.isArray(frame.mirror.relays)
          ? frame.mirror.relays.map(String).map((relay) => relay.trim()).filter(Boolean)
          : [];
        const relays = requested.length ? requested : [...DEFAULT_NOSTR_RELAYS];
        if (relays.some((relay) => !/^wss?:\/\//.test(relay))) throw new Error('Nostr relays must use wss://');
        const secretKey = config.share.mirror?.type === 'nostr' && config.share.mirror.secretKey
          ? config.share.mirror.secretKey
          : generateNostrMirrorKey();
        mirror = {
          type: 'nostr',
          secretKey,
          relays,
          publicBaseUrl: nostrPublicBase(await nostrPublicKey(secretKey), relays),
        };
      } else if (frame.mirror && frame.mirror.type === 'ipfs') {
        // The IPFS adapter is pure HTTP against a kubo RPC endpoint.
        // Deriving the public base from the node's identity doubles as a
        // reachability and auth check, so a bad endpoint fails HERE, into
        // the browser's error surface, not silently in the session.
        const { IpfsMirrorClient } = await import('./mirror.js');
        const { validateMirrorUrl } = await import('./share.js');
        const apiUrl = String(frame.mirror.apiUrl ?? '');
        const authorization = frame.mirror.authorization ? String(frame.mirror.authorization).slice(0, 512) : null;
        const gateway = frame.mirror.gateway ? validateMirrorUrl(String(frame.mirror.gateway)) : 'https://ipfs.io';
        const client = new IpfsMirrorClient({ apiUrl, authorization, gateway });
        mirror = {
          type: 'ipfs',
          apiUrl: new URL(apiUrl).origin,
          ...(authorization ? { authorization } : {}),
          gateway,
          publicBaseUrl: frame.mirror.publicUrl
            ? validateMirrorUrl(String(frame.mirror.publicUrl))
            : await client.publicBase(),
        };
      } else if (frame.mirror) {
        const { validateMirrorUrl } = await import('./share.js');
        const endpointUrl = new URL(validateMirrorUrl(String(frame.mirror.url ?? '')));
        const [bucket, ...prefixParts] = endpointUrl.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
        if (!bucket) throw new Error('The mirror URL must include the bucket: https://<endpoint>/<bucket>[/<prefix>]');
        const accessKeyId = String(frame.mirror.accessKeyId ?? '').slice(0, 256);
        const secretAccessKey = String(frame.mirror.secretAccessKey ?? '').slice(0, 256);
        if (!accessKeyId || !secretAccessKey) throw new Error('The mirror needs an access key id and secret');
        mirror = {
          type: 's3',
          endpoint: endpointUrl.origin,
          bucket,
          prefix: prefixParts.join('/'),
          region: String(frame.mirror.region ?? '').slice(0, 64) || 'auto',
          accessKeyId,
          secretAccessKey,
          publicBaseUrl: frame.mirror.publicUrl
            ? validateMirrorUrl(String(frame.mirror.publicUrl))
            : validateMirrorUrl(String(frame.mirror.url)),
        };
      }
      const share = { ...config.share };
      if (!mirror) {
        // "Watcher" is never mirrorless: removing attached storage returns
        // the share to the Nostr fallback on the free public relays, with
        // the identity it already had (or a fresh one, kept from then on).
        const { DEFAULT_NOSTR_RELAYS, generateNostrMirrorKey, nostrPublicBase, nostrPublicKey } = await import('./nostr-mirror.js');
        const secretKey = config.share.mirror?.type === 'nostr' && config.share.mirror.secretKey
          ? config.share.mirror.secretKey
          : generateNostrMirrorKey();
        const relays = [...DEFAULT_NOSTR_RELAYS];
        mirror = { type: 'nostr', secretKey, relays, publicBaseUrl: nostrPublicBase(await nostrPublicKey(secretKey), relays) };
      }
      share.mirror = mirror;
      const next = { ...config, share };
      if (mirror?.type === 'nostr') next.mirrorDefaults = { type: 'nostr', relays: [...mirror.relays] };
      else if (mirror?.type === 'ipfs') {
        next.mirrorDefaults = { type: 'ipfs', apiUrl: mirror.apiUrl, ...(mirror.authorization ? { authorization: mirror.authorization } : {}), gateway: mirror.gateway };
      } else if (mirror?.type === 's3') next.mirrorDefaults = { ...mirror };
      else delete next.mirrorDefaults;
      const updated = await saveConfig(repository.gitDir, next);
      await registerMachinePigeon(repository, updated, { root: this.root });
      this.logger.info?.(`Mirror for ${path.basename(entry.repository)} set to ${mirror.publicBaseUrl}`);
      // Same contract as the share toggle: answer now, reload behind.
      setTimeout(() => {
        Promise.resolve(this.onShareToggled(entry.repository))
          .then(() => this.onChanged())
          .catch((error) => this.logger.debug?.(`Mirror reload: ${error.message}`));
      }, 0).unref?.();
      return { mirror: mirror ? mirror.publicBaseUrl : null };
    }
    if (frame.kind === 'commit-repository') {
      // Retries are how a commit outlives a flapping channel, and a retry
      // whose predecessor actually landed must not commit twice or report
      // 'Nothing to commit' over a success. The browser sends one token per
      // commit INTENT; repeats replay the recorded outcome.
      const token = String(frame.token ?? '');
      if (token && this.recentCommits?.has(token)) {
        return this.recentCommits.get(token);
      }
      // The browser's Commit button, GitHub-style: the browser is a thin
      // client and THIS machine is its server. Live-workspace edits are
      // already on this filesystem via the realtime server; committing them
      // is a watcher action, so no authority moves anywhere.
      const repositoryId = String(frame.targetRepositoryId ?? '');
      if (!REPOSITORY_ID.test(repositoryId)) throw new Error('Invalid repository ID');
      const message = String(frame.message ?? '').trim().slice(0, 500);
      if (!message) throw new Error('A commit message is required');
      const entries = await listMachinePigeons({ root: this.root, activeOnly: false });
      const entry = entries.find((candidate) => candidate.repositoryId === repositoryId);
      if (!entry) throw new Error('That repository is not registered on this machine');
      const { GitRepository } = await import('./git.js');
      const { deviceHostName } = await import('./device-name.js');
      const repository = await GitRepository.discover(entry.repository);
      await repository.git(['add', '-A']);
      const status = (await repository.git(['status', '--porcelain'])).stdout.trim();
      if (!status) throw new Error('Nothing to commit — the working tree is clean');
      // Committing must never fail on a machine with no git identity
      // configured — the machine's name stands in — but a CONFIGURED
      // identity always wins; -c would override it unconditionally.
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
      this.logger.info?.(`Committed ${commit} on ${path.basename(entry.repository)} from a paired browser`);
      if (token) {
        this.recentCommits ??= new Map();
        this.recentCommits.set(token, { commit, replayed: true });
        // A small memory of intent outcomes, not a ledger.
        while (this.recentCommits.size > 32) {
          this.recentCommits.delete(this.recentCommits.keys().next().value);
        }
      }
      return { commit };
    }
    throw new Error(`Unsupported control command: ${String(frame.kind ?? 'none')}`);
  }

  async #reply(peerId, frame) {
    await sendChannelDirect(this.node, peerId, this.indexId, CONTROL_CHANNEL, frame);
  }
}

export async function currentIndexId({ root } = {}) {
  return (await loadMachineIndex({ root })).indexId;
}
