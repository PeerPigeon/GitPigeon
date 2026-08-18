import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SAFE_NAME = /^[a-f0-9]{64}$/;

export class RepositoryCache {
  constructor(gitDir) {
    this.root = path.join(gitDir, 'gitpigeon');
    this.chunkDirectory = path.join(this.root, 'chunks');
    this.manifestDirectory = path.join(this.root, 'manifests');
    this.remoteDirectory = path.join(this.root, 'remotes');
    this.stateFile = path.join(this.root, 'state.json');
  }

  async init() {
    await Promise.all([
      mkdir(this.chunkDirectory, { recursive: true }),
      mkdir(this.manifestDirectory, { recursive: true }),
      mkdir(this.remoteDirectory, { recursive: true }),
    ]);
  }

  chunkPath(digest) {
    this.#assertDigest(digest);
    return path.join(this.chunkDirectory, digest);
  }

  manifestPath(snapshotId) {
    this.#assertDigest(snapshotId);
    return path.join(this.manifestDirectory, `${snapshotId}.json`);
  }

  async hasChunk(digest) {
    try {
      await access(this.chunkPath(digest));
      return true;
    } catch {
      return false;
    }
  }

  async readChunk(digest) {
    return await readFile(this.chunkPath(digest));
  }

  async writeChunk(digest, data) {
    const filename = this.chunkPath(digest);
    if (await this.hasChunk(digest)) return filename;
    await this.#writeOnce(filename, Buffer.from(data));
    return filename;
  }

  async readManifest(snapshotId) {
    try {
      return JSON.parse(await readFile(this.manifestPath(snapshotId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async writeManifest(manifest) {
    const filename = this.manifestPath(manifest.snapshotId);
    try {
      await access(filename);
      return filename;
    } catch {
      await this.#writeOnce(filename, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
      return filename;
    }
  }

  async loadState() {
    try {
      return JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { heads: {}, imported: {} };
      throw error;
    }
  }

  async saveState(state) {
    await this.init();
    await this.#writeReplace(this.stateFile, Buffer.from(`${JSON.stringify(state, null, 2)}\n`));
  }

  async listManifests() {
    await this.init();
    const names = await readdir(this.manifestDirectory);
    return names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => name.slice(0, -5));
  }

  async #writeOnce(filename, data) {
    const temporary = `${filename}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temporary, data, { flag: 'wx' });
    try {
      await rename(temporary, filename);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      await rm(temporary, { force: true });
    }
  }

  async #writeReplace(filename, data) {
    const temporary = `${filename}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, filename);
  }

  #assertDigest(value) {
    if (!SAFE_NAME.test(String(value))) throw new Error(`Invalid content digest: ${value}`);
  }
}
