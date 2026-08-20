import dgram from 'node:dgram';
import {
  DEVICE_GRANT_PROTOCOL,
  DEVICE_REQUEST_PROTOCOL,
  LAN_MULTICAST_ADDRESS,
  LAN_MULTICAST_PORT,
  createDeviceEnrollmentRequest,
  deviceApprovalKey,
  deviceRequestsKey,
  openDeviceGrant,
  validateDeviceEnrollmentRequest,
} from './device-grants.js';
import { startDeviceApprovalRequester } from './device-approval-mesh.js';

const REQUEST_BUCKET_MS = 5_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bind(socket, port) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      socket.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      socket.off('error', failed);
      resolve();
    };
    socket.once('error', failed);
    socket.once('listening', ready);
    socket.bind(port, '0.0.0.0');
  });
}

function send(socket, value, port, address) {
  const data = Buffer.from(JSON.stringify(value), 'utf8');
  if (data.length > 60_000) throw new Error('GitPigeon LAN message is too large');
  return new Promise((resolve, reject) => {
    socket.send(data, port, address, (error) => error ? reject(error) : resolve());
  });
}

function decodeMessage(data) {
  if (!Buffer.isBuffer(data) || data.length > 60_000) return null;
  try { return JSON.parse(data.toString('utf8')); } catch { return null; }
}

export async function requestLanDeviceApproval(identity, {
  timeoutMs = 5 * 60_000,
  logger = {},
  onRequest = () => {},
} = {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await bind(socket, 0);
  socket.setMulticastTTL(1);
  const port = socket.address().port;
  const request = createDeviceEnrollmentRequest(identity, { port });
  const deadline = Math.min(Date.parse(request.expiresAt), Date.now() + timeoutMs);
  let settled = false;
  let interval;
  let timeout;
  let meshSessionPromise;
  const result = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
      socket.close();
      meshSessionPromise?.then((session) => session?.close()).catch(() => {});
      if (error) reject(error);
      else resolve(value);
    };
    const accept = (envelope, source) => {
      if (envelope?.protocol !== DEVICE_GRANT_PROTOCOL || envelope.requestId !== request.requestId) return;
      try {
        const grant = openDeviceGrant(identity, envelope, { purpose: 'enrollment' });
        logger.debug?.(`Encrypted device approval received through ${source}`);
        finish(null, { request, grant });
      } catch (error) {
        logger.debug?.(`Ignored invalid device approval: ${error.message}`);
      }
    };
    socket.on('message', (data, remote) => {
      accept(decodeMessage(data), `LAN ${remote.address}`);
    });
    meshSessionPromise = startDeviceApprovalRequester(identity, request, {
      logger,
      onGrant: (envelope) => accept(envelope, 'PeerPigeon mesh'),
    }).catch((error) => {
      logger.debug?.(`PeerPigeon device approval discovery: ${error.message}`);
      return null;
    });
    socket.on('error', (error) => finish(error));
    timeout = setTimeout(() => finish(new Error('No approved GitPigeon browser authorized this device before the request expired')), Math.max(1, deadline - Date.now()));
  });
  const advertise = () => send(socket, request, LAN_MULTICAST_PORT, LAN_MULTICAST_ADDRESS)
    .catch((error) => logger.debug?.(`LAN enrollment advertisement: ${error.message}`));
  await onRequest(request);
  await advertise();
  interval = setInterval(advertise, 1_000);
  return await result;
}

export async function startLanApprovalService(indexSession, {
  logger = {},
  requestBucketMs = REQUEST_BUCKET_MS,
  onDeviceRequest = () => {},
} = {}) {
  const indexId = indexSession?.index?.indexId;
  const storage = indexSession?.node?.storage;
  if (!indexId || !storage) throw new Error('GitPigeon LAN approval requires an active encrypted index session');
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const requests = new Map();
  const subscriptions = new Map();
  let closed = false;
  let publishing = false;
  let lastBucket = null;

  await bind(socket, LAN_MULTICAST_PORT);
  socket.addMembership(LAN_MULTICAST_ADDRESS);
  socket.setMulticastTTL(1);
  socket.on('message', (data, remote) => {
    const request = validateDeviceEnrollmentRequest(decodeMessage(data));
    if (!request || remote.address === '0.0.0.0') return;
    const existing = requests.get(request.requestId);
    requests.set(request.requestId, {
      request,
      address: remote.address,
      port: request.port || remote.port,
      lastSeenAt: Date.now(),
      grantedAt: existing?.grantedAt ?? null,
    });
    if (!subscriptions.has(request.requestId)) {
      subscriptions.set(
        request.requestId,
        storage.subscribeKey('public', deviceApprovalKey(indexId, request.requestId)),
      );
    }
    if (!existing) {
      Promise.resolve(onDeviceRequest(request)).catch((error) => logger.error?.(error));
    }
  });
  socket.on('error', (error) => logger.error?.(error));

  const tick = async () => {
    if (closed || publishing) return;
    publishing = true;
    try {
      const now = Date.now();
      for (const [requestId, record] of requests) {
        if (Date.parse(record.request.expiresAt) >= now && now - record.lastSeenAt <= 15_000) continue;
        requests.delete(requestId);
        subscriptions.get(requestId)?.();
        subscriptions.delete(requestId);
      }
      const bucket = Math.floor(now / requestBucketMs);
      if (bucket !== lastBucket || requests.size > 0) {
        await storage.put('public', deviceRequestsKey(indexId, bucket), {
          protocol: DEVICE_REQUEST_PROTOCOL,
          kind: 'requests',
          indexId,
          updatedAt: new Date(now).toISOString(),
          requests: [...requests.values()]
            .filter((record) => !record.grantedAt)
            .map((record) => record.request),
        });
        lastBucket = bucket;
      }
      if (indexSession.node.getConnectedPeers().length === 0) return;
      for (const record of requests.values()) {
        if (record.grantedAt) continue;
        const key = deviceApprovalKey(indexId, record.request.requestId);
        const cached = await storage.get('public', key);
        const approval = cached ?? await storage.retrieve('public', key, { timeoutMs: 300 });
        const envelope = approval?.value;
        if (envelope?.protocol !== DEVICE_GRANT_PROTOCOL
          || envelope.purpose !== 'enrollment'
          || envelope.requestId !== record.request.requestId
          || envelope.recipientPublicKey !== record.request.publicKey) continue;
        await send(socket, envelope, record.port, record.address);
        await sleep(50);
        await send(socket, envelope, record.port, record.address);
        record.grantedAt = Date.now();
        logger.info?.(`Forwarded encrypted approval to ${record.request.deviceName}`);
      }
    } catch (error) {
      logger.error?.(error);
    } finally {
      publishing = false;
    }
  };

  const timer = setInterval(() => { tick().catch((error) => logger.error?.(error)); }, 750);
  tick().catch((error) => logger.error?.(error));
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      while (publishing) await sleep(10);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      socket.close();
    },
  };
}
