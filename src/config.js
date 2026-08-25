import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE, CONFIG_VERSION } from './constants.js';
import { validateRepositoryId, validateSecret } from './invite.js';

export function createIdentity(overrides = {}) {
  return validateConfig({
    version: CONFIG_VERSION,
    repositoryId: overrides.repositoryId ?? randomBytes(16).toString('hex'),
    secret: overrides.secret ?? randomBytes(32).toString('base64url'),
    deviceId: overrides.deviceId ?? randomUUID().replaceAll('-', ''),
    signalingServer: overrides.signalingServer,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  });
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid GitPigeon config');
  if (input.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported GitPigeon config version: ${input.version}`);
  }
  const deviceId = String(input.deviceId ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(deviceId)) throw new Error('Invalid device ID');
  const signalingServer = input.signalingServer ? String(input.signalingServer).trim() : undefined;
  if (signalingServer && !/^wss?:\/\//i.test(signalingServer)) {
    throw new Error('Signaling server must use ws:// or wss://');
  }
  let share;
  if (input.share) {
    const role = String(input.share.role ?? '');
    if (role !== 'owner' && role !== 'mirror') throw new Error('Share role must be owner or mirror');
    share = {
      key: validateSecret(input.share.key),
      ownerPublicKey: String(input.share.ownerPublicKey ?? '').trim(),
      role,
      createdAt: String(input.share.createdAt ?? new Date().toISOString()),
    };
    if (share.ownerPublicKey.length < 16 || share.ownerPublicKey.length > 512) {
      throw new Error('Invalid share owner public key');
    }
  }
  return {
    version: CONFIG_VERSION,
    repositoryId: validateRepositoryId(input.repositoryId),
    secret: validateSecret(input.secret),
    deviceId,
    ...(signalingServer ? { signalingServer } : {}),
    ...(share ? { share } : {}),
    createdAt: String(input.createdAt ?? new Date().toISOString()),
  };
}

export function configPath(gitDir) {
  return path.join(gitDir, 'gitpigeon', CONFIG_FILE);
}

export async function loadConfig(gitDir) {
  const filename = configPath(gitDir);
  let data;
  try {
    data = await readFile(filename, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('This repository is not configured. Run `git pigeon init`.');
    }
    throw error;
  }
  try {
    return validateConfig(JSON.parse(data));
  } catch (error) {
    throw new Error(`Invalid GitPigeon config at ${filename}: ${error.message}`);
  }
}

export async function saveConfig(gitDir, config) {
  const value = validateConfig(config);
  const directory = path.dirname(configPath(gitDir));
  const filename = configPath(gitDir);
  const temporary = path.join(directory, `.config-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
  return value;
}

