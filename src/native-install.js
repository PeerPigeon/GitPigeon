import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const execFile = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  const errors = [];
  child.stdout?.on('data', (data) => output.push(data));
  child.stderr?.on('data', (data) => errors.push(data));
  child.once('error', reject);
  child.once('exit', (code) => code === 0
    ? resolve(Buffer.concat(output).toString('utf8'))
    : reject(new Error(`${command} exited with ${code}: ${Buffer.concat(errors).toString('utf8').trim()}`)));
});

const STANDALONE = typeof __GITPIGEON_STANDALONE__ === 'boolean'
  ? __GITPIGEON_STANDALONE__
  : process.env.GITPIGEON_STANDALONE === '1';

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function desktopQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function currentGitPigeonInvocation({
  execPath = process.execPath,
  argv = process.argv,
} = {}) {
  if (STANDALONE) return [execPath];
  const script = argv[1] && /git-pigeon(?:\.js)?$/i.test(path.basename(argv[1]))
    ? path.resolve(argv[1])
    : null;
  return script ? [execPath, script] : [execPath];
}

function shellCommand(invocation, trailing = '') {
  return `${invocation.map(shellQuote).join(' ')}${trailing}`;
}

// Mirrors machineIndexRoot() for the platform the shim will run on.
function shimStateDirExpression(platform) {
  return platform === 'darwin'
    ? '"${GITPIGEON_STATE_DIR:-$HOME/Library/Application Support/GitPigeon}"'
    : '"${GITPIGEON_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gitpigeon}"';
}

// The shim must chase the automatically updated build at run time. Baking in
// the install-time binary left `git pigeon` answering as an old build forever:
// automatic updates replace the running service but never rewrite /usr/local.
function shimScript(invocation, platform, trailing) {
  return `#!/bin/sh
current=${shimStateDirExpression(platform)}/updates/current.json
if [ -f "$current" ]; then
  target=$(sed -n 's/.*"executable"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$current")
  if [ -n "$target" ] && [ -x "$target" ]; then
    exec "$target"${trailing}
  fi
fi
exec ${shellCommand(invocation, trailing)}
`;
}

async function installMacOS(invocation, home, run) {
  const localBin = path.join(home, '.local', 'bin');
  const commandPath = path.join(localBin, 'git-pigeon');
  const appRoot = path.join(home, 'Applications', 'GitPigeon.app');
  const contents = path.join(appRoot, 'Contents');
  const macos = path.join(contents, 'MacOS');
  await mkdir(localBin, { recursive: true, mode: 0o755 });
  await mkdir(macos, { recursive: true, mode: 0o755 });
  await writeFile(commandPath, shimScript(invocation, 'darwin', ' "$@"'), { mode: 0o755 });
  await chmod(commandPath, 0o755);
  const handlerPath = path.join(macos, 'git-pigeon-handler');
  await writeFile(handlerPath, shimScript(invocation, 'darwin', ' protocol "$1"'), { mode: 0o755 });
  await chmod(handlerPath, 0o755);
  await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>GitPigeon</string>
<key>CFBundleExecutable</key><string>git-pigeon-handler</string>
<key>CFBundleIdentifier</key><string>dev.gitpigeon.native</string>
<key>CFBundleName</key><string>GitPigeon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleURLTypes</key><array><dict>
<key>CFBundleURLName</key><string>dev.gitpigeon.clone</string>
<key>CFBundleURLSchemes</key><array><string>gitpigeon</string></array>
</dict></array>
</dict></plist>\n`, { mode: 0o644 });
  const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  await run(launchServices, ['-f', appRoot]);
  return { commandPath, handler: appRoot };
}

async function installLinux(invocation, home, run) {
  const localBin = path.join(home, '.local', 'bin');
  const commandPath = path.join(localBin, 'git-pigeon');
  const applications = path.join(home, '.local', 'share', 'applications');
  const desktop = path.join(applications, 'gitpigeon.desktop');
  await mkdir(localBin, { recursive: true, mode: 0o755 });
  await mkdir(applications, { recursive: true, mode: 0o755 });
  await writeFile(commandPath, shimScript(invocation, 'linux', ' "$@"'), { mode: 0o755 });
  await chmod(commandPath, 0o755);
  await writeFile(desktop, `[Desktop Entry]
Name=GitPigeon
Comment=Clone an encrypted GitPigeon repository
Exec=${desktopQuote(commandPath)} protocol %u
Terminal=false
Type=Application
MimeType=x-scheme-handler/gitpigeon;
NoDisplay=true
Categories=Development;
`, { mode: 0o644 });
  try { await run('xdg-mime', ['default', 'gitpigeon.desktop', 'x-scheme-handler/gitpigeon']); } catch { /* desktop session may register it later */ }
  try { await run('update-desktop-database', [applications]); } catch { /* optional */ }
  return { commandPath, handler: desktop };
}

async function windowsUserPath(run) {
  try {
    const output = await run('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path']);
    return output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^Path\s+REG_/i.test(line))
      ?.replace(/^Path\s+REG_\w+\s+/i, '') ?? '';
  } catch {
    return '';
  }
}

async function installWindows(invocation, environment, run) {
  const root = path.join(environment.LOCALAPPDATA ?? environment.APPDATA ?? os.homedir(), 'GitPigeon', 'bin');
  const commandPath = path.join(root, 'git-pigeon.cmd');
  await mkdir(root, { recursive: true });
  const command = invocation.map((part) => `"${String(part).replaceAll('"', '""')}"`).join(' ');
  await writeFile(commandPath, `@echo off\r\n${command} %*\r\n`);
  const handler = `${command} protocol "%1"`;
  await run('reg.exe', ['add', 'HKCU\\Software\\Classes\\gitpigeon', '/ve', '/d', 'URL:GitPigeon Protocol', '/f']);
  await run('reg.exe', ['add', 'HKCU\\Software\\Classes\\gitpigeon', '/v', 'URL Protocol', '/d', '', '/f']);
  await run('reg.exe', ['add', 'HKCU\\Software\\Classes\\gitpigeon\\shell\\open\\command', '/ve', '/d', handler, '/f']);
  const currentPath = await windowsUserPath(run);
  const pieces = currentPath.split(';').filter(Boolean);
  if (!pieces.some((entry) => entry.toLocaleLowerCase() === root.toLocaleLowerCase())) {
    await run('reg.exe', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', [...pieces, root].join(';'), '/f']);
  }
  return { commandPath, handler: 'HKCU\\Software\\Classes\\gitpigeon' };
}

export async function installNativeIntegration({
  platform = process.platform,
  home = os.homedir(),
  environment = process.env,
  invocation = currentGitPigeonInvocation(),
  run = execFile,
} = {}) {
  if (platform === 'darwin') return await installMacOS(invocation, home, run);
  if (platform === 'win32') return await installWindows(invocation, environment, run);
  return await installLinux(invocation, home, run);
}

// A watcher that dies for any reason — a crashed restart, a stale lock, a
// panic — used to stay down until a person ran `git pigeon start` by hand.
// launchd is the supervisor macOS already ships: this agent runs
// `git-pigeon start` once a minute, which no-ops while the service is
// healthy and revives it when it is not. Worst-case downtime becomes one
// minute instead of forever, with no change to how the service itself runs.
const WATCHDOG_LABEL = 'dev.gitpigeon.watchdog';

export function watchdogPlist(commandPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${WATCHDOG_LABEL}</string>
<key>ProgramArguments</key><array>
<string>${commandPath}</string>
<string>start</string>
</array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>60</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

export async function ensureServiceWatchdog({
  platform = process.platform,
  home = os.homedir(),
  commandPath = path.join(os.homedir(), '.local', 'bin', 'git-pigeon'),
  uid = process.getuid?.(),
  run = execFile,
} = {}) {
  if (platform !== 'darwin' || uid === undefined) return null;
  const agents = path.join(home, 'Library', 'LaunchAgents');
  const plist = path.join(agents, `${WATCHDOG_LABEL}.plist`);
  const content = watchdogPlist(commandPath);
  let existing = null;
  try { existing = await readFile(plist, 'utf8'); } catch { /* not installed yet */ }
  const changed = existing !== content;
  if (changed) {
    await mkdir(agents, { recursive: true, mode: 0o755 });
    await writeFile(plist, content, { mode: 0o644 });
  }
  let loaded = false;
  try {
    await run('launchctl', ['print', `gui/${uid}/${WATCHDOG_LABEL}`]);
    loaded = true;
  } catch { /* not loaded */ }
  // Reload only when something actually changed: a bootout kills the agent's
  // in-flight process, and the agent's own `start` invocation runs this very
  // code — an unconditional reload would have it terminate itself mid-start.
  if (changed && loaded) {
    try { await run('launchctl', ['bootout', `gui/${uid}/${WATCHDOG_LABEL}`]); } catch { /* already gone */ }
    loaded = false;
  }
  if (!loaded) await run('launchctl', ['bootstrap', `gui/${uid}`, plist]);
  return { plist, changed };
}

// `git pigeon stop` means STOPPED: without this, the watchdog would revive
// the service within a minute of the person asking it to stay down.
export async function removeServiceWatchdog({
  platform = process.platform,
  home = os.homedir(),
  uid = process.getuid?.(),
  run = execFile,
} = {}) {
  if (platform !== 'darwin' || uid === undefined) return null;
  const plist = path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
  try { await run('launchctl', ['bootout', `gui/${uid}/${WATCHDOG_LABEL}`]); } catch { /* not loaded */ }
  await rm(plist, { force: true });
  return { plist };
}

// Rewrites just the `git pigeon` command shim. The service calls this on
// every start so machines installed before the shim chased current.json heal
// themselves on the next automatic update, with nobody running `install`.
// Windows is untouched: its .cmd wrapper cannot resolve JSON portably, and the
// installed binary there delegates to the newest update by itself.
export async function refreshNativeCommandShim({
  platform = process.platform,
  home = os.homedir(),
  invocation = currentGitPigeonInvocation(),
} = {}) {
  if (platform === 'win32') return null;
  const localBin = path.join(home, '.local', 'bin');
  const commandPath = path.join(localBin, 'git-pigeon');
  await mkdir(localBin, { recursive: true, mode: 0o755 });
  await writeFile(commandPath, shimScript(invocation, platform, ' "$@"'), { mode: 0o755 });
  await chmod(commandPath, 0o755);
  return { commandPath };
}
