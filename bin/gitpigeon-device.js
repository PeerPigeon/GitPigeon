#!/usr/bin/env node

function roster() {
  try {
    const value = JSON.parse(Buffer.from(process.env.GITPIGEON_DEVICE_ROSTER ?? '', 'base64url').toString('utf8'));
    if (!Array.isArray(value) || !value.length || value.length > 64) return [];
    return value.map((entry) => String(entry?.name ?? 'device').slice(0, 120));
  } catch {
    return [];
  }
}

const devices = roster();
const [command] = process.argv.slice(2);

if (!command || command === 'list') {
  if (!devices.length) {
    console.error('No GitPigeon terminal devices are available.');
    process.exitCode = 1;
  } else {
    devices.forEach((name, index) => console.log(`${index}  ${index === 0 ? '[this device] ' : ''}${name}`));
  }
} else if (/^\d+$/.test(command) && Number(command) < devices.length) {
  process.stdout.write(`\u001b]777;gitpigeon-device=${Number(command)}\u0007`);
} else {
  console.error('Usage: device list | device <number>');
  process.exitCode = 1;
}
