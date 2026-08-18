import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SAFE_NAME = /^[a-f0-9]{64}$/;
const CHUNK_MAGIC = Buffer.from('GPCH1\0', 'ascii');
const IV_SIZE = 12;
const TAG_SIZE = 16;

export class RepositoryCache {
  constructor(gitDir) {
    this.root = path.join(gitDir, 'gitpigeon');
    this.chunkDirectory = path.join(this.root, 'chunks');
    this.manifestDirectory = path.join(this.root, 'manifests');
    this.remoteDirectory = path.join(this.root, 'remotes');
    this.stateFile = path.join(this.root, 'state.json');
    this.encryptionKey = null;
  }

  setEncryptionSecret(secret) {
    this.encryptionKey = createHash('sha256')
      .update('gitpigeon-local-cache-v1\0')
      .update(String(secret))
      .digest();
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
    const filename = this.chunkPath(digest);
    const stored = await readFile(filename);
    if (stored.subarray(0, CHUNK_MAGIC.length).equals(CHUNK_MAGIC)) {
      if (!this.encryptionKey) throw new Error('GitPigeon cache secret is required to decrypt chunks');
      if (stored.length < CHUNK_MAGIC.length + IV_SIZE + TAG_SIZE) {
        throw new Error(`Corrupt encrypted cache chunk: ${digest}`);
      }
      const ivStart = CHUNK_MAGIC.length;
      const tagStart = ivStart + IV_SIZE;
      const dataStart = tagStart + TAG_SIZE;
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, stored.subarray(ivStart, tagStart));
        decipher.setAAD(Buffer.from(digest));
        decipher.setAuthTag(stored.subarray(tagStart, dataStart));
        return Buffer.concat([decipher.update(stored.subarray(dataStart)), decipher.final()]);
      } catch {
        throw new Error(`Could not decrypt cache chunk ${digest}; the repository secret may have changed`);
      }
    }
    if (this.encryptionKey) {
      // Transparently migrate caches written before local chunk encryption.
      await this.#writeReplace(filename, this.#encryptChunk(digest, stored));
    }
    return stored;
  }

  async writeChunk(digest, data) {
    const filename = this.chunkPath(digest);
    if (await this.hasChunk(digest)) {
      await this.readChunk(digest);
      return filename;
    }
    const value = Buffer.from(data);
    await this.#writeOnce(filename, this.encryptionKey ? this.#encryptChunk(digest, value) : value);
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
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, filename);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      await rm(temporary, { force: true });
    }
  }

  async #writeReplace(filename, data) {
    const temporary = `${filename}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, filename);
  }

  #assertDigest(value) {
    if (!SAFE_NAME.test(String(value))) throw new Error(`Invalid content digest: ${value}`);
  }

  #encryptChunk(digest, data) {
    if (!this.encryptionKey) return Buffer.from(data);
    const iv = randomBytes(IV_SIZE);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(digest));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([CHUNK_MAGIC, iv, cipher.getAuthTag(), encrypted]);
  }
}
