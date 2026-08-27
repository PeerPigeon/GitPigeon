import { createHash } from 'node:crypto';
import http from 'node:http';

/**
 * Dependency-free Nostr relay stand-in for tests: a minimal RFC 6455
 * websocket server speaking just enough NIP-01 — EVENT (stored, replaceable
 * by pubkey+kind+d-tag, answered with OK), REQ (matching events + EOSE),
 * CLOSE. Text frames only; enough for records well under 64 KiB.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65_536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

export function startFakeNostrRelay({ port = 0, logger = () => {} } = {}) {
  // Replaceable storage: (pubkey, kind, d) → event.
  const events = new Map();
  const addressOf = (event) => {
    const d = event.tags?.find((tag) => tag[0] === 'd')?.[1] ?? '';
    return `${event.pubkey} ${event.kind} ${d}`;
  };

  const server = http.createServer((request, response) => response.writeHead(426).end());
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));

    let buffered = Buffer.alloc(0);
    const send = (frame) => socket.write(encodeTextFrame(JSON.stringify(frame)));
    socket.on('data', (data) => {
      buffered = Buffer.concat([buffered, data]);
      for (;;) {
        if (buffered.length < 2) return;
        const opcode = buffered[0] & 0x0f;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (buffered[1] & 0x80) !== 0;
        const maskLength = masked ? 4 : 0;
        if (buffered.length < offset + maskLength + length) return;
        const mask = masked ? buffered.subarray(offset, offset + 4) : null;
        const payload = Buffer.from(buffered.subarray(offset + maskLength, offset + maskLength + length));
        if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        buffered = buffered.subarray(offset + maskLength + length);

        if (opcode === 8) { socket.end(); return; }
        if (opcode === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
        if (opcode !== 1) continue;
        let frame;
        try { frame = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (!Array.isArray(frame)) continue;
        if (frame[0] === 'EVENT') {
          const event = frame[1];
          const address = addressOf(event);
          const existing = events.get(address);
          if (!existing || event.created_at >= existing.created_at) events.set(address, event);
          logger(`EVENT ${address}`);
          send(['OK', event.id, true, '']);
          continue;
        }
        if (frame[0] === 'REQ') {
          const [, subId, filter] = frame;
          const matches = [...events.values()].filter((event) => (
            (!filter?.authors || filter.authors.includes(event.pubkey))
            && (!filter?.kinds || filter.kinds.includes(event.kind))
            && (!filter?.['#d'] || event.tags?.some((tag) => tag[0] === 'd' && filter['#d'].includes(tag[1])))
          ));
          logger(`REQ ${subId} -> ${matches.length}`);
          for (const event of matches) send(['EVENT', subId, event]);
          send(['EOSE', subId]);
          continue;
        }
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}`,
        eventCount: () => events.size,
        events,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
