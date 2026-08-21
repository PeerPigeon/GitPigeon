import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('GPSTRM1\0', 'ascii');
const HEADER_SIZE = MAGIC.length + 1 + 16 + 4;
const IV_SIZE = 12;
const TAG_SIZE = 16;
const TYPE_REQUEST = 1;
const TYPE_DATA = 2;
const TYPE_ACK = 3;
const TYPE_END = 4;
const TYPE_ERROR = 5;
const TYPE_CANCEL = 6;
const TYPE_METADATA_REQUEST = 7;
const TYPE_METADATA = 8;
const SEND_WINDOW = 32;
const DIGEST = /^[a-f0-9]{64}$/;

function streamKey(secret) {
  return createHash('sha256')
    .update('gitpigeon:snapshot-stream:v1\0')
    .update(String(secret))
    .digest();
}

function frameBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function requestKey(peerId, requestId) {
  return `${peerId}:${requestId.toString('hex')}`;
}

function encodeFrame(key, type, requestId, sequence, plaintext = Buffer.alloc(0)) {
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header[MAGIC.length] = type;
  requestId.copy(header, MAGIC.length + 1);
  header.writeUInt32BE(sequence >>> 0, MAGIC.length + 17);
  const iv = randomBytes(IV_SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, iv, encrypted, cipher.getAuthTag()]);
}

function decodeFrame(key, value) {
  const frame = frameBytes(value);
  if (!frame || frame.length < HEADER_SIZE + IV_SIZE + TAG_SIZE) return null;
  if (!frame.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const header = frame.subarray(0, HEADER_SIZE);
  const type = header[MAGIC.length];
  if (![TYPE_REQUEST, TYPE_DATA, TYPE_ACK, TYPE_END, TYPE_ERROR, TYPE_CANCEL, TYPE_METADATA_REQUEST, TYPE_METADATA].includes(type)) return null;
  const requestId = Buffer.from(header.subarray(MAGIC.length + 1, MAGIC.length + 17));
  const sequence = header.readUInt32BE(MAGIC.length + 17);
  const ivStart = HEADER_SIZE;
  const bodyStart = ivStart + IV_SIZE;
  const tagStart = frame.length - TAG_SIZE;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, frame.subarray(ivStart, bodyStart));
    decipher.setAAD(header);
    decipher.setAuthTag(frame.subarray(tagStart));
    const plaintext = Buffer.concat([decipher.update(frame.subarray(bodyStart, tagStart)), decipher.final()]);
    return { type, requestId, sequence, plaintext };
  } catch {
    return null;
  }
}

function parseRequest(frame) {
  try {
    const value = JSON.parse(frame.plaintext.toString('utf8'));
    if (!value || typeof value !== 'object') return null;
    const snapshotId = String(value.snapshotId ?? '');
    const bundleSha256 = String(value.bundleSha256 ?? '');
    if (!DIGEST.test(snapshotId) || !DIGEST.test(bundleSha256)) return null;
    return { snapshotId, bundleSha256 };
  } catch {
    return null;
  }
}

export class SnapshotStreamServer {
  constructor({ mesh, cache, secret, getMetadata = null, logger = {} }) {
    this.mesh = mesh;
    this.cache = cache;
    this.key = streamKey(secret);
    this.getMetadata = getMetadata;
    this.logger = logger;
    this.transfers = new Map();
    this.onData = ({ peerId, data }) => { this.#handle(peerId, data).catch((error) => logger.debug?.(error.message)); };
  }

  start() {
    this.mesh?.on?.('peer:data', this.onData);
  }

  stop() {
    this.mesh?.off?.('peer:data', this.onData);
    for (const transfer of this.transfers.values()) transfer.cancelled = true;
    this.transfers.clear();
  }

  activeSnapshotIds() {
    return [...new Set([...this.transfers.values()].map((transfer) => transfer.manifest.snapshotId))];
  }

  async #handle(peerId, data) {
    const frame = decodeFrame(this.key, data);
    if (!frame) return;
    if (frame.type === TYPE_METADATA_REQUEST) {
      const metadata = await this.getMetadata?.();
      if (metadata) {
        this.#send(peerId, encodeFrame(
          this.key,
          TYPE_METADATA,
          frame.requestId,
          0,
          Buffer.from(JSON.stringify(metadata)),
        ));
      }
      return;
    }
    const id = requestKey(peerId, frame.requestId);
    if (frame.type === TYPE_CANCEL) {
      const transfer = this.transfers.get(id);
      if (transfer) transfer.cancelled = true;
      this.transfers.delete(id);
      return;
    }
    if (frame.type === TYPE_ACK) {
      const transfer = this.transfers.get(id);
      if (!transfer || frame.sequence <= transfer.acknowledged) return;
      transfer.acknowledged = frame.sequence;
      await this.#pump(transfer);
      return;
    }
    if (frame.type !== TYPE_REQUEST || this.transfers.has(id)) return;
    const request = parseRequest(frame);
    if (!request) return;
    const manifest = await this.cache.readManifest(request.snapshotId);
    if (!manifest || manifest.snapshotId !== request.snapshotId || manifest.bundleSha256 !== request.bundleSha256
      || !Array.isArray(manifest.chunks)) {
      this.#send(peerId, encodeFrame(
        this.key,
        TYPE_ERROR,
        frame.requestId,
        0,
        Buffer.from('Snapshot is not available from this peer.'),
      ));
      return;
    }
    const transfer = {
      id,
      peerId,
      requestId: frame.requestId,
      manifest,
      acknowledged: 0,
      next: 0,
      pumping: false,
      cancelled: false,
      startedAt: Date.now(),
    };
    this.transfers.set(id, transfer);
    await this.#pump(transfer);
  }

  async #pump(transfer) {
    if (transfer.pumping || transfer.cancelled) return;
    transfer.pumping = true;
    try {
      const limit = Math.min(transfer.manifest.chunks.length, transfer.acknowledged + SEND_WINDOW);
      while (!transfer.cancelled && transfer.next < limit) {
        const descriptor = transfer.manifest.chunks[transfer.next];
        const data = await this.cache.readChunk(descriptor.sha256);
        if (data.length !== descriptor.size) throw new Error(`Cached snapshot chunk ${descriptor.sha256.slice(0, 10)} has the wrong size`);
        this.#send(transfer.peerId, encodeFrame(this.key, TYPE_DATA, transfer.requestId, transfer.next, data));
        transfer.next += 1;
        if (transfer.next % 8 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      if (!transfer.cancelled && transfer.next === transfer.manifest.chunks.length) {
        this.#send(transfer.peerId, encodeFrame(
          this.key,
          TYPE_END,
          transfer.requestId,
          transfer.next,
          Buffer.from(JSON.stringify({
            size: transfer.manifest.bundleSize,
            sha256: transfer.manifest.bundleSha256,
          })),
        ));
        this.logger.info?.(
          `Streamed ${transfer.manifest.bundleSize} snapshot bytes to a browser in ${Date.now() - transfer.startedAt} ms`,
        );
        this.transfers.delete(transfer.id);
      }
    } catch (error) {
      if (!transfer.cancelled) {
        try {
          this.#send(transfer.peerId, encodeFrame(
            this.key,
            TYPE_ERROR,
            transfer.requestId,
            transfer.next,
            Buffer.from(error.message),
          ));
        } catch { /* the peer already left */ }
      }
      this.transfers.delete(transfer.id);
    } finally {
      transfer.pumping = false;
      const nextLimit = Math.min(transfer.manifest.chunks.length, transfer.acknowledged + SEND_WINDOW);
      if (!transfer.cancelled && this.transfers.has(transfer.id) && transfer.next < nextLimit) {
        queueMicrotask(() => { this.#pump(transfer); });
      }
    }
  }

  #send(peerId, frame) {
    this.mesh.send(peerId, frame);
  }
}

export const snapshotStreamWire = {
  MAGIC,
  HEADER_SIZE,
  IV_SIZE,
  TAG_SIZE,
  TYPE_REQUEST,
  TYPE_DATA,
  TYPE_ACK,
  TYPE_END,
  TYPE_ERROR,
  TYPE_CANCEL,
  TYPE_METADATA_REQUEST,
  TYPE_METADATA,
  encodeFrame,
  decodeFrame,
  streamKey,
};
