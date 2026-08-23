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
    this.connected = [];
  }

  getClientId() { return this.peerId; }
  getConnectedPeers() { return [...this.connected]; }

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
