#!/usr/bin/env node
// Moves this app's Pigeon dependencies to their newest commits
// (.github/workflows/pigeon-deps.yml runs it, then builds, tests, and commits only if both pass).
//
// A dependency pinned to a commit (a codeload tarball, github:owner/repo#sha, git+https://...#sha) gets
// main's newest commit in the same form; one that follows a branch (#main, #dev, …) has its lock entry
// refreshed to that branch's newest commit.
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
/** The newest commit on a branch of a repository (main unless named; all public: no token). */
async function head(repo, branch = 'main') {
  const key = `${repo}#${branch}`;
  if (!heads.has(key)) {
    const line = execFileSync('git', ['ls-remote', `https://github.com/${repo}.git`, `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
    const sha = line.split(/\s/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`${repo}: no ${branch} branch`);
    heads.set(key, sha);
  }
  return heads.get(key);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
let lock = null;
try { lock = JSON.parse(readFileSync('package-lock.json', 'utf8')); } catch { /* no lock */ }
const moved = [];
// Lock entries taken out this run (what they needed still counts below).
const removed = {};

for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides']) {
  for (const [name, repo] of Object.entries(REPOS)) {
    const spec = pkg[section]?.[name];
    if (typeof spec !== 'string') continue;
    const branch = /#([A-Za-z][\w./-]*)$/.exec(spec)?.[1];
    const followsBranch = Boolean(branch) && !/^[0-9a-f]{7,40}$/i.test(branch);
    const sha = await head(repo, followsBranch ? branch : 'main');
    const repoRe = repo.replace('/', '\\/');
    let next = spec;
    if (new RegExp(`codeload\\.github\\.com\\/${repoRe}\\/tar\\.gz\\/[0-9a-f]{7,40}`, 'i').test(spec)) {
      next = spec.replace(/tar\.gz\/[0-9a-f]{7,40}/i, `tar.gz/${sha}`);
    } else if (new RegExp(`${repoRe}(\\.git)?#[0-9a-f]{7,40}$`, 'i').test(spec)) {
      // A short pin stays short, a full one full.
      const old = spec.split('#').pop();
      next = spec.replace(/#[0-9a-f]{7,40}$/i, `#${old.length >= 40 ? sha : sha.slice(0, 7)}`);
    } else if (followsBranch && lock) {
      // Follows a branch: the lock holds the commit. Drop its entries so npm resolves the branch again.
      const held = Object.entries(lock.packages ?? {}).filter(([k]) => k.endsWith(`node_modules/${name}`));
      if (held.some(([, v]) => typeof v.resolved === 'string' && !v.resolved.includes(sha))) {
        for (const [k, v] of held) { removed[k] = v; delete lock.packages[k]; }
        moved.push(`${name} -> ${sha.slice(0, 7)} (${branch})`);
      }
      continue;
    } else {
      continue; // an npm range: npm update handles it
    }
    if (next !== spec) {
      pkg[section][name] = next;
      moved.push(`${name} -> ${sha.slice(0, 7)}`);
    }
    // npm keeps a git dependency's locked commit while its version number is unchanged, even when
    // package.json names a new commit: so its lock entries go, and npm install fetches what is named.
    if (lock) {
      // Only the app's own entry: a copy nested under another package is what that package pins.
      const k = `node_modules/${name}`;
      const v = lock.packages?.[k];
      if (typeof v?.resolved === 'string' && !v.resolved.includes(sha)) {
        removed[k] = v;
        delete lock.packages[k];
        moved.push(`${name} -> ${sha.slice(0, 7)}`);
      }
    }
  }
}

// Pigeon libraries that come in through another (freertc through PeerPigeon, say): each follows the branch
// its parent names (#main, #dev), so a stale lock entry goes and npm install fetches that branch's newest.
if (lock) {
  const nameRe = Object.keys(REPOS).join('|');
  for (const k of Object.keys(lock.packages ?? {})) {
    const m = new RegExp(`^(.*)node_modules/(${nameRe})$`).exec(k);
    if (!m || m[1] === '') continue; // the app's own dependencies: done above
    const name = m[2];
    const v = lock.packages[k];
    if (typeof v?.resolved !== 'string' || !/github\.com|codeload/.test(v.resolved)) continue;
    const parent = lock.packages[m[1].replace(/\/$/, '')];
    const want = parent?.dependencies?.[name] ?? '';
    const branch = /#([A-Za-z][\w./-]*)$/.exec(want)?.[1];
    if (/#[0-9a-f]{7,40}$|tar\.gz\/[0-9a-f]{7,40}$/i.test(want) || !/#[A-Za-z]|^git|^github:/.test(want)) continue; // pinned by the parent (or from npm): the parent's to move
    const sha = await head(REPOS[name], branch || 'main');
    if (!v.resolved.includes(sha)) {
      delete lock.packages[k];
      moved.push(`${name} -> ${sha.slice(0, 7)} (in ${m[1].replace(/node_modules\//g, '').replace(/\/$/, '')})`);
    }
  }
  // Where the app has no entry of its own for one, npm puts the parent's at the top: that is it too.
  for (const name of Object.keys(REPOS)) {
    const top = lock.packages?.[`node_modules/${name}`];
    const own = ['dependencies', 'devDependencies', 'optionalDependencies'].some((sec) => pkg[sec]?.[name]);
    if (!top || own || typeof top.resolved !== 'string' || !/github\.com|codeload/.test(top.resolved)) continue;
    const parents = Object.entries({ ...lock.packages, ...removed }).filter(([k, v]) => k.startsWith('node_modules/') && !k.slice(13).includes('/node_modules/') && v?.dependencies?.[name]);
    const want = parents.map(([, v]) => v.dependencies[name]).find((x) => typeof x === 'string') ?? '';
    if (/#[0-9a-f]{7,40}$|tar\.gz\/[0-9a-f]{7,40}$/i.test(want) || !/#[A-Za-z]|^git|^github:/.test(want)) continue;
    const branch = /#([A-Za-z][\w./-]*)$/.exec(want)?.[1];
    const sha = await head(REPOS[name], branch || 'main');
    if (!top.resolved.includes(sha)) {
      delete lock.packages[`node_modules/${name}`];
      moved.push(`${name} -> ${sha.slice(0, 7)} (${branch || 'main'}, through ${parents.map(([k]) => k.slice(13)).join(', ')})`);
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
