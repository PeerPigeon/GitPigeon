import { createHash, randomBytes } from 'node:crypto';

/**
 * Nostr mirror: the share's records ride free public relays as parameterized
 * replaceable events — "stable address, latest version wins" is exactly the
 * mirror's record model, and identity is nothing but a keypair the watcher
 * generates for the share. Zero accounts, zero infrastructure, and the
 * watcher's normal re-seeding refreshes every relay's copy each time it
 * comes online, which is what keeps best-effort relay retention honest.
 *
 * Everything in `content` is the same room-ciphertext envelope every other
 * adapter stores; relays never see plaintext. Event signing is Schnorr over
 * secp256k1 via @noble/curves — protocol authentication for an external
 * network, the same category as the S3 client's SigV4, not mesh crypto.
 */

export const NOSTR_MIRROR_KIND = 30078;
export const DEFAULT_NOSTR_RELAYS = Object.freeze([
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]);

const OK_TIMEOUT_MS = 10_000;

export function generateNostrMirrorKey() {
  return randomBytes(32).toString('hex');
}

async function schnorrTools() {
  const { schnorr } = await import('@noble/curves/secp256k1');
  return schnorr;
}

export async function nostrPublicKey(secretKey) {
  const schnorr = await schnorrTools();
  return Buffer.from(schnorr.getPublicKey(secretKey)).toString('hex');
}

/** The reader-facing base: nostr:<pubkey>?relays=<wss…,wss…> */
export function nostrPublicBase(publicKey, relays) {
  return `nostr:${publicKey}?relays=${encodeURIComponent(relays.join(','))}`;
}

export function parseNostrBase(value) {
  const match = /^nostr:([0-9a-f]{64})\?relays=(.+)$/.exec(String(value));
  if (!match) return null;
  const relays = decodeURIComponent(match[2]).split(',').map((relay) => relay.trim()).filter(Boolean);
  if (!relays.length || relays.some((relay) => !/^wss?:\/\//.test(relay))) return null;
  return { publicKey: match[1], relays };
}

export async function signedMirrorEvent({ secretKey, recordKey, content, createdAt }) {
  const schnorr = await schnorrTools();
  const pubkey = Buffer.from(schnorr.getPublicKey(secretKey)).toString('hex');
  const tags = [['d', String(recordKey)]];
  const serialized = JSON.stringify([0, pubkey, createdAt, NOSTR_MIRROR_KIND, tags, content]);
  const id = createHash('sha256').update(serialized).digest('hex');
  const sig = Buffer.from(await schnorr.sign(id, secretKey)).toString('hex');
  return { id, pubkey, created_at: createdAt, kind: NOSTR_MIRROR_KIND, tags, content, sig };
}

class RelayConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.opening = null;
    this.pendingOk = new Map();
  }

  async #open() {
    if (this.socket?.readyState === 1) return this.socket;
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Relay ${this.url} did not open`));
      }, OK_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve(socket);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`Relay ${this.url} refused the connection`));
      });
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null;
      });
      socket.addEventListener('message', (message) => {
        let frame;
        try { frame = JSON.parse(String(message.data)); } catch { return; }
        if (Array.isArray(frame) && frame[0] === 'OK') {
          const settle = this.pendingOk.get(frame[1]);
          if (settle) {
            this.pendingOk.delete(frame[1]);
            settle(frame[2] === true ? null : new Error(String(frame[3] ?? 'relay rejected the event')));
          }
        }
      });
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  async publish(event) {
    const socket = await this.#open();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOk.delete(event.id);
        reject(new Error(`Relay ${this.url} did not acknowledge`));
      }, OK_TIMEOUT_MS);
      this.pendingOk.set(event.id, (failure) => {
        clearTimeout(timer);
        failure ? reject(failure) : resolve();
      });
      socket.send(JSON.stringify(['EVENT', event]));
    });
  }

  async query(filter, timeoutMs = OK_TIMEOUT_MS) {
    const socket = await this.#open();
    const subId = `inv${Math.floor(Math.random() * 1_000_000)}`;
    return await new Promise((resolve) => {
      const events = [];
      const finish = () => {
        socket.removeEventListener('message', onMessage);
        clearTimeout(timer);
        try { socket.send(JSON.stringify(['CLOSE', subId])); } catch { /* best effort */ }
        resolve(events);
      };
      const timer = setTimeout(finish, timeoutMs);
      const onMessage = (message) => {
        let frame;
        try { frame = JSON.parse(String(message.data)); } catch { return; }
        if (!Array.isArray(frame) || frame[1] !== subId) return;
        if (frame[0] === 'EVENT' && frame[2]) events.push(frame[2]);
        if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') finish();
      };
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify(['REQ', subId, filter]));
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}

export class NostrMirrorClient {
  constructor({ secretKey, relays = DEFAULT_NOSTR_RELAYS }) {
    if (!/^[0-9a-f]{64}$/.test(String(secretKey))) throw new Error('The Nostr mirror needs a 32-byte hex secret key');
    this.secretKey = String(secretKey);
    this.relays = [...relays].map(String);
    if (!this.relays.length) throw new Error('The Nostr mirror needs at least one relay');
    this.connections = this.relays.map((url) => new RelayConnection(url));
    this.lastCreatedAt = 0;
  }

  async publicBase() {
    return nostrPublicBase(await nostrPublicKey(this.secretKey), this.relays);
  }

  /**
   * Square up with the relays: one query per relay for our own records,
   * merged to the newest sighting per address. The seed skips whatever is
   * already held fresh — records only change while a watcher runs, so
   * anything present was uploaded when it last changed.
   */
  async inventory() {
    const publicKey = await nostrPublicKey(this.secretKey);
    const seen = new Map();
    const results = await Promise.allSettled(this.connections.map((relay) =>
      relay.query({ authors: [publicKey], kinds: [NOSTR_MIRROR_KIND] })));
    for (const outcome of results) {
      if (outcome.status !== 'fulfilled') continue;
      for (const event of outcome.value) {
        const dTag = event.tags?.find((tag) => tag[0] === 'd')?.[1];
        if (!dTag) continue;
        const at = Number(event.created_at) * 1000;
        if (!seen.has(dTag) || at > seen.get(dTag)) seen.set(dTag, at);
      }
    }
    return seen;
  }

  async put(key, body) {
    // Replaceable events resolve same-address conflicts by created_at, so
    // two updates within one second must not tie.
    const createdAt = Math.max(Math.floor(Date.now() / 1000), this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    const event = await signedMirrorEvent({
      secretKey: this.secretKey,
      recordKey: key,
      content: String(body),
      createdAt,
    });
    const outcomes = await Promise.allSettled(this.connections.map((relay) => relay.publish(event)));
    if (!outcomes.some((outcome) => outcome.status === 'fulfilled')) {
      throw new Error(`No relay accepted ${key}: ${outcomes[0]?.reason?.message ?? 'unknown'}`);
    }
  }

  close() {
    for (const relay of this.connections) relay.close();
  }
}
