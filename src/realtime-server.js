import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import {
  REALTIME_CHANNEL,
  broadcastChannel,
  onChannelMessage,
  sendChannelDirect,
} from './channel.js';
import { LiveWorkspace } from './live-workspace.js';

// Realtime frames used to carry their own AES-256-GCM envelope keyed by
// `sha256('gitpigeon:realtime:v1\0' + secret)`. PeerPigeon room crypto derives
// an equivalent key from the same repository secret, so only the Yjs part/total
// splitting — which PeerPigeon does not do — remains GitPigeon's concern.
export const REALTIME_PROTOCOL = 'gitpigeon/realtime/1';
const DIGEST = /^[a-f0-9]{64}$/;
const MESSAGE_ID = /^[a-f0-9]{32}$/;
const CHUNK_BYTES = 24 * 1024;
const MAX_PARTS = 512;
const MAX_ASSEMBLIES = 64;
const ASSEMBLY_TTL_MS = 30_000;

function validFrame(frame, repositoryId) {
  return frame && frame.repositoryId === repositoryId
    && DIGEST.test(String(frame.documentId ?? '')) && DIGEST.test(String(frame.baseHash ?? ''))
    && MESSAGE_ID.test(String(frame.messageId ?? ''))
    && typeof frame.path === 'string' && frame.path.length > 0 && frame.path.length <= 4_096 && !frame.path.includes('\0')
    && typeof frame.revision === 'string' && frame.revision.length > 0 && frame.revision.length <= 1_000
    && ['update', 'sync-request', 'sync-response'].includes(String(frame.kind ?? ''))
    && Number.isSafeInteger(frame.part) && Number.isSafeInteger(frame.total)
    && frame.part >= 0 && frame.total >= 1 && frame.total <= MAX_PARTS && frame.part < frame.total
    && typeof frame.payload === 'string' && frame.payload.length <= Math.ceil(CHUNK_BYTES * 4 / 3) + 8;
}

const PRESENCE_INTERVAL_MS = 10_000;
const PRESENCE_FRESH_MS = 30_000;
const SEED_RETRY_MS = 2_000;
const SEED_FALLBACK_MS = 10_000;

export class RealtimeWorkspaceServer {
  constructor({ node, repository, secret, repositoryId, deviceId = null, logger = {}, onFileWritten = null }) {
    this.node = node;
    this.repository = repository;
    this.deviceId = deviceId ? String(deviceId) : null;
    this.peerWatchers = new Map();
    this.secret = secret;
    this.repositoryId = repositoryId;
    this.logger = logger;
    this.onFileWritten = onFileWritten;
    this.liveWorkspace = new LiveWorkspace(repository);
    this.documents = new Map();
    this.lastWriteError = null;
    this.assemblies = new Map();
    this.started = false;
    this.unsubscribe = null;
    this.onPeer = (peerId) => { this.#requestAll(String(peerId ?? '')).catch(() => {}); };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.liveWorkspace.init();
    this.unsubscribe = onChannelMessage(this.node, this.repositoryId, REALTIME_CHANNEL, (frame, { peerId }) => {
      if (frame?.kind === 'presence') {
        if (typeof frame.deviceId === 'string' && frame.deviceId && frame.deviceId.length <= 128) {
          this.peerWatchers.set(frame.deviceId, Date.now());
        }
        return;
      }
      this.#receiveFrame(peerId, frame).catch((error) => this.logger.debug?.(`Realtime workspace: ${error.message}`));
    });
    this.node.on('peerConnected', this.onPeer);
    this.#announcePresence();
    this.presenceTimer = setInterval(() => this.#announcePresence(), PRESENCE_INTERVAL_MS);
    this.presenceTimer.unref?.();
  }

  #announcePresence() {
    if (!this.started || !this.deviceId) return;
    broadcastChannel(this.node, this.repositoryId, REALTIME_CHANNEL, {
      kind: 'presence',
      deviceId: this.deviceId,
    }).catch((error) => this.logger.debug?.(`Realtime presence: ${error?.message ?? error}`));
  }

  /**
   * Whether another live watcher outranks this one as the seeder. Every
   * watcher seeding its document from its own file copy was the duplication
   * loop's last engine: the copies diverge while the overlay lags, so the
   * seeds differ, and merging them unions the file's content — doubled on
   * every watcher restart. Exactly one watcher may seed: the one with the
   * smallest device id among those alive on this room.
   */
  #deferToPeerSeeder() {
    if (!this.deviceId) return false;
    const now = Date.now();
    for (const [deviceId, at] of this.peerWatchers) {
      if (now - at > PRESENCE_FRESH_MS) {
        this.peerWatchers.delete(deviceId);
        continue;
      }
      if (deviceId < this.deviceId) return true;
    }
    return false;
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.node.off('peerConnected', this.onPeer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    for (const state of this.documents.values()) {
      if (state.seedTimer) clearInterval(state.seedTimer);
      state.doc.destroy();
    }
    this.documents.clear();
    this.assemblies.clear();
  }

  /**
   * Whether a live realtime session currently owns this file. While it does,
   * the document is the only writer: the live-workspace overlay replicating
   * the same file with its own latency re-delivered stale content that read
   * as an external edit, reverting fresh keystrokes and duplicating them —
   * the loop where file contents repeated indefinitely.
   */
  ownsPath(input) {
    let file;
    try { file = this.liveWorkspace.normalize(input); } catch { return false; }
    const now = Date.now();
    for (const state of this.documents.values()) {
      if (state.path === file && now - state.lastActivityAt < 5 * 60_000) return true;
    }
    return false;
  }

  /**
   * Move a repository item — dragged in a browser, executed here, on every
   * watcher: each machine renames its own copy, so the move is one operation
   * fleet-wide instead of a delete-and-recreate ripple through the overlay.
   */
  async #moveItem(peerId, frame) {
    const replyTo = typeof frame.replyTo === 'string' && /^[a-f0-9]{64}$/.test(frame.replyTo) ? frame.replyTo : peerId;
    const respond = async (result) => {
      try {
        await sendChannelDirect(this.node, replyTo, this.repositoryId, REALTIME_CHANNEL, {
          kind: 'move-result',
          moveId: String(frame.moveId ?? '').slice(0, 64),
          ...result,
        });
      } catch { /* the list refresh reports the truth regardless */ }
    };
    let from;
    let to;
    try {
      from = this.liveWorkspace.normalize(String(frame.fromPath ?? ''));
      to = this.liveWorkspace.normalize(String(frame.toPath ?? ''));
    } catch (error) {
      await respond({ ok: false, error: `Invalid path: ${error.message}` });
      return;
    }
    if (from === to) {
      await respond({ ok: true, unchanged: true });
      return;
    }
    const absoluteFrom = path.join(this.repository.root, ...from.split('/'));
    const absoluteTo = path.join(this.repository.root, ...to.split('/'));
    try {
      await mkdir(path.dirname(absoluteTo), { recursive: true });
      await rename(absoluteFrom, absoluteTo);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // This machine's copy has not synced yet; the overlay catches it up.
        await respond({ ok: true, deferred: true });
        return;
      }
      await respond({ ok: false, error: error.message });
      return;
    }
    // Any live document on the old path is orphaned by design: the document
    // identity is the path. Views reopen on the new one.
    for (const [documentId, state] of [...this.documents]) {
      if (state.path === from) {
        if (state.seedTimer) clearInterval(state.seedTimer);
        state.doc.destroy();
        this.documents.delete(documentId);
      }
    }
    this.onFileWritten?.(to);
    await respond({ ok: true });
  }

  /** Bring a tombstoned file back, on request from any browser. */
  async #restoreItem(peerId, frame) {
    const replyTo = typeof frame.replyTo === 'string' && /^[a-f0-9]{64}$/.test(frame.replyTo) ? frame.replyTo : peerId;
    const respond = async (result) => {
      try {
        await sendChannelDirect(this.node, replyTo, this.repositoryId, REALTIME_CHANNEL, {
          kind: 'restore-result',
          restoreId: String(frame.restoreId ?? '').slice(0, 64),
          ...result,
        });
      } catch { /* the refreshed list reports the truth */ }
    };
    try {
      const result = await this.liveWorkspace.restoreFromTrash(
        String(frame.path ?? ''),
        typeof frame.trashedAt === 'string' ? frame.trashedAt : null,
      );
      this.onFileWritten?.(result.restoredTo);
      await respond({ ok: true, restoredTo: result.restoredTo });
    } catch (error) {
      await respond({ ok: false, error: error.message });
    }
  }

  async filesystemChanged(input) {
    let file;
    try { file = this.liveWorkspace.normalize(input); } catch { return; }
    for (const state of this.documents.values()) {
      if (state.path !== file || state.writing || !state.seeded) continue;
      let content = '';
      try { content = await readFile(path.join(this.repository.root, ...file.split('/')), 'utf8'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      // The filesystem event for our own write arrives after `writing` has
      // already cleared. Treating it as an external edit pumped the file back
      // into the document, indefinitely.
      if (content === state.lastWritten) continue;
      const current = state.text.toString();
      if (content === current) { state.lastWritten = content; continue; }
      // The file bounced back to an OLDER version this watcher itself wrote —
      // an overlay straggler or a slow copy, not a person's edit. Treating
      // those echoes as edits deleted whatever had been typed since that
      // version, live, keystroke by keystroke. A watcher never mistakes its
      // own past for someone else's present.
      if (state.writeHistory.includes(createHash('sha256').update(content).digest('hex'))) {
        state.lastWritten = null;
        await this.#write(state);
        continue;
      }
      // A genuinely external edit. Diff FILE AGAINST FILE — the last content
      // this server knew the file to hold versus what it holds now — never
      // against the live document. The document already contains keystrokes
      // the file has not caught up to, and diffing against it computed
      // "delete whatever the file lacks": it deleted what the person was
      // typing, as they typed it. A file-to-file patch touches only the span
      // the external writer actually changed.
      const base = state.lastWritten ?? '';
      let prefix = 0;
      const shortest = Math.min(base.length, content.length);
      while (prefix < shortest && base[prefix] === content[prefix]) prefix += 1;
      let suffix = 0;
      while (suffix < shortest - prefix
        && base[base.length - 1 - suffix] === content[content.length - 1 - suffix]) suffix += 1;
      const deleteLength = Math.max(0, Math.min(base.length - prefix - suffix, state.text.length - prefix));
      const middle = content.slice(prefix, content.length - suffix);
      if (prefix > state.text.length) {
        // The document diverged past the patch anchor; append rather than lose
        // the external change entirely.
        state.doc.transact(() => { state.text.insert(state.text.length, middle); }, 'filesystem');
      } else {
        state.doc.transact(() => {
          if (deleteLength > 0) state.text.delete(prefix, deleteLength);
          if (middle) state.text.insert(prefix, middle);
        }, 'filesystem');
      }
      state.lastWritten = null;
      await this.#write(state);
    }
  }

  async #receiveFrame(peerId, frame) {
    if (!this.started) return;
    if (frame?.kind === 'move' && frame.repositoryId === this.repositoryId) {
      await this.#moveItem(peerId, frame).catch((error) => this.logger.debug?.(`Move: ${error.message}`));
      return;
    }
    if (frame?.kind === 'restore' && frame.repositoryId === this.repositoryId) {
      await this.#restoreItem(peerId, frame).catch((error) => this.logger.debug?.(`Restore: ${error.message}`));
      return;
    }
    if (!validFrame(frame, this.repositoryId)) return;
    let payload;
    try { payload = Buffer.from(frame.payload, 'base64'); } catch { return; }
    const complete = this.#assemble(peerId, frame, payload);
    if (!complete) return;
    await this.#receive(peerId, complete);
  }

  #assemble(peerId, frame, payload) {
    const now = Date.now();
    for (const [id, assembly] of this.assemblies) {
      if (now - assembly.updatedAt > ASSEMBLY_TTL_MS) this.assemblies.delete(id);
    }
    if (frame.total === 1) return { ...frame, payload };
    const id = `${peerId}:${frame.messageId}`;
    let assembly = this.assemblies.get(id);
    if (!assembly) {
      if (this.assemblies.size >= MAX_ASSEMBLIES) {
        const oldest = [...this.assemblies.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0];
        if (oldest) this.assemblies.delete(oldest);
      }
      assembly = { frame, parts: Array(frame.total).fill(null), received: 0, updatedAt: now };
      this.assemblies.set(id, assembly);
    }
    if (assembly.frame.documentId !== frame.documentId || assembly.frame.path !== frame.path
      || assembly.frame.revision !== frame.revision || assembly.frame.baseHash !== frame.baseHash
      || assembly.frame.kind !== frame.kind || assembly.parts.length !== frame.total) return null;
    assembly.updatedAt = now;
    if (!assembly.parts[frame.part]) {
      assembly.parts[frame.part] = payload;
      assembly.received += 1;
    }
    if (assembly.received !== assembly.parts.length) return null;
    this.assemblies.delete(id);
    return { ...assembly.frame, payload: Buffer.concat(assembly.parts) };
  }

  async #document(frame) {
    const normalized = this.liveWorkspace.normalize(frame.path);
    // One document per file per revision. The base hash used to be part of
    // the identity: every write to disk changed the file's hash, the next
    // browser opened a different document, and this server ended up hosting
    // two live docs fighting over one file — each pumping whole-file rewrites
    // into the other, stomping edits and duplicating content on every lap.
    const expectedDocumentId = createHash('sha256').update([
      'gitpigeon-realtime-v2',
      this.repositoryId,
      frame.revision,
      normalized,
    ].join('\0')).digest('hex');
    if (expectedDocumentId !== frame.documentId) return null;
    const existing = this.documents.get(frame.documentId);
    if (existing) return existing.path === normalized ? existing : null;
    const doc = new Y.Doc();
    const state = {
      doc,
      text: doc.getText('content'),
      path: normalized,
      revision: frame.revision,
      baseHash: frame.baseHash,
      writing: false,
      hydrated: true,
      seeded: true,
      seedTimer: null,
      lastWritten: null,
      writeHistory: [],
      lastActivityAt: Date.now(),
    };
    // Exactly one watcher seeds a new document: the smallest live device id
    // on this room. Every watcher seeding from its own file copy was the
    // duplication loop's last engine — the copies diverge while the overlay
    // lags, the seeds differ, and merging them unions the content, doubled
    // again on every restart. Everyone else opens empty, asks the mesh, and
    // adopts what the seeder answers; if the seeder never answers, seed from
    // the local file after a deadline rather than staying blank forever.
    const seedFromFile = async () => {
      let content = '';
      try { content = await readFile(path.join(this.repository.root, ...normalized.split('/')), 'utf8'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (content && state.text.length === 0) {
        const contentHash = createHash('sha256').update(content).digest('hex');
        const seed = new Y.Doc({ gc: false });
        seed.clientID = Number.parseInt(contentHash.slice(0, 8), 16) || 1;
        seed.getText('content').insert(0, content);
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), 'seed');
        seed.destroy();
      }
      state.lastWritten = content;
      // The content this document was born from is a known file state: its
      // echo must be recognized like any other.
      state.writeHistory.push(createHash('sha256').update(content).digest('hex'));
      state.seeded = true;
    };
    if (!this.#deferToPeerSeeder()) {
      await seedFromFile();
    } else {
      state.seeded = false;
      const startedAt = Date.now();
      const ask = () => {
        this.#send({ ...frame, kind: 'sync-request', payload: Y.encodeStateVector(doc) }).catch(() => {});
      };
      ask();
      state.seedTimer = setInterval(() => {
        if (state.seeded) {
          clearInterval(state.seedTimer);
          state.seedTimer = null;
          return;
        }
        if (Date.now() - startedAt >= SEED_FALLBACK_MS) {
          clearInterval(state.seedTimer);
          state.seedTimer = null;
          seedFromFile().catch((error) => this.logger.debug?.(`Realtime seed fallback: ${error.message}`));
          return;
        }
        ask();
      }, SEED_RETRY_MS);
      state.seedTimer.unref?.();
    }
    doc.on('update', (update, origin) => {
      if (origin === 'remote' || origin === 'seed') return;
      this.#send({ ...frame, kind: 'update', payload: update }).catch(() => {});
    });
    this.documents.set(frame.documentId, state);
    return state;
  }

  async #receive(peerId, frame) {
    const state = await this.#document(frame);
    if (!state) return;
    state.lastActivityAt = Date.now();
    if (frame.kind === 'sync-request') {
      // A document still waiting to adopt the seeder's content has nothing
      // authoritative to answer with.
      if (!state.seeded) return;
      await this.#send({ ...frame, kind: 'sync-response', payload: Y.encodeStateAsUpdate(state.doc, frame.payload) }, peerId);
      return;
    }
    // Apply and persist — nothing more. This used to also re-broadcast the
    // update to everyone and fire a full-state response back at the sender
    // after every keystroke batch: gossip already delivers broadcasts to the
    // room, so all of it was amplification that raced the next keystroke.
    Y.applyUpdate(state.doc, frame.payload, 'remote');
    if (!state.seeded && state.text.length > 0) {
      // The elected seeder answered; its content is this document's base.
      state.seeded = true;
      if (state.seedTimer) {
        clearInterval(state.seedTimer);
        state.seedTimer = null;
      }
    }
    if (!state.seeded) return;
    await this.#write(state);
  }

  async #write(state) {
    if (this.repository.bare) return;
    const absolute = path.join(this.repository.root, ...state.path.split('/'));
    const data = Buffer.from(state.text.toString());
    state.writing = true;
    try {
      if (data.length === 0) {
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, data);
      } else {
        await mkdir(path.dirname(absolute), { recursive: true });
        const temporary = `${absolute}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
        try {
          await writeFile(temporary, data);
          await rename(temporary, absolute);
        } catch (error) {
          // A failed write must not litter the repository with orphaned
          // temp files — and must say WHY it failed, loudly: seventy silent
          // orphans meant seventy swallowed errors.
          await rm(temporary, { force: true }).catch(() => {});
          this.lastWriteError = `${state.path}: ${error.message}`.slice(0, 160);
          this.logger.info?.(`Repository write failed: ${this.lastWriteError}`);
          throw error;
        }
      }
      this.lastWriteError = null;
      state.lastWritten = data.toString('utf8');
      state.writeHistory.push(createHash('sha256').update(state.lastWritten).digest('hex'));
      if (state.writeHistory.length > 30) state.writeHistory.shift();
      this.onFileWritten?.(state.path);
    } finally {
      state.writing = false;
    }
  }

  async #requestAll(peerId) {
    if (!peerId) return;
    for (const [documentId, state] of this.documents) {
      await this.#send({
        documentId,
        path: state.path,
        revision: state.revision,
        baseHash: state.baseHash,
        kind: 'sync-request',
        payload: Y.encodeStateVector(state.doc),
      }, peerId);
    }
  }

  async #send(message, peerId = null) {
    const payload = Buffer.from(message.payload);
    const total = Math.max(1, Math.ceil(payload.length / CHUNK_BYTES));
    const messageId = randomBytes(16).toString('hex');
    for (let part = 0; part < total; part += 1) {
      const frame = {
        documentId: message.documentId,
        path: message.path,
        revision: message.revision,
        baseHash: message.baseHash,
        messageId,
        kind: message.kind,
        part,
        total,
        payload: payload.subarray(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES).toString('base64'),
      };
      if (peerId) {
        await sendChannelDirect(this.node, peerId, this.repositoryId, REALTIME_CHANNEL, frame);
        continue;
      }
      await broadcastChannel(this.node, this.repositoryId, REALTIME_CHANNEL, frame);
    }
  }
}
