import { createHash } from 'node:crypto';
import {
  SNAPSHOT_CHANNEL,
  onChannelMessage,
  sendChannelDirect,
} from './channel.js';

// Snapshot delivery used to be a bespoke wire protocol: an eight-byte magic,
// an AES-256-GCM frame per chunk, monotonic sequence numbers, a 32-frame
// send window, and explicit ACK/CANCEL/ERROR/END frame types, all carried over
// raw `mesh.send`. PeerPigeon already encrypts, authenticates, and routes
// direct messages, and the manifest already splits content into chunks, so the
// remaining protocol is a request and a response.
//
// Backpressure now belongs to the requester: a peer asks for the chunks it
// still needs and paces its own in-flight window. That removes the sender-side
// window entirely and, because PeerPigeon routes direct messages through the
// mesh, works for peers that are not direct data-channel neighbours.

const DIGEST = /^[a-f0-9]{64}$/;
const MAX_CHUNKS_PER_REQUEST = 8;

function watcherServiceMetadata(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of [
    'protocol',
    'repositoryId',
    'repositoryName',
    'deviceId',
    'serviceInstanceId',
    'machineIndexId',
    'deviceName',
  ]) {
    if (typeof value[key] === 'string') result[key] = value[key];
  }
  return result;
}

export class SnapshotStreamServer {
  constructor({ node, repositoryId, cache, getMetadata = null, logger = {} }) {
    this.node = node;
    this.repositoryId = repositoryId;
    this.cache = cache;
    this.getMetadata = getMetadata;
    this.logger = logger;
    this.unsubscribe = null;
    this.serving = new Set();
  }

  start() {
    if (this.unsubscribe || !this.node) return;
    this.unsubscribe = onChannelMessage(
      this.node,
      this.repositoryId,
      SNAPSHOT_CHANNEL,
      (frame, { peerId }) => {
        this.#handle(peerId, frame).catch((error) => this.logger.debug?.(`Snapshot request: ${error.message}`));
      },
    );
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.serving.clear();
  }

  activeSnapshotIds() {
    return [...this.serving];
  }

  async #handle(peerId, frame) {
    if (frame.kind === 'metadata-request') {
      const metadata = watcherServiceMetadata(await this.getMetadata?.());
      if (!metadata) return;
      await this.#reply(peerId, { kind: 'metadata', requestId: frame.requestId, metadata });
      return;
    }
    if (frame.kind !== 'chunk-request') return;
    if (!DIGEST.test(String(frame.snapshotId ?? ''))) return;
    const digests = Array.isArray(frame.digests)
      ? frame.digests.map(String).filter((value) => DIGEST.test(value)).slice(0, MAX_CHUNKS_PER_REQUEST)
      : [];
    if (!digests.length) return;

    const manifest = await this.cache.readManifest(frame.snapshotId);
    if (!manifest || manifest.snapshotId !== frame.snapshotId || !Array.isArray(manifest.chunks)) {
      await this.#reply(peerId, {
        kind: 'error',
        requestId: frame.requestId,
        message: 'Snapshot is not available from this peer.',
      });
      return;
    }
    // Only serve digests this snapshot actually references, so a peer holding
    // the repository secret still cannot read unrelated cache entries.
    const referenced = new Set([
      ...manifest.chunks.map((chunk) => chunk.sha256),
      ...(manifest.files ?? []).flatMap((file) => (file.chunks ?? []).map((chunk) => chunk.sha256)),
      ...(manifest.liveFiles ?? []).flatMap((file) => (file.chunks ?? []).map((chunk) => chunk.sha256)),
    ]);

    this.serving.add(frame.snapshotId);
    try {
      for (const sha256 of digests) {
        if (!referenced.has(sha256)) continue;
        let data;
        try {
          data = await this.cache.readChunk(sha256);
        } catch (error) {
          await this.#reply(peerId, { kind: 'error', requestId: frame.requestId, sha256, message: error.message });
          continue;
        }
        if (createHash('sha256').update(data).digest('hex') !== sha256) {
          await this.#reply(peerId, {
            kind: 'error',
            requestId: frame.requestId,
            sha256,
            message: `Cached snapshot chunk ${sha256.slice(0, 10)} is corrupt`,
          });
          continue;
        }
        await this.#reply(peerId, {
          kind: 'chunk',
          requestId: frame.requestId,
          snapshotId: frame.snapshotId,
          sha256,
          size: data.length,
          encoding: 'base64',
          data: data.toString('base64'),
        });
      }
    } finally {
      this.serving.delete(frame.snapshotId);
    }
  }

  async #reply(peerId, frame) {
    await sendChannelDirect(this.node, peerId, this.repositoryId, SNAPSHOT_CHANNEL, frame);
  }
}
