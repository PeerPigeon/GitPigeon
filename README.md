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

Run one command. If the directory is not already a Git repository, GitPigeon
initializes Git too:

```bash
git pigeon init
```

`init` protects private files, starts the real-time watcher in the background,
pairs the default browser with the encrypted Pigeon index on first use, and
prints an invite URL. The URL contains the repository ID, the optional
signaling server, and the encryption secret. Treat it like a repository password.

On a second device, while at least one existing device is online:

```bash
git pigeon init 'gitpigeon://sync/REPOSITORY_ID#SECRET' my-project
```

That creates `my-project`, initializes native Git, joins the Pigeon, retrieves
the live snapshot, and keeps watching in the background. There is no separate
clone or watch step. Running `git pigeon init` again is safe and simply ensures
the watcher is running.

Continue using Git normally on either device:

```bash
git add .
git commit -m "Ship it"
```

The background watcher detects changed branches, tags, secrets, and local config
and publishes them immediately. Remove only the current repository from the
encrypted browser index with either spelling:

```bash
git pigeon unwatch
# or
git pigeon watch off
```

Run `git pigeon init` to start it again.

From any directory, list the repositories currently watched on this machine or
remove one by its displayed name:

```bash
git pigeon list
git pigeon unwatch my-project
```

If multiple watched repositories have the same name, GitPigeon prints their
paths and requires you to run `unwatch` from inside the intended repository.

To stop every watcher on this machine and clear the entire browser index:

```bash
git pigeon stop
```

`stop` is machine-wide and can be run from any directory; `unwatch` is always
scoped to the Git repository containing the current directory.

## Automatic browser index

The first `git pigeon init` on a machine opens `https://gitpigeon.dev` with a
one-time capability in the URL fragment. The fragment never reaches Cloudflare;
the browser stores it locally and removes it from the address bar. From then on,
opening the bare site joins an encrypted PeerPigeon index and automatically
displays every active Pigeon registered on that machine.

There is no localhost HTTP bridge. Each native watcher is itself a PeerPigeon
index peer and publishes the current directory through PeerPigeon storage.
Repository IDs and encryption secrets travel only inside the encrypted index
session. Starting or stopping a watcher updates the directory automatically.

`git pigeon unwatch` removes only the selected repository. `git pigeon stop`
stops every watcher and publishes an empty directory. A different browser
profile must be paired separately because it does not share the first profile's
local capability.

## Sync secrets and machine-local config without Git

`init` automatically discovers small Git-ignored files plus conventional secret
and local-config names such as `.env`, `.env.local`, `credentials.json`,
`secrets.yaml`, and `settings.local.json`. It adds them to a managed section of
`.git/info/exclude`, not the repository's `.gitignore`. They therefore stay out
of the Git index and history without changing a shared Git file. Changes and
deletions sync through encrypted PeerPigeon storage even when no Git ref changes.

Automatic discovery skips files over 1 MiB and dependency, build, coverage, and
cache directories such as `node_modules`, `vendor`, `dist`, `target`, and
`.next`. This keeps ignored generated trees out of the Pigeon. The advanced
`git pigeon track FILE...` command can explicitly include an unusual config file
that does not match the automatic rules.

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

After choosing or merging the desired contents, normal background watching
resumes from that version. `git pigeon untrack PATH...` is an advanced local
override that disables private syncing and removes the Git exclusion.

## Commands

| Command | Purpose |
| --- | --- |
| `git pigeon init [INVITE] [DIR]` | Create or join a Pigeon and start background syncing. |
| `git pigeon list` | List every repository watched on this machine. |
| `git pigeon unwatch` | Stop watching only the current repository and remove it from the encrypted index. |
| `git pigeon unwatch REPOSITORY` | Stop one watched repository by name from any directory. |
| `git pigeon watch off` | Repository-scoped alias for `unwatch`. |
| `git pigeon stop` | Stop every local watcher and clear the entire browser index. |
| `git pigeon invite` | Print the existing invite URL. |
| `git pigeon track FILE...` | Exclude exact files from Git and sync them privately. |
| `git pigeon untrack FILE...` | Stop private tracking on this device. |
| `git pigeon tracked` | List private workspace files. |
| `git pigeon sync` | Publish, wait briefly for peers, retrieve, and exit. |
| `git pigeon watch` | Ensure the background watcher is running. |
| `git pigeon status` | Show local identity and cached sync state without joining the network. |
| `git pigeon doctor` | Check Node, Git, and the PeerPigeon dependency. |

Useful options:

```bash
git pigeon init --signal wss://your-relay.example/ws
git pigeon sync --wait 15s
git pigeon watch --foreground --poll 500ms --verbose
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
- The detached watcher uses an authenticated heartbeat and stop request under
  `.git/gitpigeon/`, so `init`, `unwatch`, and `status` work consistently on
  macOS, Linux, and Windows. Active watchers also publish the machine directory
  into a separate PeerPigeon storage session protected by a per-machine secret.

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
automatic secret/config discovery, background watcher control, encrypted
multi-watcher browser indexing, config-only private sync, deletion and concurrent-secret
conflict safety, and a two-device simulation of PeerPigeon's exact-key storage
subscriptions.
