import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';

const require = createRequire(import.meta.url);

export const TERMINAL_PROTOCOL = 'gitpigeon/terminal/1';
export const TERMINAL_ENVELOPE_PROTOCOL = 'gitpigeon/terminal-envelope/1';

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
const BIN_DIRECTORY = fileURLToPath(new URL('../bin', import.meta.url));

function spawnPty(shell, args, options) {
  if (process.platform !== 'win32') {
    const packageRoot = path.dirname(require.resolve('node-pty/package.json'));
    const helpers = [
      path.join(packageRoot, 'build', 'Release', 'spawn-helper'),
      path.join(packageRoot, 'build', 'Debug', 'spawn-helper'),
      path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ];
    const helper = helpers.find((candidate) => {
      try { return statSync(candidate).isFile(); } catch { return false; }
    });
    if (!helper) throw new Error(`node-pty spawn-helper is missing for ${process.platform}-${process.arch}`);
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
  }
  return pty.spawn(shell, args, options);
}

function terminalKey(secret) {
  return createHash('sha256')
    .update('gitpigeon:terminal:v1\0')
    .update(String(secret))
    .digest();
}

function additionalData(repositoryId) {
  return Buffer.from(`${TERMINAL_ENVELOPE_PROTOCOL}\0${repositoryId}`);
}

export function encryptTerminalFrame(secret, repositoryId, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', terminalKey(secret), iv);
  cipher.setAAD(additionalData(repositoryId));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value))),
    cipher.final(),
  ]);
  return {
    protocol: TERMINAL_ENVELOPE_PROTOCOL,
    repositoryId,
    ciphertext: Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64'),
  };
}

export function decryptTerminalFrame(secret, repositoryId, envelope) {
  if (!envelope || envelope.protocol !== TERMINAL_ENVELOPE_PROTOCOL
    || envelope.repositoryId !== repositoryId || typeof envelope.ciphertext !== 'string'
    || envelope.ciphertext.length > 100_000) return null;
  let frame;
  try { frame = Buffer.from(envelope.ciphertext, 'base64'); } catch { return null; }
  if (frame.length <= 28) return null;
  const tagStart = frame.length - 16;
  try {
    const decipher = createDecipheriv('aes-256-gcm', terminalKey(secret), frame.subarray(0, 12));
    decipher.setAAD(additionalData(repositoryId));
    decipher.setAuthTag(frame.subarray(tagStart));
    return JSON.parse(Buffer.concat([
      decipher.update(frame.subarray(12, tagStart)),
      decipher.final(),
    ]).toString('utf8'));
  } catch {
    return null;
  }
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

function shellCommand(deviceName) {
  const prompt = `gitpigeon ${deviceName}:$ `;
  if (process.platform === 'win32') {
    const shell = process.env.COMSPEC || 'powershell.exe';
    const powershell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell);
    return {
      shell,
      args: [],
      initialize: powershell
        ? `$function:prompt = { '${prompt.replaceAll("'", "''")}' }; Clear-Host\r`
        : `prompt ${prompt.replaceAll('&', '^&')}$_$G& cls\r`,
    };
  }
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
  const escaped = prompt.replaceAll("'", "'\\''");
  return { shell, args: [], initialize: `export PS1='${escaped}'; export PROMPT='${escaped}'; clear\r` };
}

export class TerminalServer {
  constructor({ node, repository, secret, repositoryId, serviceInstanceId, deviceName = hostname(), logger = {}, spawnPty: spawnTerminal = spawnPty }) {
    this.node = node;
    this.repository = repository;
    this.secret = secret;
    this.repositoryId = repositoryId;
    this.serviceInstanceId = serviceInstanceId;
    this.deviceName = cleanDeviceName(deviceName);
    this.logger = logger;
    this.spawnPty = spawnTerminal;
    this.sessions = new Map();
    this.started = false;
    this.sweepTimer = null;
    this.onMessage = (message) => {
      this.#receive(message).catch((error) => this.logger.debug?.(`Terminal message: ${error.message}`));
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.node.on('message', this.onMessage);
    this.sweepTimer = setInterval(() => this.#sweep(), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.node.off('message', this.onMessage);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const session of [...this.sessions.values()]) this.#close(session);
  }

  activeSessionCount() {
    return this.sessions.size;
  }

  async #receive(message) {
    if (!this.started || message?.local || message?.kind !== 'direct' || !message.fromPeerId) return;
    const frame = decryptTerminalFrame(this.secret, this.repositoryId, message.data);
    if (!frame || frame.protocol !== TERMINAL_PROTOCOL || frame.repositoryId !== this.repositoryId
      || frame.serviceInstanceId !== this.serviceInstanceId || !SESSION.test(String(frame.sessionId ?? ''))
      || !['open', 'input', 'resize', 'ping', 'close'].includes(String(frame.kind ?? ''))
      || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0) return;
    const id = `${message.fromPeerId}:${frame.sessionId}`;
    if (frame.kind === 'open') {
      await this.#open(message.fromPeerId, frame, id);
      return;
    }
    const session = this.sessions.get(id);
    if (!session || frame.sequence <= session.receivedSequence) return;
    session.receivedSequence = frame.sequence;
    session.lastSeenAt = Date.now();
    if (frame.kind === 'ping') return;
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
    if (typeof frame.payload !== 'string' || frame.payload.length > Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 8) return;
    let input;
    try { input = Buffer.from(frame.payload, 'base64'); } catch { return; }
    if (input.length > MAX_INPUT_BYTES) return;
    session.pty.write(input.toString('utf8'));
  }

  async #open(peerId, frame, id) {
    if (this.sessions.has(id)) return;
    const peerSessions = [...this.sessions.values()].filter((session) => session.peerId === peerId).length;
    if (this.sessions.size >= MAX_SESSIONS || peerSessions >= MAX_SESSIONS_PER_PEER) {
      await this.#send(peerId, frame.sessionId, 'error', 0, { message: 'This watcher has reached its terminal session limit.' });
      return;
    }
    const devices = validRoster(frame.devices);
    if (!devices) {
      await this.#send(peerId, frame.sessionId, 'error', 0, { message: 'The terminal device roster is invalid.' });
      return;
    }
    const cols = boundedInteger(frame.cols, 20, 400, 100);
    const rows = boundedInteger(frame.rows, 5, 200, 30);
    const command = shellCommand(this.deviceName);
    const pathValue = [BIN_DIRECTORY, process.env.PATH].filter(Boolean).join(path.delimiter);
    let terminal;
    try {
      terminal = this.spawnPty(command.shell, command.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.repository.root,
        env: {
          ...process.env,
          PATH: pathValue,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          GITPIGEON_DEVICE_ROSTER: Buffer.from(JSON.stringify(devices)).toString('base64url'),
        },
      });
    } catch (error) {
      await this.#send(peerId, frame.sessionId, 'error', 0, { message: `Could not open the watcher shell: ${error.message}` });
      return;
    }
    const session = {
      id,
      peerId,
      sessionId: frame.sessionId,
      pty: terminal,
      cols,
      rows,
      lastSeenAt: Date.now(),
      receivedSequence: frame.sequence,
      sentSequence: 0,
      output: '',
      outputBytes: 0,
      outputTimer: null,
      disposables: [],
      closed: false,
    };
    this.sessions.set(id, session);
    session.disposables.push(terminal.onData((data) => this.#queueOutput(session, data)));
    session.disposables.push(terminal.onExit(({ exitCode, signal }) => {
      if (session.closed) return;
      this.#flushOutput(session);
      this.#send(peerId, session.sessionId, 'exit', ++session.sentSequence, { exitCode, signal }).catch(() => {});
      this.#close(session);
    }));
    await this.#send(peerId, session.sessionId, 'opened', ++session.sentSequence, { deviceName: this.deviceName });
    terminal.write(command.initialize);
  }

  #queueOutput(session, data) {
    if (session.closed || !data) return;
    session.output += data;
    session.outputBytes += Buffer.byteLength(data);
    if (session.outputBytes > MAX_OUTPUT_BYTES) {
      this.#send(session.peerId, session.sessionId, 'error', ++session.sentSequence, {
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
      this.#send(session.peerId, session.sessionId, 'output', ++session.sentSequence, { payload }).catch(() => {
        this.#close(session);
      });
    }
  }

  async #send(peerId, sessionId, kind, sequence, fields = {}) {
    const envelope = encryptTerminalFrame(this.secret, this.repositoryId, {
      protocol: TERMINAL_PROTOCOL,
      repositoryId: this.repositoryId,
      serviceInstanceId: this.serviceInstanceId,
      sessionId,
      kind,
      sequence,
      ...fields,
    });
    if (!this.node.sendDirect(peerId, envelope)) throw new Error('The terminal peer is no longer reachable.');
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
    session.output = '';
    session.outputBytes = 0;
    for (const disposable of session.disposables) disposable?.dispose?.();
    session.disposables = [];
    try { session.pty.kill(); } catch { /* process already exited */ }
  }
}
