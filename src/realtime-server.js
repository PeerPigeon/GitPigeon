import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

export class RealtimeWorkspaceServer {
  constructor({ node, repository, secret, repositoryId, logger = {}, onFileWritten = null }) {
    this.node = node;
    this.repository = repository;
    this.secret = secret;
    this.repositoryId = repositoryId;
    this.logger = logger;
    this.onFileWritten = onFileWritten;
    this.liveWorkspace = new LiveWorkspace(repository);
    this.documents = new Map();
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
      this.#receiveFrame(peerId, frame).catch((error) => this.logger.debug?.(`Realtime workspace: ${error.message}`));
    });
    this.node.on('peerConnected', this.onPeer);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.node.off('peerConnected', this.onPeer);
    for (const state of this.documents.values()) state.doc.destroy();
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

  async filesystemChanged(input) {
    let file;
    try { file = this.liveWorkspace.normalize(input); } catch { return; }
    for (const state of this.documents.values()) {
      if (state.path !== file || state.writing) continue;
      let content = '';
      try { content = await readFile(path.join(this.repository.root, ...file.split('/')), 'utf8'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      // The filesystem event for our own write arrives after `writing` has
      // already cleared. Treating it as an external edit pumped the file back
      // into the document as delete-everything-reinsert-everything, which
      // stomped concurrent edits and duplicated them — then the write of that
      // merge triggered the next event, indefinitely.
      if (content === state.lastWritten) continue;
      const current = state.text.toString();
      if (content === current) { state.lastWritten = content; continue; }
      // A genuinely external edit (another editor touched the file). Apply the
      // smallest replacement, not a whole-file rewrite: concurrent inserts
      // outside the changed span survive untouched.
      let prefix = 0;
      const shortest = Math.min(current.length, content.length);
      while (prefix < shortest && current[prefix] === content[prefix]) prefix += 1;
      let suffix = 0;
      while (suffix < shortest - prefix
        && current[current.length - 1 - suffix] === content[content.length - 1 - suffix]) suffix += 1;
      state.doc.transact(() => {
        state.text.delete(prefix, current.length - prefix - suffix);
        const middle = content.slice(prefix, content.length - suffix);
        if (middle) state.text.insert(prefix, middle);
      }, 'filesystem');
      state.lastWritten = null;
      await this.#write(state);
    }
  }

  async #receiveFrame(peerId, frame) {
    if (!this.started || !validFrame(frame, this.repositoryId)) return;
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
      lastWritten: null,
      lastActivityAt: Date.now(),
    };
    // The watcher is the seeding authority: a new document starts as the
    // file's current content, seeded deterministically (the client id derives
    // from the content) so two watchers seeding the same file converge on
    // identical operations instead of duplicating it.
    let content = '';
    try { content = await readFile(path.join(this.repository.root, ...normalized.split('/')), 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (content) {
      const contentHash = createHash('sha256').update(content).digest('hex');
      const seed = new Y.Doc({ gc: false });
      seed.clientID = Number.parseInt(contentHash.slice(0, 8), 16) || 1;
      seed.getText('content').insert(0, content);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), 'seed');
      seed.destroy();
    }
    state.lastWritten = content;
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
      await this.#send({ ...frame, kind: 'sync-response', payload: Y.encodeStateAsUpdate(state.doc, frame.payload) }, peerId);
      return;
    }
    // Apply and persist — nothing more. This used to also re-broadcast the
    // update to everyone and fire a full-state response back at the sender
    // after every keystroke batch: gossip already delivers broadcasts to the
    // room, so all of it was amplification that raced the next keystroke.
    Y.applyUpdate(state.doc, frame.payload, 'remote');
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
        await writeFile(temporary, data);
        await rename(temporary, absolute);
      }
      state.lastWritten = data.toString('utf8');
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
