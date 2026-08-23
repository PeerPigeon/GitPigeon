import path from 'node:path';
import { CONTROL_CHANNEL, onChannelMessage, sendChannelDirect } from './channel.js';
import {
  loadMachineIndex,
  listMachinePigeons,
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
  constructor({ node, indexId, root, logger = {}, onChanged = async () => {} }) {
    this.node = node;
    this.indexId = indexId;
    this.root = root;
    this.logger = logger;
    this.onChanged = onChanged;
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
      return { indexId: rotated.indexId };
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
