export const PROTOCOL = 'gitpigeon/1';
export const NETWORK_ID = 'gitpigeon-v1';
export const CONFIG_VERSION = 1;
export const CONFIG_FILE = 'config.json';
export const DEFAULT_CHUNK_SIZE = 16 * 1024;
export const DEFAULT_RETRIEVE_TIMEOUT_MS = 4_000;
export const DEFAULT_SYNC_WAIT_MS = 5_000;
export const DEFAULT_POLL_MS = 1_000;

export function storagePrefix(repositoryId) {
  return `gitpigeon/v1/${repositoryId}`;
}

export function registryKey(repositoryId) {
  return `${storagePrefix(repositoryId)}/registry`;
}

export function headKey(repositoryId, deviceId) {
  return `${storagePrefix(repositoryId)}/head/${deviceId}`;
}

export function manifestKey(repositoryId, snapshotId) {
  return `${storagePrefix(repositoryId)}/manifest/${snapshotId}`;
}

export function chunkKey(repositoryId, digest) {
  return `${storagePrefix(repositoryId)}/chunk/${digest}`;
}

