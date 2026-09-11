// One encrypted request/response channel for every GitPigeon peer protocol.
//
// GitPigeon used to disable PeerPigeon's crypto and then re-implement it three
// times — snapshot streaming, realtime documents, and the watcher terminal each
// derived their own `sha256('gitpigeon:<name>:v1\0' + secret)` AES-256-GCM key
// and wrapped their own `{ protocol, repositoryId, ciphertext }` envelope. That
// is precisely what PeerPigeon's room crypto already provides, so these helpers
// carry a plain JSON frame and let `broadcastEncrypted` / `sendEncryptedDirect`
// own key derivation, nonces, and authentication.
//
// Direct frames travel through PeerPigeon's gossip router, so a peer that is
// reachable through the mesh no longer has to be a direct data-channel
// neighbour the way the previous raw `mesh.send` transport required.

export const CHANNEL_PROTOCOL = 'gitpigeon/2';
export const SNAPSHOT_CHANNEL = 'snapshot';
export const REALTIME_CHANNEL = 'realtime';
export const TERMINAL_CHANNEL = 'terminal';
export const CONTROL_CHANNEL = 'control';

/**
 * The device-scoped terminal room tag. The watcher shell belongs to the
 * MACHINE, not to any repository: a browser reaches it here from whichever
 * repository it is viewing, and every repository's own terminal channel
 * routes to the same shell for dashboards that still dial by repository.
 */
export function deviceTerminalRoom(serviceInstanceId) {
  return `device:${serviceInstanceId}`;
}

// Reserved by the envelope. A payload must not use these names; they identify
// where a frame belongs and are written last so they cannot be overwritten.
export const RESERVED_FRAME_FIELDS = Object.freeze(['protocol', 'repositoryId', 'channel']);

function selfIdOf(node) {
  try { return String(node?.getClientId?.() ?? node?.mesh?.getClientId?.() ?? '') || null; } catch { return null; }
}

// PeerPigeon does not fragment a gossip payload, so a frame has to fit one
// data-channel message. Snapshot payloads are already split into manifest
// chunks well below this bound.
export const MAX_FRAME_BYTES = 192 * 1024;

/** Room crypto options for a repository. Peers without the secret cannot read. */
export function repositoryCrypto(repositoryId, secret) {
  return { roomId: `gitpigeon:${repositoryId}`, roomSecret: String(secret) };
}

function encode(repositoryId, channel, frame) {
  // Envelope fields are written last so a payload cannot overwrite them. A
  // control frame naming a repository carries its own `repositoryId`, and
  // spreading the payload over the envelope replaced the routing identity with
  // it, so the receiver dropped the frame as belonging to somewhere else.
  const plaintext = JSON.stringify({
    ...frame,
    protocol: CHANNEL_PROTOCOL,
    repositoryId,
    channel,
  });
  if (plaintext.length > MAX_FRAME_BYTES) {
    throw new Error(`GitPigeon ${channel} frame is too large for one PeerPigeon message`);
  }
  return plaintext;
}

/** Decode a PeerPigeon `message` event into a frame for this repository channel. */
export function decodeChannelFrame(repositoryId, channel, message, selfId = null) {
  if (!message?.encrypted || message.local || typeof message.data !== 'string') return null;
  if (message.data.length > MAX_FRAME_BYTES) return null;
  let frame;
  try { frame = JSON.parse(message.data); } catch { return null; }
  if (!frame || typeof frame !== 'object') return null;
  if (frame.protocol !== CHANNEL_PROTOCOL) return null;
  if (frame.repositoryId !== repositoryId || frame.channel !== channel) return null;
  // A frame addressed to one peer but carried by gossip (no direct route)
  // is for that peer alone.
  if (typeof frame.to === 'string' && frame.to && selfId && frame.to !== selfId) return null;
  return frame;
}

/**
 * Send one encrypted frame to a single peer. Direct through the PeerPigeon
 * router when a route exists; otherwise addressed to that peer and carried
 * by gossip — this is a partial mesh, and a peer with no direct path is
 * still a peer. Every other holder of the room key drops an addressed
 * frame that is not for it.
 */
export async function sendChannelDirect(node, peerId, repositoryId, channel, frame) {
  try {
    await node.sendEncryptedDirect(peerId, encode(repositoryId, channel, frame));
  } catch (error) {
    if (!/No route to peer/i.test(String(error?.message ?? error))) throw error;
    await node.broadcastEncrypted(encode(repositoryId, channel, { ...frame, to: peerId }));
  }
}

/** Broadcast one encrypted frame to every peer holding the repository secret. */
export async function broadcastChannel(node, repositoryId, channel, frame) {
  await node.broadcastEncrypted(encode(repositoryId, channel, frame));
}

/**
 * Subscribe to one repository channel. The handler receives
 * `(frame, { peerId, kind, origin })` and returns an unsubscribe function.
 *
 * `peerId` is the peer the frame arrived FROM; for a broadcast that is the
 * hop that relayed it, not the peer that sent it. `origin` is the sender —
 * the address a reply must go to. Answering `peerId` sent every reply to a
 * relayed broadcast to the wrong machine, which is how a browser's ping
 * went unanswered and every following probe became a retry broadcast.
 */
export function onChannelMessage(node, repositoryId, channel, handler) {
  const listener = (message) => {
    const frame = decodeChannelFrame(repositoryId, channel, message, selfIdOf(node));
    if (!frame || !message.fromPeerId) return;
    const origin = String(message.message?.sender ?? message.message?.from ?? message.fromPeerId);
    handler(frame, { peerId: String(message.fromPeerId), kind: message.kind, origin });
  };
  node.on('message', listener);
  return () => node.off('message', listener);
}
