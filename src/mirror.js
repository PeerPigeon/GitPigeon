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

/**
 * IPFS mirror over kubo's HTTP RPC API — no local install, just an endpoint:
 * a node on the LAN, a container, or a hosted RPC with an auth header.
 * Records land in the node's MFS (its mutable file tree) at the SAME layout
 * every adapter uses, and the tree's root is published under the node's IPNS
 * name after writes settle. Readers change nothing: the public base URL is
 * any gateway's /ipns/<name> path, which resolves the same
 * gitpigeon-mirror/v1/... paths the S3 reader already fetches.
 *
 * IPNS publication is debounced: it is the expensive step, and one publish
 * after a burst of record writes is what the availability story needs.
 */
export class IpfsMirrorClient {
  constructor({ apiUrl, authorization = null, gateway = 'https://ipfs.io', publishDebounceMs = 2_000, fetchImpl = fetch }) {
    const url = new URL(String(apiUrl));
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new Error('The IPFS API endpoint must use https (or http on loopback)');
    }
    this.apiUrl = url.origin;
    this.authorization = authorization ? String(authorization) : null;
    this.gateway = String(gateway).replace(/\/$/, '');
    this.publishDebounceMs = publishDebounceMs;
    this.fetch = fetchImpl;
    this.publishTimer = null;
    this.publishing = Promise.resolve();
  }

  async #rpc(pathname, { params = {}, body = null } = {}) {
    const url = new URL(`/api/v0/${pathname}`, this.apiUrl);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    let requestBody;
    const headers = this.authorization ? { authorization: this.authorization } : {};
    if (body !== null) {
      const form = new FormData();
      form.set('file', new Blob([body], { type: 'application/octet-stream' }), 'record.json');
      requestBody = form;
    }
    const response = await this.fetch(url.toString(), { method: 'POST', headers, body: requestBody });
    if (!response.ok) throw new Error(`IPFS ${pathname} failed: ${response.status}`);
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }

  /** The stable public base for share links: <gateway>/ipns/<node id>. */
  async publicBase() {
    const identity = await this.#rpc('id');
    const name = String(identity?.ID ?? '');
    if (!name) throw new Error('The IPFS node did not report an identity');
    return `${this.gateway}/ipns/${name}`;
  }

  async put(key, body) {
    const path = `/${String(key).replace(/^\/+/, '')}`;
    await this.#rpc('files/write', {
      params: { arg: path, create: true, parents: true, truncate: true },
      body,
    });
    this.#schedulePublish();
  }

  #schedulePublish() {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishing = this.publishing.then(() => this.#publishRoot()).catch(() => {});
    }, this.publishDebounceMs);
    this.publishTimer.unref?.();
  }

  async #publishRoot() {
    const stat = await this.#rpc('files/stat', { params: { arg: '/' } });
    const cid = String(stat?.Hash ?? '');
    if (!cid) throw new Error('The IPFS node did not report a root CID');
    await this.#rpc('name/publish', { params: { arg: `/ipfs/${cid}`, 'allow-offline': true } });
  }

  /** Force the pending publish now; used by tests and orderly shutdown. */
  async flushPublish() {
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
      this.publishing = this.publishing.then(() => this.#publishRoot()).catch(() => {});
    }
    await this.publishing;
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
  /**
   * A restart re-publishes only what changed, so unchanged records (the
   * registry above all — every reader bootstraps from it) never produce a
   * write event and would never reach a freshly configured bucket. Walk the
   * current publication set — registry → heads → manifest → chunks — and
   * enqueue whatever exists.
   */
  const REFRESH_STALENESS_MS = 72 * 60 * 60 * 1000;
  const seedCurrent = async () => {
    const prefix = `gitpigeon/v1/${repositoryId}`;
    // Square up before seeding: whatever the store already holds fresh is
    // skipped. Records only change while a watcher runs, so presence in the
    // inventory means the last change was uploaded; age beyond the refresh
    // window still re-uploads to keep best-effort retention warm.
    const inventory = await (client.inventory?.().catch(() => null) ?? null);
    const seen = new Set();
    const seed = (space, key) => {
      const id = `${space} ${key}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (inventory) {
        const heldAt = inventory.get(mirrorObjectKey(repositoryId, space, key));
        if (heldAt && Date.now() - heldAt < REFRESH_STALENESS_MS) {
          logger.debug?.(`Mirror already holds ${space}/${key}; skipping seed`);
          return;
        }
      }
      enqueue(space, key);
    };
    const registryKey = `${prefix}/registry`;
    seed('public', registryKey);
    const registry = await storage.get('public', registryKey).catch(() => null);
    for (const deviceId of registry?.value?.devices ?? []) {
      seed('public', `${prefix}/presence/${deviceId}`);
      const headKey = `${prefix}/head/${deviceId}`;
      seed('public', headKey);
      const head = await storage.get('public', headKey).catch(() => null);
      const snapshotId = head?.value?.snapshotId;
      if (!snapshotId) continue;
      seed('public', `${headKey}/${snapshotId}`);
      const manifestKey = `${prefix}/manifest/${snapshotId}`;
      seed('frozen', manifestKey);
      const manifest = await storage.get('frozen', manifestKey).catch(() => null);
      for (const chunk of manifest?.value?.chunks ?? []) {
        if (chunk?.sha256) seed('frozen', `${prefix}/chunk/${chunk.sha256}`);
      }
    }
    await uploads;
  };
  return {
    seedCurrent,
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

/**
 * Build a fresh share.mirror from the repository's sticky preference. Nostr
 * mints a NEW keypair per share, so retiring a share key retires its mirror
 * identity with it; IPFS re-derives the public base from the node (skipped
 * with a throw if the node is unreachable); S3 config carries over whole.
 */
export async function buildMirrorFromDefaults(defaults) {
  if (!defaults) return null;
  if (defaults.type === 'nostr') {
    const { generateNostrMirrorKey, nostrPublicBase, nostrPublicKey } = await import('./nostr-mirror.js');
    const secretKey = generateNostrMirrorKey();
    return {
      type: 'nostr',
      secretKey,
      relays: [...defaults.relays],
      publicBaseUrl: nostrPublicBase(await nostrPublicKey(secretKey), defaults.relays),
    };
  }
  if (defaults.type === 'ipfs') {
    const client = new IpfsMirrorClient(defaults);
    return {
      type: 'ipfs',
      apiUrl: defaults.apiUrl,
      ...(defaults.authorization ? { authorization: defaults.authorization } : {}),
      gateway: defaults.gateway,
      publicBaseUrl: await client.publicBase(),
    };
  }
  if (defaults.type === 's3') {
    return {
      ...defaults,
      publicBaseUrl: defaults.publicBaseUrl ?? `${defaults.endpoint}/${defaults.bucket}${defaults.prefix ? `/${defaults.prefix}` : ''}`,
    };
  }
  return null;
}
