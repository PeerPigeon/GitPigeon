import { createServer } from 'node:http';
import { deviceHostName } from './device-name.js';
import { loadPairingKeyPair } from './pairing-identity.js';

/**
 * A loopback-only identity endpoint, so a browser on THIS machine can tell
 * which watcher in the mesh is the local one — the terminal shortcut should
 * open a shell here, not on whichever machine answered last. Browsers treat
 * http://127.0.0.1 as potentially trustworthy, so a secure page may fetch it.
 * It serves identity only: the service instance id is already public in
 * repository presence records.
 */
export const LOCAL_IDENTITY_PORTS = [47713, 47714, 47715, 47716];

export async function startLocalIdentityServer({ serviceInstanceId, machineIndexId = null, root, logger = {} } = {}) {
  // The machine's persistent unsea keypair IS the device signature — the same
  // identity its pairing code derives from. The claim binds the service
  // instance to the device key and is verifiable by anyone holding the public
  // half, so neither a name nor a service id can be impersonated.
  const keyPair = await loadPairingKeyPair(root);
  const { signMessage } = await import('unsea');
  const claim = `gitpigeon-device-claim/1\0${serviceInstanceId}`;
  const payload = JSON.stringify({
    protocol: 'gitpigeon-local/1',
    serviceInstanceId,
    machineIndexId,
    deviceName: deviceHostName(),
    devicePublicKey: keyPair.pub,
    deviceSignature: await signMessage(claim, keyPair.priv),
  });
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/gitpigeon-local-identity') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    response.end(payload);
  });
  server.unref?.();
  return new Promise((resolve) => {
    let index = 0;
    const attempt = () => {
      if (index >= LOCAL_IDENTITY_PORTS.length) {
        logger.debug?.('No loopback identity port was free; the terminal shortcut will fall back to judgement');
        resolve({ port: null, close: () => {} });
        return;
      }
      const port = LOCAL_IDENTITY_PORTS[index];
      index += 1;
      server.once('error', attempt);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', attempt);
        logger.debug?.(`Loopback identity on 127.0.0.1:${port}`);
        resolve({ port, close: () => server.close() });
      });
    };
    attempt();
  });
}
