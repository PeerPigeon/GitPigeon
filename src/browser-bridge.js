import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateRepositoryId, validateSecret } from './invite.js';

export const BROWSER_BRIDGE_HOST = '127.0.0.1';
export const BROWSER_BRIDGE_PORT = 17381;

const HEARTBEAT_MS = 2_000;
const STALE_MS = 7_000;
const MAX_BODY_BYTES = 64 * 1024;
const SERVICE_START_TIMEOUT_MS = 10_000;
const SERVICE_ENTRYPOINT = fileURLToPath(new URL('../bin/git-pigeon-index.js', import.meta.url));
const DEFAULT_ORIGINS = new Set([
  'https://gitpigeon.dev',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function bridgeRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? homedir(), 'GitPigeon');
  }
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'GitPigeon');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'gitpigeon');
}

async function sharedToken() {
  const root = bridgeRoot();
  const filename = path.join(root, 'browser-bridge-token');
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const handle = await open(filename, 'wx', 0o600);
    try {
      const token = randomBytes(32).toString('hex');
      await handle.writeFile(`${token}\n`);
      return token;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = (await readFile(filename, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/.test(token)) return token;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Invalid GitPigeon browser bridge token at ${filename}`);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateRegistration(value) {
  if (!value || typeof value !== 'object') return null;
  let repositoryId;
  let secret;
  try {
    repositoryId = validateRepositoryId(value.repositoryId);
    secret = validateSecret(value.secret);
  } catch {
    return null;
  }
  const registrationId = String(value.registrationId ?? '');
  const deviceId = String(value.deviceId ?? '');
  const repository = String(value.repository ?? '');
  const pid = Number(value.pid);
  const name = String(value.name ?? '').trim().slice(0, 200);
  const signalingServer = value.signalingServer ? String(value.signalingServer) : undefined;
  if (!/^[a-f0-9]{64}$/.test(registrationId)) return null;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(deviceId)) return null;
  if (!path.isAbsolute(repository) || repository.length > 4_096) return null;
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (!name || (signalingServer && !/^wss?:\/\//i.test(signalingServer))) return null;
  return { registrationId, repositoryId, secret, deviceId, repository, pid, name, ...(signalingServer ? { signalingServer } : {}) };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, status, value, headers = {}) {
  const body = value == null ? '' : `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers,
  });
  response.end(body);
}

function publicPigeons(records) {
  const grouped = new Map();
  for (const record of records.values()) {
    const current = grouped.get(record.repositoryId);
    if (!current) {
      grouped.set(record.repositoryId, {
        repositoryId: record.repositoryId,
        secret: record.secret,
        name: record.name,
        ...(record.signalingServer ? { signalingServer: record.signalingServer } : {}),
        watcherCount: 1,
      });
    } else {
      current.watcherCount += 1;
    }
  }
  return [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function createHandler({ records, token, origins, onStop }) {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      const origin = String(request.headers.origin ?? '');
      const browserHeaders = origins.has(origin) ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        Vary: 'Origin',
      } : null;

      if (request.method === 'OPTIONS' && url.pathname === '/v1/pigeons') {
        if (!browserHeaders) return send(response, 403, { error: 'Origin is not allowed' });
        return send(response, 204, null, browserHeaders);
      }
      if (request.method === 'GET' && url.pathname === '/v1/pigeons') {
        if (!browserHeaders) return send(response, 403, { error: 'Origin is not allowed' });
        return send(response, 200, { version: 1, pigeons: publicPigeons(records) }, browserHeaders);
      }

      const authorization = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(authorization, token)) return send(response, 401, { error: 'Unauthorized' });
      if (request.method === 'GET' && url.pathname === '/v1/registrations') {
        const registrations = [...records.values()]
          .map(({ registrationId, repositoryId, repository, pid }) => ({ registrationId, repositoryId, repository, pid }))
          .sort((left, right) => left.repository.localeCompare(right.repository));
        return send(response, 200, { version: 1, registrations });
      }
      if (request.method === 'POST' && url.pathname === '/v1/register') {
        const registration = validateRegistration(await readJson(request));
        if (!registration) return send(response, 400, { error: 'Invalid watcher registration' });
        records.set(registration.registrationId, { ...registration, heartbeatAt: Date.now() });
        return send(response, 204, null);
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/v1/register/')) {
        records.delete(decodeURIComponent(url.pathname.slice('/v1/register/'.length)));
        return send(response, 204, null);
      }
      if (request.method === 'DELETE' && url.pathname === '/v1/service') {
        send(response, 204, null);
        setImmediate(onStop);
        return;
      }
      return send(response, 404, { error: 'Not found' });
    } catch (error) {
      return send(response, 400, { error: error?.message ?? 'Invalid request' });
    }
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function callBridge({ host, port, token, method, pathname, value }) {
  const body = value == null ? null : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host,
      port,
      method,
      path: pathname,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if ((response.statusCode ?? 500) >= 400) reject(new Error(`Browser bridge returned ${response.statusCode}`));
        else {
          const value = Buffer.concat(chunks).toString('utf8').trim();
          resolve(value ? JSON.parse(value) : null);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(1_000, () => request.destroy(new Error('Browser bridge timed out')));
    if (body) request.write(body);
    request.end();
  });
}

export async function registerBrowserBridge(repository, config, {
  host = BROWSER_BRIDGE_HOST,
  port = BROWSER_BRIDGE_PORT,
  token: tokenOverride,
  ensureService = port === BROWSER_BRIDGE_PORT,
} = {}) {
  const token = tokenOverride ?? await sharedToken();
  const registration = validateRegistration({
    registrationId: randomBytes(32).toString('hex'),
    repositoryId: config.repositoryId,
    secret: config.secret,
    deviceId: config.deviceId,
    repository: repository.root,
    pid: process.pid,
    name: path.basename(repository.root),
    signalingServer: config.signalingServer,
  });
  if (!registration) throw new Error('Could not register this Pigeon with the browser bridge');

  let closed = false;
  let working = false;
  const registerWithService = () => callBridge({ host, port, token, method: 'POST', pathname: '/v1/register', value: registration });
  if (ensureService) await ensureBrowserBridgeService({ host, port, token });
  await registerWithService();
  const tick = async () => {
    if (closed || working) return;
    working = true;
    try {
      try {
        await registerWithService();
      } catch {
        if (!ensureService) throw new Error('GitPigeon browser index is unavailable');
        await ensureBrowserBridgeService({ host, port, token });
        await registerWithService();
      }
    } finally {
      working = false;
    }
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, HEARTBEAT_MS);

  return {
    get port() { return port; },
    get owner() { return false; },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      while (working) await new Promise((resolve) => setTimeout(resolve, 10));
      await callBridge({
        host,
        port,
        token,
        method: 'DELETE',
        pathname: `/v1/register/${encodeURIComponent(registration.registrationId)}`,
      }).catch(() => {});
    },
  };
}

export async function startBrowserBridgeService({
  host = BROWSER_BRIDGE_HOST,
  port = BROWSER_BRIDGE_PORT,
  token: tokenOverride,
  origins = DEFAULT_ORIGINS,
} = {}) {
  const token = tokenOverride ?? await sharedToken();
  const records = new Map();
  let closed = false;
  let resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  const requestStop = () => resolveStop();
  const server = createServer(createHandler({ records, token, origins, onStop: requestStop }));
  await listen(server, host, port);
  const activePort = server.address().port;
  const prune = setInterval(() => {
    const cutoff = Date.now() - STALE_MS;
    for (const [id, record] of records) if (record.heartbeatAt < cutoff) records.delete(id);
  }, HEARTBEAT_MS);
  return {
    port: activePort,
    stopped,
    requestStop,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(prune);
      await closeServer(server);
    },
  };
}

export async function runBrowserBridgeService(options = {}) {
  const service = await startBrowserBridgeService(options);
  const stop = () => service.requestStop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await service.stopped;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await service.close();
  }
}

export async function ensureBrowserBridgeService({
  host = BROWSER_BRIDGE_HOST,
  port = BROWSER_BRIDGE_PORT,
  token: tokenOverride,
} = {}) {
  const token = tokenOverride ?? await sharedToken();
  try {
    await callBridge({ host, port, token, method: 'GET', pathname: '/v1/registrations' });
    return { started: false };
  } catch (error) {
    if (!['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code)) throw error;
  }

  const root = bridgeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const output = await open(path.join(root, 'browser-index.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [SERVICE_ENTRYPOINT], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', output.fd, output.fd],
    });
    child.unref();
  } finally {
    await output.close();
  }

  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await callBridge({ host, port, token, method: 'GET', pathname: '/v1/registrations' });
      return { started: true };
    } catch (error) {
      if (!['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('GitPigeon browser index did not start');
}

export async function stopBrowserBridgeService({
  host = BROWSER_BRIDGE_HOST,
  port = BROWSER_BRIDGE_PORT,
  token: tokenOverride,
} = {}) {
  const token = tokenOverride ?? await sharedToken();
  try {
    await callBridge({ host, port, token, method: 'DELETE', pathname: '/v1/service' });
    return true;
  } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code)) return false;
    throw error;
  }
}

export async function listBrowserBridgeRegistrations({
  host = BROWSER_BRIDGE_HOST,
  port = BROWSER_BRIDGE_PORT,
  token: tokenOverride,
} = {}) {
  const token = tokenOverride ?? await sharedToken();
  const value = await callBridge({ host, port, token, method: 'GET', pathname: '/v1/registrations' });
  if (!value || value.version !== 1 || !Array.isArray(value.registrations)) {
    throw new Error('Browser bridge returned an invalid watcher index');
  }
  return value.registrations.filter((registration) => (
    registration
    && typeof registration.repositoryId === 'string'
    && typeof registration.repository === 'string'
    && path.isAbsolute(registration.repository)
    && Number.isSafeInteger(registration.pid)
    && registration.pid > 0
  ));
}
