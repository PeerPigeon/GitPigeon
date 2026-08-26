import { createHash, createHmac } from 'node:crypto';

/**
 * Always-on share mirror: an S3-compatible bucket holding the share room's
 * records as ROOM CIPHERTEXT, so a share link keeps answering when every
 * watcher and browser is offline.
 *
 * The bucket never sees plaintext. Every object body is produced by
 * PeerPigeon's own room crypto (`node.crypto.encryptRoom`), keyed by the
 * share room secret that only link holders have — a public-read bucket
 * leaks nothing but sizes and update times. GitPigeon adds no cipher of its
 * own here; per the architecture boundary, crypto belongs to PeerPigeon.
 *
 * The client below is a deliberately minimal AWS SigV4 signer for PUT and
 * GET of single objects — enough for AWS S3, Cloudflare R2, MinIO, and
 * anything else speaking the S3 API. Request signing is HTTP auth, not
 * mesh crypto; hand-rolling it keeps a multi-megabyte SDK out of a
 * dependency tree that ships inside a single executable.
 */

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function uriEncodePath(path) {
  return path.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

export class S3MirrorClient {
  constructor({ endpoint, bucket, region = 'auto', accessKeyId, secretAccessKey, prefix = '', fetchImpl = fetch }) {
    const url = new URL(String(endpoint));
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('The mirror endpoint must use https');
    }
    this.endpoint = `${url.origin}`;
    this.bucket = String(bucket);
    this.region = String(region);
    this.accessKeyId = String(accessKeyId ?? '');
    this.secretAccessKey = String(secretAccessKey ?? '');
    this.prefix = String(prefix ?? '').replace(/^\/+|\/+$/g, '');
    this.fetch = fetchImpl;
    if (!this.bucket) throw new Error('The mirror bucket is required');
  }

  objectPath(key) {
    const clean = String(key).replace(/^\/+/, '');
    return `/${this.bucket}/${this.prefix ? `${this.prefix}/` : ''}${clean}`;
  }

  #sign({ method, path, headers, timestamp }) {
    const date = timestamp.slice(0, 8);
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const signedHeaderNames = Object.keys(headers).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => {
      const value = headers[Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)];
      return `${name}:${String(value).trim()}\n`;
    }).join('');
    const canonicalRequest = [
      method,
      uriEncodePath(path),
      '',
      canonicalHeaders,
      signedHeaderNames.join(';'),
      UNSIGNED_PAYLOAD,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      timestamp,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, date), this.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  }

  async #request(method, key, body = null, extraHeaders = {}) {
    const path = this.objectPath(key);
    const url = `${this.endpoint}${uriEncodePath(path)}`;
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const headers = {
      host: new URL(this.endpoint).host,
      'x-amz-content-sha256': UNSIGNED_PAYLOAD,
      'x-amz-date': timestamp,
      ...extraHeaders,
    };
    if (this.accessKeyId && this.secretAccessKey) {
      headers.authorization = this.#sign({ method, path, headers, timestamp });
    }
    const response = await this.fetch(url, { method, headers, body: body ?? undefined });
    return response;
  }

  async put(key, body, contentType = 'application/json') {
    const response = await this.#request('PUT', key, body, { 'content-type': contentType });
    if (!response.ok) throw new Error(`Mirror PUT ${key} failed: ${response.status}`);
  }

  async get(key) {
    const response = await this.#request('GET', key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Mirror GET ${key} failed: ${response.status}`);
    return await response.text();
  }
}

/** The bucket layout is versioned and record-addressed: overwrite-in-place. */
export function mirrorObjectKey(repositoryId, space, recordKey) {
  // Record keys contain '/' meaningfully; keep them readable but path-safe.
  const safe = String(recordKey).split('/').map(encodeURIComponent).join('/');
  return `gitpigeon-mirror/v1/${repositoryId}/${space}/${safe}.json`;
}

/**
 * Mirror one storage record: room-encrypt {space, key, record} with the
 * SHARE node's own crypto and upload it at a deterministic key.
 */
export async function mirrorRecord({ client, node, repositoryId, space, key, record }) {
  const cipher = await node.crypto.encryptRoom(JSON.stringify({ space, key, record }));
  await client.put(mirrorObjectKey(repositoryId, space, key), JSON.stringify({
    version: 1,
    protocol: 'gitpigeon-mirror/1',
    cipher,
  }));
}

/**
 * Follow a share node's storage and mirror every record the watcher
 * publishes there. Only OUR OWN writes are mirrored (origin local): remote
 * records already have their origin's mirror, and a mirror that re-uploaded
 * everything it replicated would fight other writers over every object.
 */
export function startShareMirror({ node, repositoryId, client, logger = {} }) {
  const storage = node.storage;
  if (!storage) throw new Error('The share node has no storage to mirror');
  let closed = false;
  let uploads = Promise.resolve();
  const enqueue = (space, key) => {
    if (closed) return;
    uploads = uploads.then(async () => {
      if (closed) return;
      try {
        const record = await storage.get(space, key);
        if (!record) return;
        await mirrorRecord({ client, node, repositoryId, space, key, record });
        logger.debug?.(`Mirrored ${space}/${key}`);
      } catch (error) {
        logger.warn?.(`Mirror upload failed for ${space}/${key}: ${error.message}`);
      }
    });
  };
  const unsubscribe = storage.subscribe((event) => {
    if (event?.origin === 'remote') return;
    const space = String(event?.space ?? '');
    const key = String(event?.key ?? '');
    if (!space || !key) return;
    enqueue(space, key);
  });
  return {
    mirrorExisting: async (entries) => {
      for (const { space, key } of entries) enqueue(space, key);
      await uploads;
    },
    flush: () => uploads,
    stop: () => {
      closed = true;
      unsubscribe?.();
    },
  };
}
