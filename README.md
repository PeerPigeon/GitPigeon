# GitPigeon

GitPigeon adds encrypted, real-time, peer-to-peer synchronization to ordinary
Git repositories. It uses the native `git` executable and PeerPigeon's mesh and
storage APIs, so every synchronized directory remains a standard Git repository
that works with existing editors, hooks, GUIs, and command-line tools.

The PeerPigeon dependency comes directly from
[`PeerPigeon/PeerPigeon`](https://github.com/PeerPigeon/PeerPigeon) and is pinned
to commit
[`ee07a5934bda5d05cf9b0f364a13456ba3438a1c`](https://github.com/PeerPigeon/PeerPigeon/commit/ee07a5934bda5d05cf9b0f364a13456ba3438a1c).
The human- and machine-readable pin is also recorded in
[`PEERPIGEON.lock.json`](./PEERPIGEON.lock.json).

## Platform support

- macOS, Linux, and Windows
- Node.js 20.12 or newer
- Git 2.31 or newer on `PATH`

There are no shell-script assumptions in the sync engine: Git is launched with
argument arrays, paths use the platform path API, ref discovery is polled for
consistent behavior across operating systems, and all repository state lives
inside the Git directory.

## Install

```bash
npm install
npm link
```

The repository's `.npmrc` disables install lifecycle scripts. PeerPigeon already
commits its built `dist/`, and its current Git `prepare` hook intentionally moves
FreeRTC to live HEAD. Skipping that hook keeps the dependency graph at the
revisions recorded by the pinned PeerPigeon commit.

The installed executable is named `git-pigeon`, which means Git automatically
exposes it as `git pigeon`.

## Start a repository

Run this in an existing Git repository:

```bash
git pigeon init
git pigeon watch
```

`init` prints an invite URL. The URL contains the repository ID, the optional
signaling server, and the encryption secret. Treat it like a repository
password.

On a second device, while at least one existing device is online:

```bash
git pigeon clone 'gitpigeon://sync/REPOSITORY_ID#SECRET' my-project
cd my-project
git pigeon watch
```

Continue using Git normally on either device:

```bash
git add .
git commit -m "Ship it"
```

The watcher detects changed branches and tags and publishes them immediately.

## Sync secrets and machine-local config without Git

Use GitPigeon's private workspace channel for exact files that should appear on
trusted devices but must not enter Git:

```bash
git pigeon track .env config/local.json .vscode/settings.json
git pigeon tracked
git pigeon watch
```

`track` adds each path to a managed section of `.git/info/exclude`, not the
repository's `.gitignore`. The file therefore stays out of the Git index and
history without changing a shared Git file. GitPigeon publishes its bytes and
tracked-path metadata through the repository's encrypted PeerPigeon storage
session. Changes and deletions are detected even when no branch or tag changes.

Only exact regular-file paths are accepted; directories, symlinks, globs,
`.git` paths, and paths outside the repository are rejected. GitPigeon also
refuses a path already tracked by Git. To stop tracking a non-secret file in Git
before moving it to the private channel:

```bash
git rm --cached -- config/local.json
git commit -m "Keep local config out of Git"
git pigeon track config/local.json
```

If the file contained a real secret, removing it from the index does not remove
older copies from Git history. Rotate the credential and clean the history if
required.

When a peer update arrives, GitPigeon overwrites a private file only if its
local version still matches the last synchronized version. If both devices
edited it, the local file is preserved and the incoming copy is written under:

```text
.git/gitpigeon/conflicts/<device>/<path>
```

After choosing or merging the desired contents, normal watching resumes from
that version. `git pigeon untrack PATH...` disables private syncing and removes
the local Git exclusion for those paths on the current device.

## Commands

| Command | Purpose |
| --- | --- |
| `git pigeon init` | Add a new Pigeon identity to the current repository. |
| `git pigeon invite` | Print the existing invite URL. |
| `git pigeon track FILE...` | Exclude exact files from Git and sync them privately. |
| `git pigeon untrack FILE...` | Stop private tracking on this device. |
| `git pigeon tracked` | List private workspace files. |
| `git pigeon clone INVITE [DIR]` | Create a normal Git repository and retrieve its first live snapshot. |
| `git pigeon sync` | Publish, wait briefly for peers, retrieve, and exit. |
| `git pigeon watch` | Keep a real-time sync process running. |
| `git pigeon status` | Show local identity and cached sync state without joining the network. |
| `git pigeon doctor` | Check Node, Git, and the PeerPigeon dependency. |

Useful options:

```bash
git pigeon init --signal wss://your-relay.example/ws
git pigeon sync --wait 15s
git pigeon watch --poll 500ms --verbose
git pigeon status --json
```

## How syncing works

GitPigeon creates a complete Git bundle for local branches and tags whenever
their object IDs change. Private workspace files are captured independently,
so config-only changes also create snapshots. Bundle and private-file bytes are
divided into small content-addressed chunks suitable for WebRTC data channels.

- Bundle chunks and manifests use PeerPigeon's immutable `frozen` storage
  space.
- A small `public` head record points to each device's newest immutable
  manifest.
- A mergeable device registry lets offline and newly joined devices discover
  every per-device head without forcing concurrent writers onto one ref.
- PeerPigeon's `sessionId` and `syncSecret` encrypt all storage synchronization
  envelopes, including private workspace files.
- GitPigeon keeps a persistent cache in `.git/gitpigeon/` and re-seeds
  PeerPigeon's in-memory Node storage when the watcher restarts.

Incoming branches are first written to:

```text
refs/remotes/pigeon/<device>/heads/<branch>
```

GitPigeon then safely fast-forwards the matching local branch. It never rewrites
a divergent branch or a dirty checkout. A divergence stays available as a
normal remote-tracking ref so it can be reviewed and merged with ordinary Git:

```bash
git log --graph --oneline --all
git merge refs/remotes/pigeon/DEVICE/heads/main
```

This design preserves both sides of concurrent work instead of letting a
last-writer-wins storage record discard Git history.

## Security and availability

PeerPigeon uses a signaling service for peer discovery and WebRTC negotiation;
Git data travels through the PeerPigeon mesh. Storage envelopes are encrypted
with the invite secret. Anyone who has the invite can join and read the
repository, so rotate to a new repository identity if an invite is exposed.

Private workspace files remain ordinary plaintext files in each trusted working
directory. Persistent content chunks under `.git/gitpigeon/` are encrypted with
the repository secret; restored files and conflict copies are owner-readable.
The invite secret itself is stored in `.git/gitpigeon/config.json` with
owner-only permissions where the platform supports them. Disk encryption and
normal operating-system account protections remain important.

GitPigeon is peer-to-peer rather than a hosted forge. A device holding a wanted
snapshot must be online for a brand-new device to retrieve it. Once retrieved,
the new device caches and re-seeds that snapshot too.

The current implementation sends complete Git bundles after ref changes. Git's
pack format and content-addressed chunk cache avoid corruption, but very large
monorepositories will benefit from a future incremental pack negotiation layer.

## Development

```bash
npm test
npm run check
```

The tests exercise real local Git repositories, fast-forward and divergence
behavior, invite validation, chunked snapshot integrity, exact Git exclusion,
config-only private sync, deletion and concurrent-secret conflict safety, and a
two-device simulation of PeerPigeon's exact-key storage subscriptions.
