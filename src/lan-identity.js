import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Which LAN this machine is on, as a name every machine on it derives alike.
 *
 * A fleet used to be found only through a phrase someone typed, once, per
 * machine. That is the right bar for admitting a stranger and the wrong one
 * for two machines that already know each other and are sitting on the same
 * Wi-Fi: after an index secret changes — and every machine changes its own
 * once, see rotateForExposureOnce — they go silently unreadable to each other
 * and the only way back is to type a phrase again on every one of them.
 *
 * So the LAN is the room. It is NOT the credential: every device on a LAN can
 * derive this same name, because a gateway address, its MAC and the subnet are
 * visible to everything on it. Membership is proved by a key each side pinned
 * during a real pairing (see fleet-peers.js); this only says where to meet.
 */
export const LAN_ROOM_PREFIX = 'gitpigeon-lan-v1';

/** The default gateway in `route -n get default` (macOS, BSD). */
export function parseBsdGateway(output) {
  const gateway = /^\s*gateway:\s*([0-9.]+)\s*$/m.exec(String(output ?? ''));
  const device = /^\s*interface:\s*(\S+)\s*$/m.exec(String(output ?? ''));
  return gateway ? { gateway: gateway[1], device: device?.[1] ?? null } : null;
}

/** The default gateway in `ip route show default` (Linux). */
export function parseIpRouteGateway(output) {
  const match = /\bdefault\s+via\s+([0-9.]+)(?:\s+dev\s+(\S+))?/.exec(String(output ?? ''));
  return match ? { gateway: match[1], device: match[2] ?? null } : null;
}

/** The default gateway in `route print -4` (Windows). */
export function parseWindowsGateway(output) {
  // "          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.23     35"
  const match = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([0-9.]+)\s+/m.exec(String(output ?? ''));
  return match ? { gateway: match[1], device: null } : null;
}

/**
 * The gateway's hardware address, from an ARP table in any of the three
 * platforms' formats. Two different LANs commonly share 192.168.1.0/24, and
 * this is what tells them apart.
 */
export function parseArpHardwareAddress(output, gateway) {
  const lines = String(output ?? '').split(/\r?\n/);
  const escaped = String(gateway ?? '').replace(/\./g, '\\.');
  if (!escaped) return null;
  const onGateway = new RegExp(`(?:^|[\\s(])${escaped}(?:[\\s)]|$)`);
  for (const line of lines) {
    if (!onGateway.test(line)) continue;
    // macOS/BSD "at 3c:37:86:0a:0b:0c", Linux "lladdr 3c:37:86:0a:0b:0c",
    // Windows "3c-37-86-0a-0b-0c".
    const mac = /\b([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})\b/i.exec(line);
    if (!mac) continue;
    const normalized = mac[1].toLowerCase().replace(/-/g, ':')
      .split(':').map((part) => part.padStart(2, '0')).join(':');
    // An incomplete entry prints as all zeroes or `(incomplete)`; it names no
    // LAN, and treating it as one would put every such machine in one room.
    if (/^(00:){5}00$/.test(normalized)) continue;
    return normalized;
  }
  return null;
}

/**
 * The IPv4 subnet this machine holds on the interface facing `gateway`, as
 * `network/prefix`. Used with the gateway so a LAN is still named when ARP is
 * unavailable, and so two LANs behind identically addressed gateways differ.
 */
export function subnetFor(gateway, interfaces = networkInterfaces()) {
  const target = ipToNumber(gateway);
  if (target === null) return null;
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      const address = ipToNumber(entry.address);
      const mask = ipToNumber(entry.netmask);
      if (address === null || mask === null) continue;
      if ((address & mask) !== (target & mask)) continue;
      const prefix = maskToPrefix(mask);
      if (prefix === null) continue;
      return `${numberToIp(address & mask)}/${prefix}`;
    }
  }
  return null;
}

function ipToNumber(value) {
  const parts = String(value ?? '').split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result * 256) + octet;
  }
  return result;
}

function numberToIp(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

function maskToPrefix(mask) {
  // Only a contiguous mask describes a subnet; anything else is not one.
  const inverted = (~mask) >>> 0;
  if (((inverted + 1) & inverted) !== 0) return null;
  let prefix = 0;
  for (let bit = 31; bit >= 0; bit -= 1) {
    if (!((mask >>> bit) & 1)) break;
    prefix += 1;
  }
  return prefix;
}

async function firstOutput(runCommand, attempts) {
  for (const [command, args] of attempts) {
    try {
      const { stdout } = await runCommand(command, args);
      if (stdout) return stdout;
    } catch { /* try the next form; absence is not an error here */ }
  }
  return null;
}

/**
 * This LAN's identity, or null when there is no usable one — no gateway, no
 * matching subnet, a captive interface. Null means "say nothing": a machine
 * that cannot name its LAN must not fall into a shared default room with
 * every other machine that cannot name its own.
 */
export async function lanIdentity({
  runCommand = execFileAsync,
  interfaces = networkInterfaces(),
  platform = process.platform,
} = {}) {
  const routeOutput = platform === 'win32'
    ? await firstOutput(runCommand, [['route', ['print', '-4']]])
    : await firstOutput(runCommand, [
      ['route', ['-n', 'get', 'default']],
      ['ip', ['route', 'show', 'default']],
    ]);
  if (!routeOutput) return null;
  const route = platform === 'win32'
    ? parseWindowsGateway(routeOutput)
    : parseBsdGateway(routeOutput) ?? parseIpRouteGateway(routeOutput);
  if (!route?.gateway) return null;
  const subnet = subnetFor(route.gateway, interfaces);
  if (!subnet) return null;
  const arpOutput = await firstOutput(runCommand, platform === 'win32'
    ? [['arp', ['-a']]]
    : [['arp', ['-n', route.gateway]], ['ip', ['neigh', 'show', route.gateway]]]);
  const hardwareAddress = arpOutput ? parseArpHardwareAddress(arpOutput, route.gateway) : null;
  return { gateway: route.gateway, subnet, hardwareAddress, device: route.device ?? null };
}

/**
 * The room name for a LAN: its subnet and gateway, and nothing else.
 *
 * The gateway's MAC used to be hashed in as well, to tell two homes on
 * 192.168.1.0/24 apart. It cannot be: an ARP entry is a cache, and whether it
 * is populated on one machine at the moment it starts has nothing to do with
 * which network it is on. Two machines on one LAN would compute two different
 * rooms and never meet — a coin flip dressed up as a distinguisher, and the
 * reason a fleet on one Wi-Fi could sit there announcing itself to nobody.
 *
 * Losing it costs nothing that matters. The room's name admits no one: it is
 * derivable by every device on the LAN anyway, and membership is a pinned key
 * (fleet-peers.js). Two homes that happen to name the same room see each
 * other's announcements and recognise nothing in them.
 */
export function lanRoomId(identity) {
  if (!identity?.subnet || !identity?.gateway) return null;
  const digest = createHash('sha256')
    .update('gitpigeon-lan-room/2\0')
    .update(String(identity.subnet))
    .update('\0')
    .update(String(identity.gateway))
    .digest('hex');
  return `${LAN_ROOM_PREFIX}-${digest.slice(0, 40)}`;
}

/** This machine's current LAN room, or null when its LAN cannot be named. */
export async function currentLanRoomId(options = {}) {
  return lanRoomId(await lanIdentity(options));
}
