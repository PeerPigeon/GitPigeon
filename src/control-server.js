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
      // Unlock: mint a share (key + this machine's key as trust anchor) so
      // the repository gets a public read-tier link. Lock: stop publishing.
      // A key already given out cannot be untold — existing link holders
      // keep what they replicated — but a locked repository publishes no
      // new heads, and a later unlock mints a FRESH key, so old links go
      // stale rather than following the repository forever.
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
        const { createShareKey } = await import('./share.js');
        const { loadPairingKeyPair } = await import('./pairing-identity.js');
        const keyPair = await loadPairingKeyPair(this.root);
        config = await saveConfig(repository.gitDir, {
          ...config,
          share: { key: createShareKey(), ownerPublicKey: keyPair.pub, role: 'owner' },
        });
        this.logger.info?.(`Shared ${path.basename(entry.repository)} publicly`);
      } else if (!shared && config.share) {
        const { share, ...rest } = config;
        void share;
        config = await saveConfig(repository.gitDir, rest);
        this.logger.info?.(`Locked ${path.basename(entry.repository)}; its share link is now stale`);
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
      let mirror = null;
      if (frame.mirror) {
        const { validateMirrorUrl } = await import('./share.js');
        const endpointUrl = new URL(validateMirrorUrl(String(frame.mirror.url ?? '')));
        const [bucket, ...prefixParts] = endpointUrl.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
        if (!bucket) throw new Error('The mirror URL must include the bucket: https://<endpoint>/<bucket>[/<prefix>]');
        const accessKeyId = String(frame.mirror.accessKeyId ?? '').slice(0, 256);
        const secretAccessKey = String(frame.mirror.secretAccessKey ?? '').slice(0, 256);
        if (!accessKeyId || !secretAccessKey) throw new Error('The mirror needs an access key id and secret');
        mirror = {
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
      if (mirror) share.mirror = mirror;
      else delete share.mirror;
      const updated = await saveConfig(repository.gitDir, { ...config, share });
      await registerMachinePigeon(repository, updated, { root: this.root });
      this.logger.info?.(mirror
        ? `Mirror for ${path.basename(entry.repository)} set to ${mirror.publicBaseUrl}`
        : `Mirror removed from ${path.basename(entry.repository)}`);
      // Same contract as the share toggle: answer now, reload behind.
      setTimeout(() => {
        Promise.resolve(this.onShareToggled(entry.repository))
          .then(() => this.onChanged())
          .catch((error) => this.logger.debug?.(`Mirror reload: ${error.message}`));
      }, 0).unref?.();
      return { mirror: mirror ? mirror.publicBaseUrl : null };
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
