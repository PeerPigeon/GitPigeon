import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// PeerPigeon Storage persists through IndexedDB and silently falls back to an
// in-memory driver when `indexedDB` is undefined, which is always true in Node.
// A memory-backed watcher restarts every record at version 1, so browsers that
// kept the previous version in their own IndexedDB reject every write the
// restarted watcher makes. Rather than reimplementing storage, GitPigeon gives
// Node the one global PeerPigeon already looks for.
//
// `frozen` records are immutable, content-addressed snapshot chunks that
// GitPigeon already keeps in `.git/gitpigeon/chunks` and re-seeds on start, so
// they stay in memory here instead of being written to disk a second time.
const EPHEMERAL_SPACES = new Set(['frozen']);
const FLUSH_DEBOUNCE_MS = 200;

function fireAsync(callback, ...args) {
  if (typeof callback !== 'function') return;
  queueMicrotask(() => callback(...args));
}

function databaseFile(root, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'peerpigeon';
  return path.join(root, `${safe}.json`);
}

class PersistentStore {
  constructor(file, records) {
    this.file = file;
    this.records = records;
    this.flushTimer = null;
    this.flushing = null;
    this.dirty = false;
    this.closed = false;
  }

  static async open(file) {
    const records = new Map();
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (Array.isArray(parsed?.records)) {
        for (const record of parsed.records) {
          if (record && typeof record.pk === 'string') records.set(record.pk, record);
        }
      }
    } catch (error) {
      // A missing or truncated file is equivalent to an empty database. The
      // mesh re-supplies whatever the watcher no longer remembers.
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return new PersistentStore(file, records);
  }

  get(pk) {
    return this.records.get(pk) ?? null;
  }

  put(record) {
    this.records.set(record.pk, record);
    if (!EPHEMERAL_SPACES.has(record.space)) this.schedule();
  }

  delete(pk) {
    const record = this.records.get(pk);
    if (!this.records.delete(pk)) return;
    if (!record || !EPHEMERAL_SPACES.has(record.space)) this.schedule();
  }

  listBySpace(space) {
    const values = [];
    for (const record of this.records.values()) {
      if (record.space === space) values.push(record);
    }
    return values.sort((left, right) => String(left.key).localeCompare(String(right.key)));
  }

  schedule() {
    this.dirty = true;
    if (this.closed || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => { /* the next mutation retries */ });
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  async flush() {
    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) return;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const durable = [...this.records.values()].filter((record) => !EPHEMERAL_SPACES.has(record.space));
    const operation = (async () => {
      const temporary = `${this.file}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, records: durable })}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    })();
    this.flushing = operation.finally(() => {
      if (this.flushing === operation) this.flushing = null;
    });
    await this.flushing;
  }

  async close() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.closed = true;
    await this.flush();
  }
}

const stores = new Map();

async function openStore(root, name) {
  const file = databaseFile(root, name);
  let pending = stores.get(file);
  if (!pending) {
    pending = PersistentStore.open(file);
    stores.set(file, pending);
  }
  return await pending;
}

/** Flush every open database. Used by tests and by watcher shutdown. */
export async function flushNativeStorage() {
  for (const pending of stores.values()) {
    const store = await pending;
    await store.flush();
  }
}

class ShimObjectStore {
  constructor(transaction, store) {
    this.transaction = transaction;
    this.store = store;
  }

  createIndex() {
    // The record shape is already indexed by `listBySpace`; PeerPigeon only
    // declares the index so that `index('space').getAll(space)` resolves.
    return { name: 'space' };
  }

  index(name) {
    if (name !== 'space') throw new Error(`Unsupported GitPigeon storage index: ${name}`);
    return {
      getAll: (space) => this.transaction.enqueue(() => this.store.listBySpace(space)),
    };
  }

  get(pk) {
    return this.transaction.enqueue(() => this.store.get(pk) ?? undefined);
  }

  put(record) {
    return this.transaction.enqueue(() => {
      this.store.put(record);
      return record.pk;
    });
  }

  delete(pk) {
    return this.transaction.enqueue(() => {
      this.store.delete(pk);
      return undefined;
    });
  }
}

class ShimTransaction {
  constructor(store, storeName) {
    this.store = store;
    this.storeName = storeName;
    this.pending = 0;
    this.failed = false;
    this.settled = false;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
  }

  objectStore() {
    // GitPigeon opens exactly one PeerPigeon object store per database, so the
    // shim keeps a single record map instead of namespacing by store name.
    return new ShimObjectStore(this, this.store);
  }

  enqueue(operation) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending += 1;
    queueMicrotask(() => {
      try {
        request.result = operation();
        fireAsync(request.onsuccess, { target: request });
      } catch (error) {
        this.failed = true;
        this.error = error;
        request.error = error;
        fireAsync(request.onerror, { target: request });
        fireAsync(this.onerror, { target: this });
      } finally {
        this.pending -= 1;
        queueMicrotask(() => this.settle());
      }
    });
    return request;
  }

  settle() {
    if (this.pending > 0 || this.settled) return;
    this.settled = true;
    if (!this.failed) fireAsync(this.oncomplete, { target: this });
  }
}

class ShimDatabase {
  constructor(store, storeName) {
    this.store = store;
    this.storeName = storeName;
    this.objectStoreNames = {
      contains: (name) => name === storeName,
    };
  }

  createObjectStore(name) {
    this.storeName = name;
    this.objectStoreNames = { contains: (value) => value === name };
    return new ShimObjectStore(new ShimTransaction(this.store, name), this.store);
  }

  transaction() {
    return new ShimTransaction(this.store, this.storeName);
  }

  close() {
    this.store.flush().catch(() => { /* the process is exiting */ });
  }
}

let installation = null;

/**
 * Install a durable `indexedDB` for PeerPigeon Storage in Node so that record
 * versions, presence, and repository heads survive a watcher restart.
 */
export async function installNativeStorage(root) {
  if (typeof globalThis.indexedDB !== 'undefined') return;
  if (installation) return await installation;
  installation = (async () => {
    const directory = path.join(root, 'storage');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    globalThis.indexedDB = {
      open(name) {
        const request = {
          result: null,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        openStore(directory, name).then((store) => {
          const database = new ShimDatabase(store, null);
          request.result = database;
          // A fresh process always needs the object store declared, exactly as
          // a first-time IndexedDB open would.
          fireAsync(request.onupgradeneeded, { target: request });
          fireAsync(request.onsuccess, { target: request });
        }).catch((error) => {
          request.error = error;
          fireAsync(request.onerror, { target: request });
        });
        return request;
      },
    };
  })();
  try {
    await installation;
  } catch (error) {
    installation = null;
    globalThis.indexedDB = undefined;
    throw error;
  }
}
