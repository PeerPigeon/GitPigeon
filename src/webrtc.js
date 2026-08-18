const WEBRTC_GLOBALS = [
  'RTCCertificate',
  'RTCDataChannel',
  'RTCDataChannelEvent',
  'RTCDtlsTransport',
  'RTCError',
  'RTCIceCandidate',
  'RTCIceTransport',
  'RTCPeerConnection',
  'RTCPeerConnectionIceEvent',
  'RTCSctpTransport',
  'RTCSessionDescription',
];

let installation;

/** Install the browser-compatible transports expected by FreeRTC in Node. */
export async function installNativeWebRTC() {
  if (typeof globalThis.RTCPeerConnection === 'function' && typeof globalThis.WebSocket === 'function') return;
  if (installation) return await installation;
  installation = (async () => {
    if (typeof globalThis.WebSocket !== 'function') {
      const { WebSocket } = await import('ws');
      globalThis.WebSocket = WebSocket;
    }
    if (typeof globalThis.RTCPeerConnection !== 'function') {
      const polyfill = await import('werift');
      for (const name of WEBRTC_GLOBALS) {
        if (typeof globalThis[name] === 'undefined' && typeof polyfill[name] !== 'undefined') {
          globalThis[name] = polyfill[name];
        }
      }
      const WeriftPeerConnection = polyfill.RTCPeerConnection;
      globalThis.RTCPeerConnection = class GitPigeonPeerConnection extends WeriftPeerConnection {
        constructor(configuration = {}) {
          super({ ...configuration, iceCandidatePoolSize: 0 });
        }
      };
    }
    if (typeof globalThis.RTCPeerConnection !== 'function') {
      throw new Error('The native WebRTC runtime did not provide RTCPeerConnection');
    }
  })();
  try {
    await installation;
  } catch (error) {
    installation = null;
    throw error;
  }
}
