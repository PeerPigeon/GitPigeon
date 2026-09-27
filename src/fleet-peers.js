import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

// `root` is always passed, never defaulted from machineIndexRoot(): the index
// is what pins its members, so defaulting it here would make this module and
// machine-index.js import each other.
const PEERS_FILE = 'fleet-peers.json';
// A fleet is machines someone put together by hand, one pairing at a time.
const MAX_PEERS = 64;

/**
 * Machines this one has been paired with, by their pairing public key.
 *
 * This is the membership credential for the LAN room (see lan-identity.js).
 * The room's name is derivable by anything on the Wi-Fi, so it admits nobody
 * on its own; a key lands in here only when a pairing actually completed —
 * someone read a phrase off one machine's screen and gave it to the other —
 * and afterwards those two machines recognise each other on any LAN they
 * share, with no phrase and no browser in the middle. That is what lets a
 * fleet survive a secret rotation instead of going quietly dark.
 *
 * Pinning is not a grant of anything by itself. It says "I have met this
 * machine"; what a pinned peer may then ask for is decided where it is asked.
 */
export function fleetPeersPath(root) {
  if (!root) throw new Error('GitPigeon fleet peers need the machine state root');
  return path.join(root, PEERS_FILE);
}

function validPeer(value) {
  if (!value || typeof value !== 'object') return null;
  const publicKey = String(value.publicKey ?? '');
  if (!publicKey || publicKey.length > 200) return null;
  const sealingKey = typeof value.sealingKey === 'string' && value.sealingKey.length <= 200
    ? value.sealingKey
    : null;
  const pinnedAt = Date.parse(String(value.pinnedAt ?? ''));
  return {
    publicKey,
    sealingKey,
    deviceName: typeof value.deviceName === 'string' ? value.deviceName.slice(0, 120) : null,
    pinnedAt: Number.isFinite(pinnedAt) ? new Date(pinnedAt).toISOString() : new Date(0).toISOString(),
  };
}

async function readPeers(root) {
  try {
    const value = JSON.parse(await readFile(fleetPeersPath(root), 'utf8'));
    const peers = Array.isArray(value?.peers) ? value.peers : [];
    return peers.map(validPeer).filter((peer) => peer !== null);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    // A corrupt file must not take the watcher down with it, and must not
    // silently read as "no peers are pinned" either — that would let the LAN
    // room admit nobody and look like a working empty fleet.
    throw new Error(`GitPigeon fleet peers file is unreadable: ${error.message}`);
  }
}

async function writePeers(root, peers) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = fleetPeersPath(root);
  const staged = `${file}.${process.pid}-${randomBytes(5).toString('hex')}.tmp`;
  await writeFile(staged, `${JSON.stringify({ version: 1, peers }, null, 2)}\n`, { mode: 0o600 });
  await rename(staged, file);
}

/** Every machine this one has paired with. */
export async function listFleetPeers({ root } = {}) {
  return await readPeers(root);
}

/** The pinned record for one public key, or null. */
export async function fleetPeer(publicKey, { root } = {}) {
  const key = String(publicKey ?? '');
  if (!key) return null;
  return (await readPeers(root)).find((peer) => peer.publicKey === key) ?? null;
}

/**
 * Remember a machine this one just paired with. Called from both directions of
 * a pairing: the machine that answered a phrase and the one that was handed an
 * index both end up knowing the other, or only one of them could re-converge
 * later and the other would refuse it.
 */
export async function pinFleetPeer({
  publicKey,
  sealingKey = null,
  deviceName = null,
  root,
  now = Date.now(),
} = {}) {
  const pinned = validPeer({ publicKey, sealingKey, deviceName, pinnedAt: new Date(now).toISOString() });
  if (!pinned) throw new Error('Pinning a fleet peer requires its pairing public key');
  const peers = await readPeers(root);
  const existing = peers.find((peer) => peer.publicKey === pinned.publicKey);
  if (existing) {
    // A re-pairing refreshes what can change — the sealing key rotates with
    // the peer's identity file, the hostname changes — and keeps the original
    // pinning time, which is the fact being recorded.
    existing.sealingKey = pinned.sealingKey ?? existing.sealingKey;
    existing.deviceName = pinned.deviceName ?? existing.deviceName;
    await writePeers(root, peers);
    return existing;
  }
  // Oldest out first, and never the one being added.
  const kept = peers
    .sort((left, right) => Date.parse(left.pinnedAt) - Date.parse(right.pinnedAt))
    .slice(Math.max(0, peers.length + 1 - MAX_PEERS));
  await writePeers(root, [...kept, pinned]);
  return pinned;
}

/** Forget a machine: it is no longer recognised on any shared LAN. */
export async function forgetFleetPeer(publicKey, { root } = {}) {
  const key = String(publicKey ?? '');
  const peers = await readPeers(root);
  const kept = peers.filter((peer) => peer.publicKey !== key);
  if (kept.length === peers.length) return false;
  await writePeers(root, kept);
  return true;
}
