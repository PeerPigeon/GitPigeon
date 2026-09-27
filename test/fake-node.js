import { EventEmitter } from 'node:events';
import { CHANNEL_PROTOCOL } from '../src/channel.js';

/**
 * A stand-in for `PeerPigeonNode` that implements only the encrypted messaging
 * surface GitPigeon uses. Confidentiality is PeerPigeon's job; these tests care
 * about which frames reach which peer, so the fake carries plaintext and
 * records what was sent.
 */
export class FakeNode extends EventEmitter {
  constructor(peerId = 'watcher-peer') {
    super();
    this.peerId = peerId;
    this.direct = [];
    this.broadcasts = [];
    this.plain = [];
    this.connected = [];
    this.started = false;
    this.deliverTo = new Set();
  }

  getClientId() { return this.peerId; }
  getConnectedPeers() { return [...this.connected]; }

  /** Lifecycle, for the services that own their own node. */
  async start() { this.started = true; }
  async destroy() { this.started = false; }

  /**
   * A plain room broadcast — no channel envelope. Used by the services that
   * carry their own protocol object rather than a repository channel frame
   * (the pairing mesh, LAN fleet convergence).
   */
  broadcast(value) {
    this.plain.push(value);
    for (const listener of this.deliverTo) {
      listener.emit('message', { local: false, fromPeerId: this.peerId, data: value });
    }
    return `plain-${this.plain.length}`;
  }

  /** Everything this node broadcasts also reaches `node`, as the room would. */
  wireTo(node) {
    this.deliverTo.add(node);
    node.deliverTo.add(this);
  }

  async sendEncryptedDirect(peerId, plaintext) {
    this.direct.push({ peerId, frame: JSON.parse(plaintext) });
    return `direct-${this.direct.length}`;
  }

  async broadcastEncrypted(plaintext) {
    this.broadcasts.push(JSON.parse(plaintext));
    return `broadcast-${this.broadcasts.length}`;
  }

  /** Deliver one encrypted frame from a remote peer. */
  receive(fromPeerId, repositoryId, channel, frame, kind = 'direct') {
    this.emit('message', {
      kind,
      encrypted: true,
      local: false,
      fromPeerId,
      // Envelope fields last, matching encode() in src/channel.js: a payload
      // must not be able to overwrite the routing identity.
      data: JSON.stringify({
        ...frame,
        protocol: CHANNEL_PROTOCOL,
        repositoryId,
        channel,
      }),
    });
  }

  /** Frames sent directly to one peer on one channel. */
  directFrames(channel) {
    return this.direct.filter(({ frame }) => frame.channel === channel).map(({ frame }) => frame);
  }

  /** Frames broadcast to the room on one channel. */
  broadcastFrames(channel) {
    return this.broadcasts.filter((frame) => frame.channel === channel);
  }
}
