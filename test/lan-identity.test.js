import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lanIdentity,
  lanRoomId,
  parseArpHardwareAddress,
  parseBsdGateway,
  parseIpRouteGateway,
  parseWindowsGateway,
  subnetFor,
} from '../src/lan-identity.js';

const INTERFACES = {
  lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
  en0: [
    { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff::' },
    { family: 'IPv4', internal: false, address: '192.168.50.37', netmask: '255.255.255.0' },
  ],
};

test('a default gateway is read from any of the three platforms\' routing tables', () => {
  assert.deepEqual(parseBsdGateway('   route to: default\n  gateway: 192.168.50.1\ninterface: en0\n'),
    { gateway: '192.168.50.1', device: 'en0' });
  assert.deepEqual(parseIpRouteGateway('default via 10.0.0.1 dev wlan0 proto dhcp metric 600'),
    { gateway: '10.0.0.1', device: 'wlan0' });
  assert.deepEqual(parseWindowsGateway('Network Destination        Netmask          Gateway       Interface  Metric\n          0.0.0.0          0.0.0.0      192.168.1.1     192.168.1.23     35\n'),
    { gateway: '192.168.1.1', device: null });
  assert.equal(parseBsdGateway('no default route here'), null);
  assert.equal(parseIpRouteGateway(''), null);
});

test('the gateway\'s hardware address is read from every ARP format, and an incomplete entry is not one', () => {
  assert.equal(
    parseArpHardwareAddress('? (192.168.50.1) at cc:28:aa:60:33:f8 on en0 ifscope [ethernet]', '192.168.50.1'),
    'cc:28:aa:60:33:f8',
  );
  assert.equal(
    parseArpHardwareAddress('10.0.0.1 dev wlan0 lladdr 3c:37:86:0a:0b:0c REACHABLE', '10.0.0.1'),
    '3c:37:86:0a:0b:0c',
  );
  // Windows dashes, and a short octet that must be padded, or two machines
  // would name the same LAN differently and never meet.
  assert.equal(
    parseArpHardwareAddress('  192.168.1.1           3c-37-86-0a-b-0c     dynamic', '192.168.1.1'),
    '3c:37:86:0a:0b:0c',
  );
  assert.equal(parseArpHardwareAddress('? (192.168.50.1) at (incomplete) on en0', '192.168.50.1'), null);
  assert.equal(parseArpHardwareAddress('? (192.168.50.1) at 00:00:00:00:00:00 on en0', '192.168.50.1'), null);
  // Another host's entry is not the gateway's.
  assert.equal(parseArpHardwareAddress('? (192.168.50.9) at cc:28:aa:60:33:f8 on en0', '192.168.50.1'), null);
});

test('the subnet is the one facing the gateway, and only a contiguous mask is one', () => {
  assert.equal(subnetFor('192.168.50.1', INTERFACES), '192.168.50.0/24');
  assert.equal(subnetFor('10.1.2.3', INTERFACES), null);
  assert.equal(subnetFor('192.168.50.1', {
    en0: [{ family: 'IPv4', internal: false, address: '192.168.50.37', netmask: '255.0.255.0' }],
  }), null);
});

test('a LAN with no nameable gateway produces no room, so such machines never share a default one', async () => {
  const noRoute = await lanIdentity({
    runCommand: async () => { throw new Error('route: command not found'); },
    interfaces: INTERFACES,
    platform: 'darwin',
  });
  assert.equal(noRoute, null);
  assert.equal(lanRoomId(noRoute), null);
  assert.equal(lanRoomId({ subnet: '192.168.50.0/24' }), null);

  // A gateway on no local subnet is not this machine's LAN either.
  const elsewhere = await lanIdentity({
    runCommand: async () => ({ stdout: 'gateway: 172.16.9.1\ninterface: utun3\n' }),
    interfaces: INTERFACES,
    platform: 'darwin',
  });
  assert.equal(elsewhere, null);
});

test('two machines on one LAN name the same room, and a different LAN is a different room', async () => {
  const lan = async (arp) => await lanIdentity({
    runCommand: async (command, args) => {
      if (command === 'route') return { stdout: 'gateway: 192.168.50.1\ninterface: en0\n' };
      if (command === 'arp') return { stdout: arp };
      throw new Error(`unexpected ${command} ${args?.join(' ')}`);
    },
    interfaces: INTERFACES,
    platform: 'darwin',
  });
  const here = await lan('? (192.168.50.1) at cc:28:aa:60:33:f8 on en0 ifscope [ethernet]');
  const alsoHere = await lan('? (192.168.50.1) at CC:28:AA:60:33:F8 on en1 ifscope [ethernet]');
  const otherHome = await lan('? (192.168.50.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]');
  assert.equal(here.hardwareAddress, 'cc:28:aa:60:33:f8');
  assert.equal(lanRoomId(here), lanRoomId(alsoHere));
  assert.notEqual(lanRoomId(here), lanRoomId(otherHome));
  assert.match(lanRoomId(here), /^gitpigeon-lan-v1-[0-9a-f]{40}$/);

  // The room name never contains the LAN it describes.
  const room = lanRoomId(here);
  assert.doesNotMatch(room, /192\.168|cc:28/);

  // ARP unavailable: still a room, from gateway and subnet alone, so a
  // firewalled machine is not excluded from its own fleet.
  const noArp = await lanIdentity({
    runCommand: async (command) => {
      if (command === 'route') return { stdout: 'gateway: 192.168.50.1\ninterface: en0\n' };
      throw new Error('arp: not permitted');
    },
    interfaces: INTERFACES,
    platform: 'darwin',
  });
  assert.equal(noArp.hardwareAddress, null);
  assert.match(lanRoomId(noArp), /^gitpigeon-lan-v1-[0-9a-f]{40}$/);
  assert.notEqual(lanRoomId(noArp), lanRoomId(here));
});
