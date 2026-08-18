import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class GitCommandError extends Error {
  constructor(args, code, stderr) {
    super(`git ${args.join(' ')} failed (${code}): ${String(stderr).trim()}`);
    this.name = 'GitCommandError';
    this.code = code;
    this.stderr = stderr;
  }
}

export async function runGit(cwd, args, options = {}) {
  const { allowFailure = false, input, env } = options;
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (result.code !== 0 && !allowFailure) {
        reject(new GitCommandError(args, result.code, result.stderr));
      } else {
        resolve(result);
      }
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export class GitRepository {
  constructor(root, gitDir, { bare = false } = {}) {
    this.root = root;
    this.gitDir = gitDir;
    this.bare = bare;
  }

  static async discover(cwd = process.cwd()) {
    const top = await runGit(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    const bareResult = await runGit(cwd, ['rev-parse', '--is-bare-repository'], { allowFailure: true });
    if (bareResult.code !== 0) throw new Error(`Not a Git repository: ${cwd}`);
    const bare = bareResult.stdout.trim() === 'true';
    const root = bare ? path.resolve(cwd) : top.stdout.trim();
    const gitDirResult = await runGit(cwd, ['rev-parse', '--absolute-git-dir']);
    return new GitRepository(root, gitDirResult.stdout.trim(), { bare });
  }

  static async init(directory, initialBranch = 'main') {
    await runGit(directory, ['init', `--initial-branch=${initialBranch}`]);
    return await GitRepository.discover(directory);
  }

  async git(args, options) {
    return await runGit(this.root, args, options);
  }

  async version() {
    return (await this.git(['version'])).stdout.trim();
  }

  async refs() {
    const result = await this.git([
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      'refs/heads',
      'refs/tags',
    ]);
    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const [name, oid] = line.split('\0');
      return { name, oid };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  async refsDigest() {
    const refs = await this.refs();
    if (refs.length === 0) return null;
    return createHash('sha256')
      .update(refs.map(({ name, oid }) => `${name}\0${oid}\n`).join(''))
      .digest('hex');
  }

  async createBundle() {
    const refs = await this.refs();
    if (refs.length === 0) return null;
    const directory = await mkdtemp(path.join(tmpdir(), 'gitpigeon-bundle-'));
    const filename = path.join(directory, 'repository.bundle');
    try {
      await this.git(['bundle', 'create', filename, '--branches', '--tags']);
      await this.git(['bundle', 'verify', filename]);
      return {
        data: await readFile(filename),
        refs,
        dispose: async () => await rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async importBundle(filename, deviceId) {
    const safeDevice = String(deviceId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const heads = await this.#bundleHeads(filename);
    const branchRefs = heads.filter(({ name }) => name.startsWith('refs/heads/'));
    const tagRefs = heads.filter(({ name }) => name.startsWith('refs/tags/'));
    const refspecs = [
      ...branchRefs.map(({ name }) => `+${name}:refs/remotes/pigeon/${safeDevice}/heads/${name.slice(11)}`),
      ...tagRefs.map(({ name }) => `+${name}:refs/remotes/pigeon/${safeDevice}/tags/${name.slice(10)}`),
    ];
    if (refspecs.length === 0) return { updated: [], conflicts: [], remoteRefs: [] };
    await this.git(['fetch', '--no-tags', '--no-write-fetch-head', filename, ...refspecs]);
    const updated = [];
    const conflicts = [];
    const currentBranch = this.bare ? null : await this.#currentBranch();
    const clean = this.bare ? true : await this.#isClean();
    const localHeadsBefore = (await this.git([
      'for-each-ref',
      '--format=%(refname)',
      'refs/heads',
    ])).stdout.split('\n').filter(Boolean);

    for (const { name, oid } of branchRefs) {
      const short = name.slice('refs/heads/'.length);
      const remoteRef = `refs/remotes/pigeon/${safeDevice}/heads/${short}`;
      const localOid = await this.#resolve(name);
      if (!localOid) {
        if (currentBranch === short && !this.bare) {
          if (!clean) {
            conflicts.push({ branch: short, reason: 'working-tree-not-clean', remoteRef });
            continue;
          }
          await this.git(['checkout', '-B', short, remoteRef]);
        } else {
          await this.git(['update-ref', name, oid]);
        }
        updated.push(short);
        continue;
      }
      if (localOid === oid || await this.#isAncestor(oid, localOid)) continue;
      if (await this.#isAncestor(localOid, oid)) {
        if (currentBranch === short && !this.bare) {
          if (!clean) {
            conflicts.push({ branch: short, reason: 'working-tree-not-clean', remoteRef });
            continue;
          }
          await this.git(['merge', '--ff-only', remoteRef]);
        } else {
          await this.git(['update-ref', name, oid, localOid]);
        }
        updated.push(short);
      } else {
        conflicts.push({ branch: short, reason: 'diverged', remoteRef });
      }
    }

    for (const { name, oid } of tagRefs) {
      if (!await this.#resolve(name)) {
        await this.git(['update-ref', name, oid]);
        updated.push(name);
      }
    }

    if (!this.bare && clean && localHeadsBefore.length === 0 && branchRefs.length > 0) {
      const incomingNames = branchRefs.map(({ name }) => name.slice('refs/heads/'.length));
      if (!incomingNames.includes(currentBranch)) {
        const preferred = incomingNames.includes('main')
          ? 'main'
          : incomingNames.includes('master') ? 'master' : [...incomingNames].sort()[0];
        await this.git(['checkout', preferred]);
      }
    }

    return { updated, conflicts, remoteRefs: [...branchRefs, ...tagRefs] };
  }

  async #bundleHeads(filename) {
    const result = await this.git(['bundle', 'list-heads', filename]);
    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf(' ');
      return { oid: line.slice(0, separator), name: line.slice(separator + 1) };
    }).filter(({ name }) => name.startsWith('refs/heads/') || name.startsWith('refs/tags/'));
  }

  async #currentBranch() {
    const result = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async #isClean() {
    return (await this.git(['status', '--porcelain=v1'])).stdout.trim() === '';
  }

  async #resolve(ref) {
    const result = await this.git(['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async #isAncestor(ancestor, descendant) {
    const result = await this.git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
    return result.code === 0;
  }
}
