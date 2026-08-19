export const PROTOCOL = 'gitpigeon/1';
export const NETWORK_ID = 'gitpigeon-v1';
export const CONFIG_VERSION = 1;
export const CONFIG_FILE = 'config.json';
// A raw chunk is base64 encoded, encrypted by PeerPigeon Storage, and wrapped
// in a gossip envelope. Keep the final RTC message comfortably below the
// smallest practical cross-runtime data-channel message limit.
export const DEFAULT_CHUNK_SIZE = 4 * 1024;
export const DEFAULT_RETRIEVE_TIMEOUT_MS = 4_000;
export const DEFAULT_SYNC_WAIT_MS = 5_000;
export const DEFAULT_POLL_MS = 250;

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
