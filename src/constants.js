export const PROTOCOL = 'gitpigeon/1';
export const NETWORK_ID = 'gitpigeon-v1';
export const CONFIG_VERSION = 1;
export const CONFIG_FILE = 'config.json';
// A raw chunk is base64 encoded, encrypted by PeerPigeon Storage, and wrapped
// in a gossip envelope. 16 KiB leaves headroom for PeerPigeon's encrypted
// storage and gossip envelopes while avoiding thousands of tiny requests.
export const DEFAULT_CHUNK_SIZE = 16 * 1024;
export const DEFAULT_RETRIEVE_TIMEOUT_MS = 4_000;
export const DEFAULT_SYNC_WAIT_MS = 5_000;
export const DEFAULT_POLL_MS = 250;
// Liveness comes from PeerPigeon's leased CECR membership, not from GitPigeon
// republishing a storage record on a timer. The presence record only has to
// carry identity, so it is refreshed when that identity changes and re-asserted
// slowly to survive storage churn.
export const REPOSITORY_PRESENCE_HEARTBEAT_MS = 60_000;

export function storagePrefix(repositoryId) {
  return `gitpigeon/v1/${repositoryId}`;
}

export function registryKey(repositoryId) {
  return `${storagePrefix(repositoryId)}/registry`;
}

export function headKey(repositoryId, deviceId) {
  return `${storagePrefix(repositoryId)}/head/${deviceId}`;
}

export function snapshotHeadKey(repositoryId, deviceId, snapshotId) {
  return `${headKey(repositoryId, deviceId)}/${snapshotId}`;
}

export function presenceKey(repositoryId, deviceId) {
  return `${storagePrefix(repositoryId)}/presence/${deviceId}`;
}

export function manifestKey(repositoryId, snapshotId) {
  return `${storagePrefix(repositoryId)}/manifest/${snapshotId}`;
}

export function chunkKey(repositoryId, digest) {
  return `${storagePrefix(repositoryId)}/chunk/${digest}`;
}
