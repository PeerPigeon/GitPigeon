import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { LiveWorkspace } from './live-workspace.js';

export const REALTIME_PROTOCOL = 'gitpigeon/realtime/1';
export const REALTIME_ENVELOPE_PROTOCOL = 'gitpigeon/realtime-envelope/1';
const DIGEST = /^[a-f0-9]{64}$/;
const MESSAGE_ID = /^[a-f0-9]{32}$/;
const CHUNK_BYTES = 24 * 1024;
const MAX_PARTS = 512;
const MAX_ASSEMBLIES = 64;
const ASSEMBLY_TTL_MS = 30_000;

function keyFor(secret) {
  return createHash('sha256').update('gitpigeon:realtime:v1\0').update(String(secret)).digest();
}

function aad(repositoryId) {
  return Buffer.from(`${REALTIME_ENVELOPE_PROTOCOL}\0${repositoryId}`);
}

export function encryptRealtimeFrame(secret, repositoryId, frame) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  cipher.setAAD(aad(repositoryId));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(frame))), cipher.final()]);
  return {
    protocol: REALTIME_ENVELOPE_PROTOCOL,
    repositoryId,
    ciphertext: Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64'),
  };
}

export function decryptRealtimeFrame(secret, repositoryId, envelope) {
  if (!envelope || envelope.protocol !== REALTIME_ENVELOPE_PROTOCOL
    || envelope.repositoryId !== repositoryId || typeof envelope.ciphertext !== 'string'
    || envelope.ciphertext.length > 90_000) return null;
  let encrypted;
  try { encrypted = Buffer.from(envelope.ciphertext, 'base64'); } catch { return null; }
  if (encrypted.length <= 28) return null;
  const tagStart = encrypted.length - 16;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), encrypted.subarray(0, 12));
    decipher.setAAD(aad(repositoryId));
    decipher.setAuthTag(encrypted.subarray(tagStart));
    return JSON.parse(Buffer.concat([
      decipher.update(encrypted.subarray(12, tagStart)),
      decipher.final(),
    ]).toString('utf8'));
  } catch {
    return null;
  }
}

function validFrame(frame, repositoryId) {
  return frame && frame.protocol === REALTIME_PROTOCOL && frame.repositoryId === repositoryId
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
    this.onMessage = (message) => { this.#receiveEnvelope(message).catch((error) => logger.debug?.(`Realtime workspace: ${error.message}`)); };
    this.onPeer = (peerId) => { this.#requestAll(String(peerId ?? '')).catch(() => {}); };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.liveWorkspace.init();
    this.node.on('message', this.onMessage);
    this.node.on('peerConnected', this.onPeer);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.node.off('message', this.onMessage);
    this.node.off('peerConnected', this.onPeer);
    for (const state of this.documents.values()) state.doc.destroy();
    this.documents.clear();
    this.assemblies.clear();
  }

  async filesystemChanged(input) {
    let file;
    try { file = this.liveWorkspace.normalize(input); } catch { return; }
    for (const state of this.documents.values()) {
      if (state.path !== file || state.writing || !state.hydrated) continue;
      let content = '';
      try { content = await readFile(path.join(this.repository.root, ...file.split('/')), 'utf8'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (content === state.text.toString()) continue;
      state.doc.transact(() => {
        state.text.delete(0, state.text.length);
        if (content) state.text.insert(0, content);
      }, 'filesystem');
    }
  }

  async #receiveEnvelope(message) {
    if (!this.started || message?.local || !message?.fromPeerId) return;
    const frame = decryptRealtimeFrame(this.secret, this.repositoryId, message.data);
    if (!validFrame(frame, this.repositoryId)) return;
    let payload;
    try { payload = Buffer.from(frame.payload, 'base64'); } catch { return; }
    const complete = this.#assemble(String(message.fromPeerId), frame, payload);
    if (!complete) return;
    await this.#receive(String(message.fromPeerId), complete);
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
    const expectedDocumentId = createHash('sha256').update([
      'gitpigeon-realtime-v1',
      this.repositoryId,
      frame.revision,
      normalized,
      frame.baseHash,
    ].join('\0')).digest('hex');
    if (expectedDocumentId !== frame.documentId) return null;
    const existing = this.documents.get(frame.documentId);
    if (existing) return existing.path === normalized && existing.baseHash === frame.baseHash ? existing : null;
    const doc = new Y.Doc();
    const state = {
      doc,
      text: doc.getText('content'),
      path: normalized,
      revision: frame.revision,
      baseHash: frame.baseHash,
      writing: false,
      hydrated: false,
    };
    doc.on('update', (update, origin) => {
      if (origin === 'remote') return;
      this.#send({ ...frame, kind: 'update', payload: update }).catch(() => {});
    });
    this.documents.set(frame.documentId, state);
    return state;
  }

  async #receive(peerId, frame) {
    const state = await this.#document(frame);
    if (!state) return;
    if (frame.kind === 'sync-request') {
      await this.#send({ ...frame, kind: 'sync-response', payload: Y.encodeStateAsUpdate(state.doc, frame.payload) }, peerId);
      if (state.text.length === 0) {
        await this.#send({ ...frame, kind: 'sync-request', payload: Y.encodeStateVector(state.doc) }, peerId);
      }
      return;
    }
    Y.applyUpdate(state.doc, frame.payload, 'remote');
    if (frame.kind !== 'sync-response' && !state.hydrated) {
      await this.#send({ ...frame, kind: 'sync-request', payload: Y.encodeStateVector(state.doc) }, peerId);
      return;
    }
    state.hydrated = true;
    await this.#write(state);
    await this.#send({ ...frame, kind: 'sync-response', payload: Y.encodeStateAsUpdate(state.doc) }, peerId);
    await this.#send({ ...frame, kind: 'update', payload: frame.payload });
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
        protocol: REALTIME_PROTOCOL,
        repositoryId: this.repositoryId,
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
      const envelope = encryptRealtimeFrame(this.secret, this.repositoryId, frame);
      if (peerId && this.node.sendDirect(peerId, envelope)) continue;
      this.node.broadcast(envelope, { protocol: REALTIME_ENVELOPE_PROTOCOL });
    }
  }
}
