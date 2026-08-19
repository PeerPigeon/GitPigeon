const DEVELOPMENT_RELAY_HOSTS = new Set([
  'freertc-worker-dev.draeder.workers.dev',
]);

export function productionSignalingServers(servers) {
  if (!Array.isArray(servers)) return [];
  const candidates = servers.map(String).filter(Boolean);
  const production = candidates.filter((server) => {
    try {
      return !DEVELOPMENT_RELAY_HOSTS.has(new URL(server).hostname);
    } catch {
      return false;
    }
  });
  return production.length > 0 ? production : candidates;
}
