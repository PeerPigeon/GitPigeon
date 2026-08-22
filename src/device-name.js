import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import process from 'node:process';

export function deviceHostName({
  platform = process.platform,
  fallback = hostname(),
  readLocalHostName = () => execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
} = {}) {
  if (platform === 'darwin') {
    try {
      const local = String(readLocalHostName() ?? '').trim();
      if (local) return local.endsWith('.local') ? local : `${local}.local`;
    } catch {
      // Fall back to the OS hostname when SystemConfiguration is unavailable.
    }
  }
  return String(fallback ?? '').trim() || 'device';
}
