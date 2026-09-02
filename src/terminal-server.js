import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { machineIndexRoot } from './machine-index.js';
import { terminalHistorySpoolPath } from './terminal-history.js';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  TERMINAL_CHANNEL,
  deviceTerminalRoom,
  onChannelMessage,
  sendChannelDirect,
} from './channel.js';

const STANDALONE = typeof __GITPIGEON_STANDALONE__ !== 'undefined' && __GITPIGEON_STANDALONE__;

// The terminal used to wrap each frame in its own AES-256-GCM envelope keyed by
// `sha256('gitpigeon:terminal:v1\0' + secret)`. PeerPigeon's encrypted direct
// messages provide the same authenticated confidentiality from the same secret.
export const TERMINAL_PROTOCOL = 'gitpigeon/terminal/1';

const SESSION = /^[a-f0-9]{32}$/;
const MAX_SESSIONS = 4;
const MAX_SESSIONS_PER_PEER = 1;
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_DEVICES = 64;
const OUTPUT_CHUNK_BYTES = 16 * 1024;
const OUTPUT_BATCH_MS = 8;
const SESSION_TIMEOUT_MS = 60_000;
const SWEEP_MS = 15_000;
const BIN_DIRECTORY = STANDALONE ? null : fileURLToPath(new URL('../bin', import.meta.url));
const DEVICE_COMMAND = STANDALONE
  ? [process.execPath]
  : [process.execPath, fileURLToPath(new URL('../bin/git-pigeon.js', import.meta.url))];

function quoteShell(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * A real pty from the standalone binary.
 *
 * The executable embeds node-pty's prebuilt `pty.node` and `spawn-helper` as
 * SEA assets; they are written next to the machine state on first use and the
 * addon is driven directly. The previous fallback pretended to be a terminal
 * through /usr/bin/script, which calls tcgetattr on its stdin — a pipe, in a
 * daemon — and exits 1 before the shell ever runs. The shipped binary never
 * had a working terminal on macOS at all.
 */
let embeddedPtyPromise = null;

async function embeddedPty() {
  embeddedPtyPromise ??= (async () => {
    const { getAsset } = await import('node:sea');
    const { machineIndexRoot } = await import('./machine-index.js');
    const { GITPIGEON_VERSION } = await import('./version.js');
    const directory = path.join(machineIndexRoot(), 'pty', GITPIGEON_VERSION);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = {};
    for (const name of ['pty.node', 'spawn-helper']) {
      const target = path.join(directory, name);
      try {
        await stat(target);
      } catch {
        await writeFile(target, Buffer.from(getAsset(`pty/${name}`)), { mode: 0o755 });
      }
      await chmod(target, 0o755);
      files[name] = target;
    }
    const require = createRequire(pathToFileURL(path.join(directory, 'entry.cjs')));
    return { native: require(files['pty.node']), helperPath: files['spawn-helper'] };
  })();
  return await embeddedPtyPromise;
}

async function portablePty(shell, args, options) {
  const { native, helperPath } = await embeddedPty();
  const tty = await import('node:tty');
  const env = { ...options.env, TERM: options.env?.TERM ?? 'xterm-256color' };
  const parsedEnv = Object.keys(env)
    .filter((key) => env[key] !== undefined)
    .map((key) => `${key}=${env[key]}`);
  const dataListeners = new Set();
  const exitListeners = new Set();
  let exited = false;
  const term = native.fork(
    shell,
    args,
    parsedEnv,
    options.cwd,
    options.cols,
    options.rows,
    -1,
    -1,
    true,
    helperPath,
    (exitCode, signal) => {
      exited = true;
      for (const listener of exitListeners) listener({ exitCode, signal });
    },
  );
  const socket = new tty.ReadStream(term.fd);
  socket.setEncoding('utf8');
  socket.on('data', (data) => {
    for (const listener of dataListeners) listener(data);
  });
  // fs read streams on a pty fd report EAGAIN early and EIO on exit.
  socket.on('error', (error) => {
    if (String(error?.code ?? '').includes('EAGAIN')) return;
    socket.destroy();
  });
  return {
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    write(data) { if (!exited) socket.write(data); },
    resize(cols, rows) {
      try { native.resize(term.fd, cols, rows); } catch { /* exited */ }
    },
    kill() {
      try { process.kill(term.pid, 'SIGHUP'); } catch { /* exited */ }
      socket.destroy();
    },
  };
}

/**
 * node-pty execs a small `spawn-helper` binary on macOS and Linux, and the
 * execute bit is set by its install script. This repository's `.npmrc` sets
 * `ignore-scripts=true` to keep PeerPigeon and FreeRTC pinned, so that script
 * never runs and the helper ships without it — every terminal then failed with
 * a bare "posix_spawnp failed". Restore the bit rather than requiring a
 * separate `npm rebuild` that the pinning is there to avoid.
 */
async function ensureSpawnHelper(ptyModule) {
  if (process.platform === 'win32') return;
  const root = ptyModule?.default?.__dirname ?? null;
  const candidates = [];
  const prebuild = `${process.platform}-${process.arch}`;
  for (const base of [
    root,
    fileURLToPath(new URL('../node_modules/node-pty', import.meta.url)),
  ].filter(Boolean)) {
    candidates.push(path.join(base, 'prebuilds', prebuild, 'spawn-helper'));
    candidates.push(path.join(base, 'build', 'Release', 'spawn-helper'));
  }
  for (const candidate of candidates) {
    try {
      const details = await stat(candidate);
      if (details.mode & 0o111) return;
      await chmod(candidate, 0o755);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

let spawnHelperReady = null;

async function spawnPty(shell, args, options) {
  if (STANDALONE) return await portablePty(shell, args, options);
  const pty = await import('node-pty');
  spawnHelperReady ??= ensureSpawnHelper(pty).catch(() => { /* surfaced by the spawn below */ });
  await spawnHelperReady;
  return pty.spawn(shell, args, options);
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function cleanDeviceName(value) {
  const name = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return (name || 'device').slice(0, 120);
}

function validRoster(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DEVICES) return null;
  return value.map((entry) => ({ name: cleanDeviceName(entry?.name) }));
}

// Printed by the initialization line once the prompt is configured and the
// screen cleared. Everything the shell emits before it — startup noise, the
// echoed setup command itself — is swallowed server-side: the session's
// output stream, and therefore its replayable history, begins at the clean
// prompt. The marker is an OSC sequence no terminal renders, and the echoed
// source text (backslash escapes, not raw bytes) can never match it.
const READY_MARKER = '\u001b]777;gitpigeon-ready\u0007';
const READY_TIMEOUT_MS = 4_000;
const READY_MAX_BYTES = 65_536;

async function shellCommand(deviceName) {
  // "Daniels-MacBook-Pro [../test/*] $" — a dimmed machine name (context),
  // the live directory in normal weight (the thing you check), and a bold
  // accent-green $ as the anchor. The brand lives in the UI chrome, not on
  // every prompt line. 38;2;216;255;88 is the terminal theme's cursor green.
  //
  // None of this is ever TYPED into the shell. The setup used to be written
  // to the pty as an input line, which the shell echoed into the session and
  // recorded into its own command history — the "preamble" on every open,
  // recalled forever by an up-arrow. Setup travels through startup files and
  // spawn arguments instead: zsh reads it from a ZDOTDIR wrapper, bash from
  // an --rcfile, PowerShell and cmd take it as a command argument. The shell
  // never sees it as input, so it can't echo it and can't remember it.
  const shortName = String(deviceName).replace(/\.local$/i, '');
  const deviceCommand = DEVICE_COMMAND.map((value) => quoteShell(value)).join(' ');
  if (process.platform === 'win32') {
    const shell = process.env.COMSPEC || 'powershell.exe';
    const powershell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell);
    const esc = '$([char]27)';
    const psPrompt = `${esc}[2m${shortName}${esc}[0m [../$(Split-Path -Leaf (Get-Location))/*] ${esc}[1;38;2;216;255;88m$${esc}[0m `;
    // cmd has no ANSI in PROMPT reliably; plain text there.
    const cmdPrompt = `${shortName} [../$P/*] $$ `;
    if (powershell) {
      return {
        shell,
        flavor: 'powershell',
        args: ['-NoExit', '-Command',
          `function global:device { & ${deviceCommand} terminal-device @args }; $function:prompt = { "${psPrompt.replaceAll('"', '`"')}" }; Clear-Host; [Console]::Write([char]27+']777;gitpigeon-ready'+[char]7)`],
        env: {},
        initialize: '',
      };
    }
    return {
      shell,
      flavor: 'cmd',
      args: ['/K', `doskey device=${DEVICE_COMMAND.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')} terminal-device $*& prompt ${cmdPrompt.replaceAll('&', '^&')}& cls`],
      env: {},
      initialize: '',
    };
  }
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
  const zsh = /(?:^|\/)zsh$/.test(shell);
  const bash = /(?:^|\/)bash$/.test(shell);
  // Zero-width escape wrapping (%{...%} / \[...\]) keeps line editing from
  // miscounting the prompt width. \W and %1~ track the directory live.
  const dim = '\\033[2m';
  const accent = '\\033[1;38;2;216;255;88m';
  const reset = '\\033[0m';
  const zshPrompt = `%{${dim}%}${shortName}%{${reset}%} [../%1~/*] %{${accent}%}$%{${reset}%} `.replaceAll("'", "'\\''");
  const bashPrompt = `\\[${dim}\\]${shortName}\\[${reset}\\] [../\\W/*] \\[${accent}\\]$\\[${reset}\\] `.replaceAll("'", "'\\''");
  // The rc tail: define the device helper, set the prompt, take over
  // history, then clear the screen (rc banners are gated out server-side,
  // but they still moved the cursor) and print the ready marker that opens
  // the output gate.
  //
  // Terminal history is MESH ONLY. HISTFILE is unset after the user's rc
  // runs, so the shell never reads the user's history file (where old
  // builds' typed setup lines kept resurfacing) and never writes anywhere.
  // Instead the session's in-memory history is seeded from the fleet-wide
  // record GitPigeon carries in PeerPigeon storage (GITPIGEON_HISTORY, one
  // command per line), and every accepted command line is reported back
  // through an invisible OSC frame the server strips from the output stream
  // and merges into that record — so a command typed on any device is
  // recallable on every device.
  // Live fleet-wide history: HISTFILE points at GitPigeon's spool — a local
  // projection of the mesh record that the watcher appends to as commands
  // arrive from other devices. zsh SHARE_HISTORY imports new spool lines on
  // every history access, so a command typed on another machine is one
  // up-arrow away in an already-open shell here. Local commands reach the
  // mesh through the capture hook and reach this spool through the shell's
  // own HISTFILE writes.
  const spoolPath = terminalHistorySpoolPath(machineIndexRoot());
  const emitCapture = `printf '\\033]777;gitpigeon-hist;%s\\a' "$(printf %s "$gitpigeon_line" | command base64 | command tr -d '\\n')"`;
  const posixTail = (promptVariable, promptValue, flavor) => [
    `device() { ${deviceCommand} terminal-device "$@"; }`,
    `export ${promptVariable}=$'${promptValue}'`,
    `export HISTFILE=${quoteShell(spoolPath)}`,
    'export HISTSIZE=10000',
    // A line that starts with a space is plumbing, not a command anyone
    // typed — the dashboard's `cd` on a repository switch — and stays out
    // of both the shell's history and the fleet-wide record.
    ...(flavor === 'zsh' ? [
      'SAVEHIST=10000',
      'setopt SHARE_HISTORY HIST_IGNORE_SPACE 2>/dev/null',
      'gitpigeon_capture_history() {',
      `  local gitpigeon_line=\${1%$'\\n'}`,
      '  [ -n "$gitpigeon_line" ] || return 0',
      "  case $gitpigeon_line in ' '*) return 0;; esac",
      `  ${emitCapture}`,
      '  return 0',
      '}',
      'zshaddhistory_functions+=(gitpigeon_capture_history)',
    ] : [
      'export HISTFILESIZE=10000',
      'export HISTCONTROL=ignorespace${HISTCONTROL:+:$HISTCONTROL}',
      'GITPIGEON_LAST_CAPTURE=$(builtin fc -ln -1 2>/dev/null)',
      'GITPIGEON_LAST_CAPTURE=${GITPIGEON_LAST_CAPTURE#"${GITPIGEON_LAST_CAPTURE%%[![:space:]]*}"}',
      'gitpigeon_capture_history() {',
      '  local gitpigeon_line=$(builtin fc -ln -1 2>/dev/null)',
      '  gitpigeon_line=${gitpigeon_line#"${gitpigeon_line%%[![:space:]]*}"}',
      '  { [ -n "$gitpigeon_line" ] && [ "$gitpigeon_line" != "$GITPIGEON_LAST_CAPTURE" ]; } || return 0',
      '  GITPIGEON_LAST_CAPTURE=$gitpigeon_line',
      `  ${emitCapture}`,
      '}',
      'PROMPT_COMMAND="gitpigeon_capture_history; builtin history -a; builtin history -n${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
    ]),
    `printf '\\033[2J\\033[3J\\033[H\\033]777;gitpigeon-ready\\a'`,
    '',
  ].join('\n');
  if (zsh) {
    // A ZDOTDIR wrapper: each stage sources the user's own file first, then
    // .zshrc appends the session setup and restores the user's ZDOTDIR.
    const directory = path.join(machineIndexRoot(), 'shell', 'zdot');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bounce = (file) => [
      'GITPIGEON_WRAP_ZDOTDIR="$ZDOTDIR"',
      'ZDOTDIR="${GITPIGEON_USER_ZDOTDIR:-$HOME}"',
      `[ -f "$ZDOTDIR/${file}" ] && builtin source "$ZDOTDIR/${file}"`,
      'GITPIGEON_USER_ZDOTDIR="$ZDOTDIR"',
      'ZDOTDIR="$GITPIGEON_WRAP_ZDOTDIR"',
      '',
    ].join('\n');
    await writeFile(path.join(directory, '.zshenv'), bounce('.zshenv'), { mode: 0o600 });
    await writeFile(path.join(directory, '.zprofile'), bounce('.zprofile'), { mode: 0o600 });
    await writeFile(path.join(directory, '.zshrc'), [
      'ZDOTDIR="${GITPIGEON_USER_ZDOTDIR:-$HOME}"',
      '[ -f "$ZDOTDIR/.zshrc" ] && builtin source "$ZDOTDIR/.zshrc"',
      'unset GITPIGEON_USER_ZDOTDIR GITPIGEON_WRAP_ZDOTDIR',
      posixTail('PROMPT', zshPrompt, 'zsh'),
    ].join('\n'), { mode: 0o600 });
    return {
      shell,
      flavor: 'zsh',
      args: [],
      env: { ZDOTDIR: directory, GITPIGEON_USER_ZDOTDIR: process.env.ZDOTDIR || homedir() },
      initialize: '',
    };
  }
  if (bash) {
    const directory = path.join(machineIndexRoot(), 'shell');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const rcfile = path.join(directory, 'gitpigeon.bashrc');
    await writeFile(rcfile, [
      '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"',
      posixTail('PS1', bashPrompt, 'bash'),
    ].join('\n'), { mode: 0o600 });
    return { shell, flavor: 'bash', args: ['--rcfile', rcfile], env: {}, initialize: '' };
  }
  // An unknown shell falls back to typing the setup; the output gate hides
  // the echo, though the shell's own history may keep the line.
  return {
    shell,
    flavor: 'sh',
    args: [],
    env: {},
    initialize: `device() { ${deviceCommand} terminal-device "$@"; }; export PS1=$'${bashPrompt}'; export HISTFILE=${quoteShell(spoolPath)}; clear; printf '\\033]777;gitpigeon-ready\\a'\r`,
  };
}


/**
 * The line that moves a running shell into a directory. It is typed with a
 * leading space so the shell's own history and the mesh record both skip
 * it (HIST_IGNORE_SPACE / HISTCONTROL=ignorespace above).
 */
export function changeDirectoryLine(flavor, directory) {
  if (flavor === 'powershell') return ` Set-Location -LiteralPath '${String(directory).replaceAll("'", "''")}'\r`;
  if (flavor === 'cmd') return ` cd /d "${String(directory).replaceAll('"', '')}"\r`;
  return ` cd ${quoteShell(directory)}\r`;
}

/**
 * One shell server per watcher process.
 *
 * The terminal belongs to the DEVICE. There used to be one of these per
 * repository, each with its own sessions and its own shell, so the same
 * machine showed a different terminal behind every repository and the view
 * went "unavailable" whenever the active repository's room happened to be
 * down. Now a single server listens on the device room — reachable from
 * whichever repository a browser is viewing, or none — and on every
 * registered repository's terminal channel for dashboards that still dial
 * by repository. Whichever road a frame takes, it lands in the same session
 * table. Repositories only contribute a working directory: the one a
 * session opens in, and the one it `cd`s to when the dashboard switches.
 */
export class TerminalServer {
  constructor({ node, serviceInstanceId, deviceName = hostname(), logger = {}, spawnPty: spawnTerminal = spawnPty, history = null, repositories = [] }) {
    this.node = node;
    this.serviceInstanceId = serviceInstanceId;
    this.deviceName = cleanDeviceName(deviceName);
    this.logger = logger;
    this.spawnPty = spawnTerminal;
    this.history = history;
    this.sessions = new Map();
    // Opens in flight, by session id: the same open arrives on every road
    // at once and must spawn ONE shell, not one per road.
    this.opening = new Set();
    this.relayReplies = new Map();
    // repositoryId -> [{ root }]: several local clones may register the same
    // repository; the first is the working directory of record and the
    // channel stays open while any remain.
    this.repositories = new Map();
    this.subscriptions = new Map();
    this.started = false;
    this.sweepTimer = null;
    for (const repository of repositories) this.addRepository(repository);
  }

  get deviceRoom() {
    return deviceTerminalRoom(this.serviceInstanceId);
  }

  /**
   * Serve a repository: its terminal channel routes here and its root is a
   * working directory browsers can name. Returns a lease; releasing the last
   * lease for a repository stops listening on its channel.
   */
  addRepository({ repositoryId, root }) {
    const id = String(repositoryId ?? '');
    if (!id) throw new Error('A terminal repository needs a repositoryId');
    const entry = { root: String(root ?? '') };
    this.repositories.set(id, [...(this.repositories.get(id) ?? []), entry]);
    if (this.started) this.#listen(id);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const remaining = (this.repositories.get(id) ?? []).filter((candidate) => candidate !== entry);
        if (remaining.length) {
          this.repositories.set(id, remaining);
          return;
        }
        this.repositories.delete(id);
        this.subscriptions.get(id)?.();
        this.subscriptions.delete(id);
      },
    };
  }

  repositoryRoot(repositoryId) {
    return this.repositories.get(String(repositoryId ?? ''))?.[0]?.root ?? null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.#listen(this.deviceRoom);
    for (const repositoryId of this.repositories.keys()) this.#listen(repositoryId);
    this.sweepTimer = setInterval(() => this.#sweep(), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  #listen(room) {
    if (this.subscriptions.has(room)) return;
    this.subscriptions.set(room, onChannelMessage(this.node, room, TERMINAL_CHANNEL, (frame, { peerId }) => {
      // A relayed broadcast's envelope names the LAST HOP, not the browser
      // that asked — replying there sent "opened" to a bystander that
      // dropped it. The frame's replyTo is the requester's own address; the
      // envelope id is only a fallback for direct sends.
      if (typeof frame?.replyTo === 'string' && /^[a-f0-9]{64}$/.test(frame.replyTo)) {
        peerId = frame.replyTo;
      }
      // Broadcast frames are as authenticated as direct ones — the room
      // crypto gates membership either way — and a broadcast arrives when a
      // stale peer id makes direct dialing miss. Replies go direct to the
      // envelope's fromPeerId, which is real and current by construction.
      this.#receive(peerId, frame, room).catch((error) => this.logger.debug?.(`Terminal message: ${error.message}`));
    }));
  }

  /**
   * A terminal frame that arrived sealed over the pairing mesh. It is
   * processed exactly like a room frame; replies travel back the way the
   * frame came, sealed to the sender's key.
   */
  receiveRelayed(opened, { reply }) {
    if (!this.started) return;
    const frame = opened?.frame;
    if (!frame) return;
    const pseudoPeer = `relay:${String(opened.replyEpub ?? '').slice(0, 24)}`;
    this.relayReplies.set(pseudoPeer, reply);
    // A relayed frame names no room. Older dashboards stamp the repository
    // they dialed; the reply carries it back so they recognize it.
    const room = typeof frame.repositoryId === 'string' && frame.repositoryId ? frame.repositoryId : this.deviceRoom;
    this.#receive(pseudoPeer, frame, room).catch((error) => this.logger.debug?.(`Relayed terminal: ${error.message}`));
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const session of [...this.sessions.values()]) this.#close(session);
  }

  activeSessionCount() {
    return this.sessions.size;
  }

  async #receive(peerId, frame, room) {
    if (!this.started) return;
    if (frame.serviceInstanceId !== this.serviceInstanceId || !SESSION.test(String(frame.sessionId ?? ''))
      || !['open', 'input', 'resize', 'ping', 'close', 'cwd'].includes(String(frame.kind ?? ''))
      || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0) return;
    const id = `${peerId}:${frame.sessionId}`;
    if (frame.kind === 'open') {
      if (this.sessions.has(id) || this.opening.has(id)) return;
      this.opening.add(id);
      try {
        await this.#open(peerId, frame, id, room);
      } finally {
        this.opening.delete(id);
      }
      return;
    }
    const session = this.sessions.get(id);
    if (!session || frame.sequence <= session.receivedSequence) return;
    session.receivedSequence = frame.sequence;
    session.lastSeenAt = Date.now();
    if (frame.kind === 'ping') {
      // Answer, so the browser can tell a live session from one whose server
      // restarted out from under it — silence and health looked identical.
      this.#send(session, 'pong', ++session.sentSequence, {}).catch(() => {});
      return;
    }
    if (frame.kind === 'close') {
      this.#close(session);
      return;
    }
    if (frame.kind === 'resize') {
      session.pty.resize(
        boundedInteger(frame.cols, 20, 400, session.cols),
        boundedInteger(frame.rows, 5, 200, session.rows),
      );
      return;
    }
    if (frame.kind === 'cwd') {
      // The dashboard switched repositories: the SAME shell follows it. The
      // directory check is async, so the cd is queued behind earlier input
      // and ahead of later keystrokes — order is what a shell is.
      session.pending = session.pending.then(async () => {
        const directory = await this.#workingDirectory(frame, null);
        if (directory && !session.closed) session.pty.write(changeDirectoryLine(session.flavor, directory));
      }).catch(() => {});
      return;
    }
    if (typeof frame.payload !== 'string' || frame.payload.length > Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 8) return;
    let input;
    try { input = Buffer.from(frame.payload, 'base64'); } catch { return; }
    if (input.length > MAX_INPUT_BYTES) return;
    session.pending = session.pending.then(() => {
      if (!session.closed) session.pty.write(input.toString('utf8'));
    }).catch(() => {});
  }

  /**
   * The directory a frame asks for: the repository it names, else (for a
   * dashboard that dialed a repository's own channel) that repository. Null
   * when nothing usable is registered or the folder is missing locally.
   */
  async #workingDirectory(frame, room) {
    const candidates = [frame.workingRepositoryId, room].filter((value) => typeof value === 'string' && value);
    for (const repositoryId of candidates) {
      const root = this.repositoryRoot(repositoryId);
      if (!root) continue;
      try {
        await stat(root);
        return root;
      } catch { /* a repository this machine has no local copy of */ }
    }
    return null;
  }

  async #open(peerId, frame, id, room) {
    // A new session from a peer replaces that peer's old one. Close frames are
    // easy to lose — a reloaded tab or a timed-out attempt leaves a zombie
    // session — and refusing the peer over its own zombie locked people out
    // of their own machine until the sweep.
    for (const session of [...this.sessions.values()]) {
      if (session.peerId === peerId) this.#close(session);
    }
    const address = { peerId, sessionId: frame.sessionId, room };
    if (this.sessions.size >= MAX_SESSIONS) {
      await this.#send(address, 'error', 0, { message: 'This watcher has reached its terminal session limit.' });
      return;
    }
    const devices = validRoster(frame.devices);
    if (!devices) {
      await this.#send(address, 'error', 0, { message: 'The terminal device roster is invalid.' });
      return;
    }
    const cols = boundedInteger(frame.cols, 20, 400, 100);
    const rows = boundedInteger(frame.rows, 5, 200, 30);
    const pathValue = [BIN_DIRECTORY, process.env.PATH].filter(Boolean).join(path.delimiter);
    let terminal;
    let command;
    try {
      command = await shellCommand(this.deviceName);
      // The terminal belongs to the device; a repository directory is only
      // the preferred working directory. A watcher can carry a repository it
      // has no local copy of yet, and refusing a shell over a missing folder
      // helped nobody.
      const cwd = (await this.#workingDirectory(frame, room)) ?? homedir();
      // The service process inherits the identity of whatever terminal it
      // was originally launched from — on macOS that meant every watcher
      // shell carried Apple Terminal's TERM_PROGRAM and TERM_SESSION_ID, so
      // /etc/zshrc ran Apple's session-restore and loaded that one session's
      // saved history from ~/.zsh_sessions on every open (bypassing HISTFILE
      // entirely), then re-saved it on exit. A GitPigeon session is not
      // inside anyone's terminal app; it must not wear one's identity.
      const inheritedEnv = { ...process.env };
      for (const name of [
        'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID',
        'ITERM_SESSION_ID', 'ITERM_PROFILE', 'SHELL_SESSION_ID',
      ]) delete inheritedEnv[name];
      terminal = await this.spawnPty(command.shell, command.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: {
          ...inheritedEnv,
          PATH: pathValue,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          GITPIGEON_DEVICE_ROSTER: Buffer.from(JSON.stringify(devices)).toString('base64url'),
          ...command.env,
        },
      });
    } catch (error) {
      await this.#send(address, 'error', 0, { message: `Could not open the watcher shell: ${error.message}` });
      return;
    }
    const session = {
      id,
      peerId,
      sessionId: frame.sessionId,
      room,
      flavor: command.flavor ?? 'sh',
      pending: Promise.resolve(),
      pty: terminal,
      cols,
      rows,
      lastSeenAt: Date.now(),
      receivedSequence: frame.sequence,
      sentSequence: 0,
      output: '',
      outputBytes: 0,
      outputTimer: null,
      ready: false,
      preamble: '',
      readyTimer: null,
      historyCarry: '',
      disposables: [],
      closed: false,
    };
    this.sessions.set(id, session);
    session.disposables.push(terminal.onData((data) => {
      const visible = this.#captureHistory(session, data);
      if (visible) this.#gateOutput(session, visible);
    }));
    // A shell that never prints the marker (cmd, an exotic rc) still gets its
    // output through — late and noisy beats swallowed forever.
    session.readyTimer = setTimeout(() => this.#releaseOutput(session, session.preamble), READY_TIMEOUT_MS);
    session.readyTimer.unref?.();
    session.disposables.push(terminal.onExit(({ exitCode, signal }) => {
      if (session.closed) return;
      // A shell that dies before the ready marker should die visibly.
      this.#releaseOutput(session, session.preamble);
      this.#flushOutput(session);
      this.#send(session, 'exit', ++session.sentSequence, { exitCode, signal }).catch(() => {});
      this.#close(session);
    }));
    // Tell the browser where this machine's shell really lives. A session
    // that arrived on a repository channel keeps working after that
    // repository is unwatched only if the browser moves to the device room.
    await this.#send(session, 'opened', ++session.sentSequence, { deviceName: this.deviceName, deviceRoom: this.deviceRoom });
    if (command.initialize) terminal.write(command.initialize);
  }
  /**
   * Strip history-capture OSC frames from the pty stream and merge each
   * reported command line into the mesh record. The frames are invisible
   * plumbing between the shell hook and this server; browsers never see
   * them. Frames can split across pty chunks, so an unterminated frame (or
   * a tail that could still become one) is carried into the next chunk.
   */
  #captureHistory(session, data) {
    const HEADER = '\u001b]777;gitpigeon-hist;';
    let text = session.historyCarry + data;
    session.historyCarry = '';
    let visible = '';
    let cursor = 0;
    for (;;) {
      const start = text.indexOf(HEADER, cursor);
      if (start === -1) break;
      const end = text.indexOf('\u0007', start + HEADER.length);
      if (end === -1) {
        visible += text.slice(cursor, start);
        session.historyCarry = text.slice(start);
        if (session.historyCarry.length > 8_192) {
          // Not a real frame — release it rather than sitting on output.
          visible += session.historyCarry;
          session.historyCarry = '';
        }
        return visible;
      }
      visible += text.slice(cursor, start);
      try {
        const line = Buffer.from(text.slice(start + HEADER.length, end), 'base64').toString('utf8');
        this.history?.add?.(line);
      } catch { /* a malformed frame is dropped, never displayed */ }
      cursor = end + 1;
    }
    // Hold a tail that could be the start of a frame split mid-header.
    const holdFrom = Math.max(cursor, text.length - HEADER.length);
    const escape = text.lastIndexOf('\u001b');
    if (escape >= holdFrom && HEADER.startsWith(text.slice(escape))) {
      visible += text.slice(cursor, escape);
      session.historyCarry = text.slice(escape);
    } else {
      visible += text.slice(cursor);
    }
    return visible;
  }

  #gateOutput(session, data) {
    if (session.ready) return this.#queueOutput(session, data);
    session.preamble += data;
    const at = session.preamble.indexOf(READY_MARKER);
    if (at !== -1) return this.#releaseOutput(session, session.preamble.slice(at + READY_MARKER.length));
    if (Buffer.byteLength(session.preamble) > READY_MAX_BYTES) this.#releaseOutput(session, session.preamble);
  }

  #releaseOutput(session, tail) {
    if (session.ready || session.closed) return;
    session.ready = true;
    session.preamble = '';
    if (session.readyTimer) clearTimeout(session.readyTimer);
    session.readyTimer = null;
    if (tail) this.#queueOutput(session, tail);
  }

  #queueOutput(session, data) {
    if (session.closed || !data) return;
    session.output += data;
    session.outputBytes += Buffer.byteLength(data);
    if (session.outputBytes > MAX_OUTPUT_BYTES) {
      this.#send(session, 'error', ++session.sentSequence, {
        message: 'Terminal output exceeded the watcher buffer limit.',
      }).catch(() => {});
      this.#close(session);
      return;
    }
    if (session.outputTimer) return;
    session.outputTimer = setTimeout(() => this.#flushOutput(session), OUTPUT_BATCH_MS);
  }

  #flushOutput(session) {
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    if (session.closed || !session.output) return;
    const value = session.output;
    session.output = '';
    session.outputBytes = 0;
    for (let offset = 0; offset < value.length; offset += OUTPUT_CHUNK_BYTES) {
      const payload = Buffer.from(value.slice(offset, offset + OUTPUT_CHUNK_BYTES)).toString('base64');
      this.#send(session, 'output', ++session.sentSequence, { payload }).catch(() => {
        this.#close(session);
      });
    }
  }

  async #send({ peerId, sessionId, room }, kind, sequence, fields = {}) {
    const frame = {
      serviceInstanceId: this.serviceInstanceId,
      sessionId,
      kind,
      sequence,
      ...fields,
    };
    // A relayed session replies the way its frames arrive: sealed over the
    // pairing mesh, immune to the room link that failed it in the first
    // place.
    const relay = this.relayReplies.get(peerId);
    if (relay) {
      await relay({ frame: { ...frame, repositoryId: room } });
      return;
    }
    // Replies take the road the session arrived on — the device room or a
    // repository channel — so whichever the browser dialed hears back.
    try {
      await sendChannelDirect(this.node, peerId, room, TERMINAL_CHANNEL, frame);
    } catch (error) {
      throw new Error(`The terminal peer is no longer reachable. (${error.message})`);
    }
  }

  #sweep() {
    const staleBefore = Date.now() - SESSION_TIMEOUT_MS;
    for (const session of [...this.sessions.values()]) {
      if (session.lastSeenAt < staleBefore) this.#close(session);
    }
  }

  #close(session) {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    if (session.readyTimer) clearTimeout(session.readyTimer);
    session.readyTimer = null;
    session.preamble = '';
    session.output = '';
    session.outputBytes = 0;
    for (const disposable of session.disposables) disposable?.dispose?.();
    session.disposables = [];
    try { session.pty.kill(); } catch { /* process already exited */ }
  }
}
