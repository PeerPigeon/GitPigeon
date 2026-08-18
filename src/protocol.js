import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_RETRIEVE_TIMEOUT_MS,
  PROTOCOL,
  chunkKey,
  headKey,
  manifestKey,
  registryKey,
  storagePrefix,
} from './constants.js';
import { RepositoryCache } from './cache.js';
import { WorkspaceFiles, workspaceDigest } from './workspace.js';

const DIGEST = /^[a-f0-9]{64}$/;
const DEVICE = /^[a-zA-Z0-9_-]{8,128}$/;
const noop = () => {};

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function snapshotDigest(bundleSha256, filesDigest) {
  return digest(`gitpigeon-snapshot-v1\0${bundleSha256 ?? '-'}\0${filesDigest}`);
}

function contentDigest(refsDigest, filesDigest) {
  return digest(`gitpigeon-content-v1\0${refsDigest ?? '-'}\0${filesDigest}`);
}

export class RepositorySynchronizer {
  constructor({
    repository,
    storage,
    config,
    cache = new RepositoryCache(repository.gitDir),
    workspace = new WorkspaceFiles(repository, cache),
    logger = {},
    chunkSize = DEFAULT_CHUNK_SIZE,
    retrieveTimeoutMs = DEFAULT_RETRIEVE_TIMEOUT_MS,
  }) {
    this.repository = repository;
    this.storage = storage;
    this.config = config;
    this.cache = cache;
    this.cache.setEncryptionSecret?.(config.secret);
    this.workspace = workspace;
    this.chunkSize = chunkSize;
    this.retrieveTimeoutMs = retrieveTimeoutMs;
    this.logger = {
      info: logger.info ?? noop,
      warn: logger.warn ?? noop,
      error: logger.error ?? noop,
      debug: logger.debug ?? noop,
    };
    this.devices = new Set([config.deviceId]);
    this.registryDevices = [];
    this.state = { heads: {}, imported: {}, fileBaselines: {} };
    this.unsubscribe = [];
    this.subscribedHeads = new Set();
    this.started = false;
    this.work = Promise.resolve();
    this.lastResult = { updated: [], conflicts: [], updatedFiles: [], fileConflicts: [] };
  }

  async start({ publish = true } = {}) {
    if (this.started) return;
    this.started = true;
    try {
      await this.cache.init();
      if (!this.repository.bare) await this.workspace.init();
      this.state = this.#normalizeState(await this.cache.loadState());
      for (const deviceId of Object.keys(this.state.heads)) {
        if (DEVICE.test(deviceId)) this.devices.add(deviceId);
      }

      this.unsubscribe.push(this.storage.subscribeKey('public', registryKey(this.config.repositoryId)));
      this.unsubscribe.push(this.storage.subscribe((event) => this.#onStorageChange(event)));

      await this.#rehydrateCurrentSnapshots();
      const registry = await this.storage.retrieve(
        'public',
        registryKey(this.config.repositoryId),
        { timeoutMs: this.retrieveTimeoutMs },
      );
      await this.#acceptRegistry(registry?.value, true);
      await this.#publishRegistryIfNeeded();
      await this.#refreshKnownHeads();
      if (publish) await this.publishLocal();
      await this.waitForIdle();
    } catch (error) {
      for (const unsubscribe of this.unsubscribe.splice(0)) {
        try { unsubscribe?.(); } catch { /* best effort */ }
      }
      this.started = false;
      throw error;
    }
  }

  async stop() {
    await this.waitForIdle();
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      try { unsubscribe?.(); } catch { /* best effort */ }
    }
    this.started = false;
  }

  async waitForIdle() {
    await this.work;
  }

  async refresh() {
    const registry = await this.storage.retrieve(
      'public',
      registryKey(this.config.repositoryId),
      { timeoutMs: this.retrieveTimeoutMs },
    );
    await this.#acceptRegistry(registry?.value, true);
    await this.#refreshKnownHeads();
    await this.waitForIdle();
    return this.lastResult;
  }

  async publishLocal({ force = false } = {}) {
    const refsDigest = await this.repository.refsDigest();
    const workspace = await this.workspace.snapshot();
    if (!refsDigest && workspace.files.length === 0) {
      this.logger.debug('No Git refs or private workspace files to publish yet');
      return null;
    }
    const currentContentDigest = contentDigest(refsDigest, workspace.digest);
    const previous = this.state.heads[this.config.deviceId];
    if (!force && previous?.contentDigest === currentContentDigest) return previous;

    const bundle = await this.repository.createBundle();
    try {
      const bundleData = bundle?.data ?? Buffer.alloc(0);
      const bundleSha256 = bundle ? digest(bundleData) : null;
      const chunks = await this.#cacheChunks(bundleData);
      const files = [];
      for (const file of workspace.files) {
        files.push({
          path: file.path,
          deleted: file.deleted,
          size: file.size,
          sha256: file.sha256,
          chunks: file.deleted ? [] : await this.#cacheChunks(file.data),
        });
      }
      const snapshotId = snapshotDigest(bundleSha256, workspace.digest);
      const manifest = {
        protocol: PROTOCOL,
        repositoryId: this.config.repositoryId,
        snapshotId,
        deviceId: this.config.deviceId,
        createdAt: new Date().toISOString(),
        bundleSize: bundleData.length,
        bundleSha256,
        refsDigest,
        refs: bundle?.refs ?? [],
        chunks,
        workspaceDigest: workspace.digest,
        files,
      };
      await this.cache.writeManifest(manifest);
      await this.#seedManifest(manifest);

      const head = {
        protocol: PROTOCOL,
        repositoryId: this.config.repositoryId,
        deviceId: this.config.deviceId,
        snapshotId,
        refsDigest,
        contentDigest: currentContentDigest,
        updatedAt: new Date().toISOString(),
      };
      await this.storage.put('public', headKey(this.config.repositoryId, this.config.deviceId), head);
      this.state.heads[this.config.deviceId] = head;
      await this.cache.saveState(this.state);
      this.logger.info(
        `Published ${bundle?.refs.length ?? 0} refs and ${files.length} private files (${snapshotId.slice(0, 12)})`,
      );
      return head;
    } finally {
      await bundle?.dispose();
    }
  }

  async localDigest() {
    const refsDigest = await this.repository.refsDigest();
    const workspace = await this.workspace.snapshot();
    if (!refsDigest && workspace.files.length === 0) return null;
    return contentDigest(refsDigest, workspace.digest);
  }

  async status() {
    return {
      repositoryId: this.config.repositoryId,
      deviceId: this.config.deviceId,
      devices: sortedUnique(this.devices),
      heads: { ...this.state.heads },
      imported: { ...this.state.imported },
      trackedFiles: await this.workspace.list(),
      lastResult: this.lastResult,
    };
  }

  #enqueue(task) {
    this.work = this.work.then(task, task).catch((error) => {
      this.logger.error(error);
    });
    return this.work;
  }

  #onStorageChange(event) {
    if (!event || event.origin !== 'remote' || event.op !== 'upsert' || !event.record) return;
    const registry = registryKey(this.config.repositoryId);
    if (event.space === 'public' && event.key === registry) {
      this.#enqueue(async () => {
        await this.#acceptRegistry(event.record.value, true);
      });
      return;
    }
    const prefix = `${storagePrefix(this.config.repositoryId)}/head/`;
    if (event.space === 'public' && event.key.startsWith(prefix)) {
      this.#enqueue(async () => {
        await this.#acceptHead(event.record.value);
      });
    }
  }

  async #acceptRegistry(value, republish) {
    const remote = this.#validateRegistry(value);
    const previousDevices = new Set(this.devices);
    if (remote) {
      this.registryDevices = remote.devices;
      for (const deviceId of remote.devices) this.devices.add(deviceId);
    }
    this.devices.add(this.config.deviceId);
    await this.#subscribeKnownHeads();
    if (republish) await this.#publishRegistryIfNeeded();
    const addedDevices = sortedUnique(this.devices).filter(
      (deviceId) => deviceId !== this.config.deviceId && !previousDevices.has(deviceId),
    );
    for (const deviceId of addedDevices) await this.#refreshHead(deviceId);
  }

  async #publishRegistryIfNeeded() {
    const devices = sortedUnique(this.devices);
    if (sameStrings(devices, this.registryDevices)) return;
    const value = {
      protocol: PROTOCOL,
      repositoryId: this.config.repositoryId,
      devices,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.put('public', registryKey(this.config.repositoryId), value);
    this.registryDevices = devices;
  }

  async #subscribeKnownHeads() {
    for (const deviceId of sortedUnique(this.devices)) {
      if (this.subscribedHeads.has(deviceId)) continue;
      this.subscribedHeads.add(deviceId);
      this.unsubscribe.push(this.storage.subscribeKey('public', headKey(this.config.repositoryId, deviceId)));
    }
  }

  async #refreshKnownHeads() {
    await this.#subscribeKnownHeads();
    await this.#reconcileOwnHead();
    for (const deviceId of sortedUnique(this.devices)) {
      if (deviceId === this.config.deviceId) continue;
      await this.#refreshHead(deviceId);
    }
  }

  async #refreshHead(deviceId) {
    const record = await this.storage.retrieve(
      'public',
      headKey(this.config.repositoryId, deviceId),
      { timeoutMs: this.retrieveTimeoutMs },
    );
    if (record?.value) await this.#acceptHead(record.value);
  }

  async #reconcileOwnHead() {
    const key = headKey(this.config.repositoryId, this.config.deviceId);
    const desired = this.#validateHead(this.state.heads[this.config.deviceId]);
    const record = await this.storage.retrieve(
      'public',
      key,
      { timeoutMs: this.retrieveTimeoutMs },
    );
    const observed = this.#validateHead(record?.value);
    if (!desired) {
      if (observed) {
        this.state.heads[this.config.deviceId] = observed;
        await this.cache.saveState(this.state);
      }
      return;
    }
    if (!observed || observed.snapshotId !== desired.snapshotId) {
      // PeerPigeon's Node storage is memory-backed. Retrieving first imports the
      // highest mesh version; this write then advances it while preserving the
      // locally cached Git head across process restarts.
      await this.storage.put('public', key, desired);
    }
  }

  async #acceptHead(value) {
    const head = this.#validateHead(value);
    if (!head) return;
    this.devices.add(head.deviceId);
    if (head.deviceId === this.config.deviceId) {
      const desired = this.#validateHead(this.state.heads[this.config.deviceId]);
      if (desired && desired.snapshotId !== head.snapshotId) {
        await this.storage.put(
          'public',
          headKey(this.config.repositoryId, this.config.deviceId),
          desired,
        );
        return;
      }
    }
    this.state.heads[head.deviceId] = head;
    await this.cache.saveState(this.state);
    if (head.deviceId === this.config.deviceId) return;
    if (this.state.imported[head.deviceId] === head.snapshotId) return;

    const manifest = await this.#retrieveManifest(head.snapshotId);
    if (!manifest) {
      this.logger.warn(`Snapshot ${head.snapshotId.slice(0, 12)} is not currently available; a source device must be online`);
      return;
    }
    let temporary = null;
    try {
      let gitResult = { updated: [], conflicts: [], remoteRefs: [] };
      if (manifest.bundleSize > 0) {
        temporary = await mkdtemp(path.join(tmpdir(), 'gitpigeon-import-'));
        const bundleFile = path.join(temporary, 'repository.bundle');
        const data = await this.#retrieveBundle(manifest);
        await writeFile(bundleFile, data);
        gitResult = await this.repository.importBundle(bundleFile, head.deviceId);
      }
      const privateFiles = await this.#retrieveWorkspaceFiles(manifest);
      const fileResult = await this.workspace.apply(
        privateFiles,
        this.state.fileBaselines,
        head.deviceId,
      );
      const result = {
        ...gitResult,
        conflicts: [...gitResult.conflicts, ...fileResult.conflicts],
        updatedFiles: fileResult.updated,
        fileConflicts: fileResult.conflicts,
      };
      this.state.imported[head.deviceId] = head.snapshotId;
      await this.cache.saveState(this.state);
      this.lastResult = result;
      if (result.updated.length > 0) {
        this.logger.info(`Imported ${head.deviceId.slice(0, 8)}: ${result.updated.join(', ')}`);
      }
      if (result.updatedFiles.length > 0) {
        this.logger.info(`Restored private files: ${result.updatedFiles.join(', ')}`);
      }
      for (const conflict of result.conflicts) {
        if (conflict.branch) {
          this.logger.warn(
            `Branch ${conflict.branch} ${conflict.reason}; merge ${conflict.remoteRef} when ready`,
          );
        } else {
          this.logger.warn(`Private file ${conflict.path} ${conflict.reason}; incoming copy saved at ${conflict.conflictFile}`);
        }
      }
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  async #retrieveManifest(snapshotId) {
    const cached = await this.cache.readManifest(snapshotId);
    if (cached) return this.#validateManifest(cached);
    const record = await this.storage.retrieve(
      'frozen',
      manifestKey(this.config.repositoryId, snapshotId),
      { timeoutMs: this.retrieveTimeoutMs },
    );
    const manifest = this.#validateManifest(record?.value, snapshotId);
    if (!manifest) return null;
    await this.cache.writeManifest(manifest);
    return manifest;
  }

  async #retrieveBundle(manifest) {
    const chunks = [];
    let size = 0;
    for (const chunk of manifest.chunks) {
      let data = null;
      if (await this.cache.hasChunk(chunk.sha256)) {
        data = await this.cache.readChunk(chunk.sha256);
      } else {
        const record = await this.storage.retrieve(
          'frozen',
          chunkKey(this.config.repositoryId, chunk.sha256),
          { timeoutMs: this.retrieveTimeoutMs },
        );
        data = this.#decodeChunk(record?.value, chunk);
        if (!data) throw new Error(`Chunk ${chunk.sha256} is not currently available`);
        await this.cache.writeChunk(chunk.sha256, data);
      }
      if (data.length !== chunk.size || digest(data) !== chunk.sha256) {
        throw new Error(`Corrupt cached chunk ${chunk.sha256}`);
      }
      chunks.push(data);
      size += data.length;
    }
    if (size !== manifest.bundleSize) throw new Error('Snapshot bundle size does not match its manifest');
    const bundle = Buffer.concat(chunks, size);
    if (digest(bundle) !== manifest.bundleSha256) throw new Error('Snapshot bundle digest does not match its manifest');
    return bundle;
  }

  async #retrieveWorkspaceFiles(manifest) {
    const files = [];
    for (const file of manifest.files) {
      if (file.deleted) {
        files.push({ ...file, data: null });
        continue;
      }
      const data = await this.#retrieveChunks(file.chunks, file.size, file.sha256, `Private file ${file.path}`);
      files.push({ ...file, data });
    }
    return files;
  }

  async #retrieveChunks(chunks, expectedSize, expectedDigest, label) {
    const values = [];
    let size = 0;
    for (const chunk of chunks) {
      let data;
      if (await this.cache.hasChunk(chunk.sha256)) {
        data = await this.cache.readChunk(chunk.sha256);
      } else {
        const record = await this.storage.retrieve(
          'frozen',
          chunkKey(this.config.repositoryId, chunk.sha256),
          { timeoutMs: this.retrieveTimeoutMs },
        );
        data = this.#decodeChunk(record?.value, chunk);
        if (!data) throw new Error(`Chunk ${chunk.sha256} is not currently available`);
        await this.cache.writeChunk(chunk.sha256, data);
      }
      if (data.length !== chunk.size || digest(data) !== chunk.sha256) {
        throw new Error(`Corrupt cached chunk ${chunk.sha256}`);
      }
      values.push(data);
      size += data.length;
    }
    if (size !== expectedSize) throw new Error(`${label} size does not match its manifest`);
    const data = Buffer.concat(values, size);
    if (digest(data) !== expectedDigest) throw new Error(`${label} digest does not match its manifest`);
    return data;
  }

  async #cacheChunks(data) {
    const chunks = [];
    for (let offset = 0; offset < data.length; offset += this.chunkSize) {
      const value = data.subarray(offset, Math.min(offset + this.chunkSize, data.length));
      const sha256 = digest(value);
      await this.cache.writeChunk(sha256, value);
      chunks.push({ sha256, size: value.length });
    }
    return chunks;
  }

  async #seedManifest(manifest) {
    const descriptors = [
      ...manifest.chunks,
      ...manifest.files.flatMap((file) => file.chunks),
    ];
    const uniqueChunks = new Map(descriptors.map((chunk) => [chunk.sha256, chunk]));
    for (const chunk of uniqueChunks.values()) {
      const key = chunkKey(this.config.repositoryId, chunk.sha256);
      if (!await this.storage.get('frozen', key)) {
        const data = await this.cache.readChunk(chunk.sha256);
        await this.storage.put('frozen', key, {
          protocol: PROTOCOL,
          kind: 'chunk',
          sha256: chunk.sha256,
          size: chunk.size,
          encoding: 'base64',
          data: data.toString('base64'),
        });
      }
    }
    const key = manifestKey(this.config.repositoryId, manifest.snapshotId);
    if (!await this.storage.get('frozen', key)) {
      await this.storage.put('frozen', key, manifest);
    }
  }

  async #rehydrateCurrentSnapshots() {
    const snapshots = sortedUnique(Object.values(this.state.heads).map((head) => head?.snapshotId).filter(Boolean));
    for (const snapshotId of snapshots) {
      const manifest = await this.cache.readManifest(snapshotId);
      if (!manifest) continue;
      try {
        await this.#seedManifest(this.#validateManifest(manifest, snapshotId));
      } catch (error) {
        this.logger.warn(`Could not re-seed cached snapshot ${snapshotId.slice(0, 12)}: ${error.message}`);
      }
    }
  }

  #decodeChunk(value, expected) {
    if (!value || value.protocol !== PROTOCOL || value.kind !== 'chunk') return null;
    if (value.encoding !== 'base64' || value.sha256 !== expected.sha256 || value.size !== expected.size) return null;
    const data = Buffer.from(String(value.data ?? ''), 'base64');
    return data.length === expected.size && digest(data) === expected.sha256 ? data : null;
  }

  #validateRegistry(value) {
    if (!value || value.protocol !== PROTOCOL || value.repositoryId !== this.config.repositoryId) return null;
    if (!Array.isArray(value.devices)) return null;
    const devices = sortedUnique(value.devices.map(String).filter((id) => DEVICE.test(id)));
    return devices.length > 10_000 ? null : { ...value, devices };
  }

  #validateHead(value) {
    if (!value || value.protocol !== PROTOCOL || value.repositoryId !== this.config.repositoryId) return null;
    if (!DEVICE.test(String(value.deviceId)) || !DIGEST.test(String(value.snapshotId))) return null;
    const refsDigest = value.refsDigest == null ? null : String(value.refsDigest);
    if (refsDigest !== null && !DIGEST.test(refsDigest)) return null;
    const headContentDigest = value.contentDigest == null ? String(value.snapshotId) : String(value.contentDigest);
    if (!DIGEST.test(headContentDigest)) return null;
    return {
      protocol: PROTOCOL,
      repositoryId: this.config.repositoryId,
      deviceId: String(value.deviceId),
      snapshotId: String(value.snapshotId),
      refsDigest,
      contentDigest: headContentDigest,
      updatedAt: String(value.updatedAt ?? ''),
    };
  }

  #validateManifest(value, expectedSnapshot) {
    if (!value || value.protocol !== PROTOCOL || value.repositoryId !== this.config.repositoryId) return null;
    if (!DIGEST.test(String(value.snapshotId))) return null;
    if (expectedSnapshot && value.snapshotId !== expectedSnapshot) return null;
    if (!DEVICE.test(String(value.deviceId))) return null;
    const refsDigest = value.refsDigest == null ? null : String(value.refsDigest);
    if (refsDigest !== null && !DIGEST.test(refsDigest)) return null;
    if (!Number.isSafeInteger(value.bundleSize) || value.bundleSize < 0) return null;
    if (!Array.isArray(value.refs) || !Array.isArray(value.chunks) || value.chunks.length > 1_000_000) return null;
    const chunks = value.chunks.map((chunk) => ({
      sha256: String(chunk?.sha256 ?? ''),
      size: Number(chunk?.size),
    }));
    if (chunks.some((chunk) => !DIGEST.test(chunk.sha256) || !Number.isSafeInteger(chunk.size) || chunk.size < 1)) {
      return null;
    }
    if (chunks.reduce((total, chunk) => total + chunk.size, 0) !== value.bundleSize) return null;
    const extended = Object.prototype.hasOwnProperty.call(value, 'workspaceDigest')
      || Object.prototype.hasOwnProperty.call(value, 'bundleSha256')
      || Object.prototype.hasOwnProperty.call(value, 'files');
    const bundleSha256 = extended
      ? (value.bundleSha256 == null ? null : String(value.bundleSha256))
      : String(value.snapshotId);
    if ((value.bundleSize === 0) !== (bundleSha256 === null)) return null;
    if (bundleSha256 !== null && !DIGEST.test(bundleSha256)) return null;
    if (value.bundleSize > 0 && refsDigest === null) return null;
    if (value.bundleSize === 0 && chunks.length > 0) return null;
    if (value.bundleSize > 0 && chunks.length === 0) return null;
    if (value.bundleSize > 0 && !Array.isArray(value.refs)) return null;

    const rawFiles = value.files ?? [];
    if (!Array.isArray(rawFiles) || rawFiles.length > 100_000) return null;
    const seen = new Set();
    const files = [];
    let totalFileChunks = 0;
    try {
      for (const raw of rawFiles) {
        const filePath = this.workspace.normalize(raw?.path);
        if (seen.has(filePath) || typeof raw?.deleted !== 'boolean') return null;
        seen.add(filePath);
        const deleted = raw.deleted;
        const size = Number(raw.size);
        const sha256 = raw.sha256 == null ? null : String(raw.sha256);
        const fileChunks = Array.isArray(raw.chunks) ? raw.chunks.map((chunk) => ({
          sha256: String(chunk?.sha256 ?? ''),
          size: Number(chunk?.size),
        })) : null;
        if (!fileChunks || fileChunks.length > 1_000_000) return null;
        totalFileChunks += fileChunks.length;
        if (totalFileChunks > 1_000_000) return null;
        if (fileChunks.some((chunk) => !DIGEST.test(chunk.sha256) || !Number.isSafeInteger(chunk.size) || chunk.size < 1)) return null;
        if (!Number.isSafeInteger(size) || size < 0 || fileChunks.reduce((total, chunk) => total + chunk.size, 0) !== size) return null;
        if (deleted) {
          if (size !== 0 || sha256 !== null || fileChunks.length !== 0) return null;
        } else if (!DIGEST.test(sha256 ?? '')) return null;
        files.push({ path: filePath, deleted, size, sha256, chunks: fileChunks });
      }
    } catch {
      return null;
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const calculatedWorkspaceDigest = workspaceDigest(files);
    const filesDigest = extended ? String(value.workspaceDigest ?? '') : calculatedWorkspaceDigest;
    if (!DIGEST.test(filesDigest) || filesDigest !== calculatedWorkspaceDigest) return null;
    if (extended && snapshotDigest(bundleSha256, filesDigest) !== value.snapshotId) return null;
    return {
      ...value,
      refsDigest,
      bundleSha256,
      workspaceDigest: filesDigest,
      chunks,
      files,
      refs: Array.isArray(value.refs) ? value.refs : [],
    };
  }

  #normalizeState(value) {
    if (!value || typeof value !== 'object') return { heads: {}, imported: {}, fileBaselines: {} };
    const fileBaselines = {};
    if (value.fileBaselines && typeof value.fileBaselines === 'object') {
      for (const [file, baseline] of Object.entries(value.fileBaselines)) {
        try {
          const normalized = this.workspace.normalize(file);
          if (baseline === null || DIGEST.test(String(baseline))) fileBaselines[normalized] = baseline;
        } catch { /* discard unsafe cached paths */ }
      }
    }
    return {
      heads: value.heads && typeof value.heads === 'object' ? value.heads : {},
      imported: value.imported && typeof value.imported === 'object' ? value.imported : {},
      fileBaselines,
    };
  }
}
