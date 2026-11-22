#!/usr/bin/env node
// Moves this app's Pigeon dependencies to the newest commit on their main branch
// (.github/workflows/pigeon-deps.yml runs it, then builds, tests, and commits only if both pass).
//
// A dependency pinned to a commit (a codeload tarball, github:owner/repo#sha, git+https://...#sha) gets
// main's newest commit in the same form; one that follows a branch (#main) has its lock entry refreshed.
// Prints `changed=<true|false>` and `summary=<what moved>` for $GITHUB_OUTPUT. Exits without changes
// on weekdays 7:30am-3:30pm in Chicago (no pushes then).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const REPOS = {
  unsea: 'draeder/unsea',
  freertc: 'draeder/freertc',
  pigeonidp: 'PeerPigeon/PigeonIdP',
  peerpigeon: 'PeerPigeon/PeerPigeon',
  pigeonfs: 'PeerPigeon/PigeonFS',
};
const out = (k, v) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

// The push window: none on weekdays 7:30-15:30 in Chicago, unless run by hand.
if (process.env.GITHUB_EVENT_NAME === 'schedule') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (!['Sat', 'Sun'].includes(parts.weekday) && minutes >= 7 * 60 + 30 && minutes < 15 * 60 + 30) {
    console.log('Weekday 7:30am-3:30pm in Chicago: nothing is pushed now.');
    out('changed', 'false');
    process.exit(0);
  }
}

const heads = new Map();
/** The newest commit on a repository's main (all public: no token). */
async function head(repo) {
  if (!heads.has(repo)) {
    const line = execFileSync('git', ['ls-remote', `https://github.com/${repo}.git`, 'refs/heads/main'], { encoding: 'utf8' }).trim();
    const sha = line.split(/\s/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${repo}: no main branch`);
    heads.set(repo, sha);
  }
  return heads.get(repo);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let lock = null;
try { lock = JSON.parse(readFileSync('package-lock.json', 'utf8')); } catch { /* no lock */ }
const moved = [];

for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides']) {
  for (const [name, repo] of Object.entries(REPOS)) {
    const spec = pkg[section]?.[name];
    if (typeof spec !== 'string') continue;
    const sha = await head(repo);
    const repoRe = repo.replace('/', '\\/');
    let next = spec;
    if (new RegExp(`codeload\\.github\\.com\\/${repoRe}\\/tar\\.gz\\/[0-9a-f]{7,40}`, 'i').test(spec)) {
      next = spec.replace(/tar\.gz\/[0-9a-f]{7,40}/i, `tar.gz/${sha}`);
    } else if (new RegExp(`${repoRe}(\\.git)?#[0-9a-f]{7,40}$`, 'i').test(spec)) {
      // A short pin stays short, a full one full.
      const old = spec.split('#').pop();
      next = spec.replace(/#[0-9a-f]{7,40}$/i, `#${old.length >= 40 ? sha : sha.slice(0, 7)}`);
    } else if (/#main$/.test(spec) && lock) {
      // Follows main: the lock holds the commit. Drop its entries so npm resolves main again.
      const held = Object.entries(lock.packages ?? {}).filter(([k]) => k.endsWith(`node_modules/${name}`));
      if (held.some(([, v]) => typeof v.resolved === 'string' && !v.resolved.includes(sha))) {
        for (const [k] of held) delete lock.packages[k];
        moved.push(`${name} -> ${sha.slice(0, 7)} (main)`);
      }
      continue;
    } else {
      continue; // an npm range: npm update handles it
    }
    if (next !== spec) {
      pkg[section][name] = next;
      moved.push(`${name} -> ${sha.slice(0, 7)}`);
    }
  }
}

if (!moved.length) {
  console.log('Every Pigeon dependency is on main already.');
  out('changed', 'false');
  process.exit(0);
}
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
if (lock) writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
const summary = [...new Set(moved)].join(', ');
console.log(summary);
out('changed', 'true');
out('summary', summary);
