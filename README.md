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

## Project status

GitPigeon is public pre-release software under the MIT license. Install it from
the source repository below. An npm package and packaged GitHub release are not
available yet. [`gitpigeon.dev`](https://gitpigeon.dev) is the live browser for
paired GitPigeon installations.

## Platform support

- macOS, Linux, and Windows
- Node.js 20.12 or newer
- Git 2.31 or newer on `PATH`

There are no shell-script assumptions in the sync engine: Git is launched with
argument arrays, paths use the platform path API, ref discovery is polled for
consistent behavior across operating systems, and all repository state lives
inside the Git directory.

## Install from source

Clone the public repository and expose its `git-pigeon` executable to Git:

```bash
git clone https://github.com/PeerPigeon/GitPigeon.git
cd GitPigeon
npm ci
npm link
```

`npm ci` installs the repository's locked dependencies; it does not download a
published GitPigeon package. PeerPigeon is fetched directly from the pinned
GitHub commit above, not from the npm registry. The repository's `.npmrc`
disables dependency lifecycle scripts so PeerPigeon and FreeRTC stay at their
locked revisions.

The installed executable is named `git-pigeon`, which means Git automatically
exposes it as `git pigeon`.

## Start a repository

Leave the GitPigeon source checkout and change into the repository you actually
want to synchronize. Then run one command. If that directory is not already a
Git repository, GitPigeon initializes Git too:

```bash
cd path/to/your/repository
git pigeon init
```

`init` protects private files, registers the repository with GitPigeon's single
machine-wide watcher service,
opens the default browser for secure enrollment on first use, and prints a
six-digit approval code in the terminal. Enter that code in the browser within
two minutes. GitPigeon records enrollment only after the browser acknowledges
the encrypted grant, so an abandoned attempt is offered again by the next
`git pigeon init`. Peer discovery and signaling are automatic through
PeerPigeon and FreeRTC; no relay argument is required. The invite contains the
repository identity and encryption secret, so treat it like a repository
password.

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

The background service detects working-tree changes every 250 ms. Creating,
editing, renaming, or deleting an ordinary code file is published immediately;
you do not need to stage or commit it first. Commits still synchronize as native
Git history, and turning a live change into a commit cleanly replaces the live
overlay on receiving devices. Changed branches, tags, secrets, and local config
use the same encrypted PeerPigeon mesh.

Ignored secrets use the private-file channel described below. Ordinary
Git-tracked files and non-ignored untracked files use the live code channel.
Dependency, build, cache, and coverage trees are excluded. Live code has no
GitPigeon file-size cap; transport is bounded only by available storage and
runtime resources. If two devices edit the same code concurrently,
GitPigeon preserves the local file and saves the incoming version under:

```text
.git/gitpigeon/live-conflicts/<device>/<path>
```

Remove only the current repository from the encrypted Pigeon index with either
spelling:

```bash
git pigeon unwatch
# or
git pigeon watch off
```

The machine-wide service keeps running for any other indexed repositories. Run
`git pigeon init` here to add this repository again.

From any directory, list every repository in the persistent machine index,
including stopped repositories, or remove one by its displayed name:

```bash
git pigeon list
git pigeon unwatch my-project
```

If multiple watched repositories have the same name, GitPigeon prints their
paths and requires you to run `unwatch` from inside the intended repository.

To stop the one GitPigeon watcher service on this machine without deleting the
persistent encrypted Pigeon index:

```bash
git pigeon stop
```

`stop` is machine-wide and can be run from any directory. Indexed repositories
remain available to restart with `git pigeon watch` or `git pigeon init`.
`unwatch` is always repository-scoped and is the command that removes an entry
from the persistent index.

## Automatic encrypted Pigeon index

The first `git pigeon init` on a machine opens `https://gitpigeon.dev` with a
two-minute enrollment rendezvous in the URL fragment. The fragment never
contains the permanent machine-index secret and is not sent to Cloudflare. It
contains only an ephemeral PeerPigeon session secret plus the native peer's
ephemeral public key.

The browser creates its own ephemeral device key and asks for approval. The
six-digit terminal code is encrypted specifically to the native public key.
After at most five attempts, the native peer either rejects the enrollment or
returns the permanent index capability encrypted specifically to that browser's
key. The browser acknowledges receipt, the temporary session closes, and the
URL fragment is discarded. Native state is marked paired only after that
authenticated acknowledgment; a failed or abandoned attempt remains pending
and the next `init` creates a fresh enrollment. From then on, opening the bare
site joins the encrypted PeerPigeon index and automatically displays every
indexed Pigeon.

Pair another browser with a fresh one-time session, or deliberately rotate the
machine-index secret and invalidate every previously paired browser:

```bash
git pigeon pair
git pigeon pair --rotate
```

Legacy installations automatically rotate the old URL-exposed index secret the
next time `git pigeon init` performs secure enrollment.

There is no localhost HTTP bridge. One native GitPigeon service is the
PeerPigeon index peer for the machine and publishes the current directory
through PeerPigeon storage. The same process multiplexes every indexed
repository's PeerPigeon session.
Repository IDs and encryption secrets travel only inside the encrypted index
session. Registering or removing a repository updates the directory
automatically.

`git pigeon unwatch` removes only the selected repository. `git pigeon stop`
stops the single service process but retains the directory, so repository entries
survive clean exits, crashes, and later process restarts. A different browser
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
| `git pigeon list` | List every persistent indexed repository and whether the service is watching it. |
| `git pigeon pair` | Securely approve another browser with a two-minute six-digit enrollment. |
| `git pigeon pair --rotate` | Rotate the machine-index secret and invalidate earlier browser capabilities. |
| `git pigeon unwatch` | Remove only the current repository from the encrypted index; keep the service running. |
| `git pigeon unwatch REPOSITORY` | Remove one repository by name without stopping the service. |
| `git pigeon watch off` | Repository-scoped alias for `unwatch`. |
| `git pigeon stop` | Stop the one machine-wide watcher service without deleting the persistent index. |
| `git pigeon invite` | Print the existing invite URL. |
| `git pigeon track FILE...` | Exclude exact files from Git and sync them privately. |
| `git pigeon untrack FILE...` | Stop private tracking on this device. |
| `git pigeon tracked` | List private workspace files. |
| `git pigeon sync` | Publish, wait briefly for peers, retrieve, and exit. |
| `git pigeon watch` | Register the current repository and ensure the one background service is running. |
| `git pigeon status` | Show local identity and cached sync state without joining the network. |
| `git pigeon doctor` | Check Node, Git, and the PeerPigeon dependency. |

Useful options:

```bash
git pigeon sync --wait 15s
git pigeon watch --poll 500ms --verbose
git pigeon status --json
```

## How syncing works

GitPigeon creates a complete Git bundle for local branches and tags whenever
their object IDs change. A live workspace overlay captures uncommitted code
creates, updates, renames, and deletes independently of Git refs. Private
workspace files are captured on a separate channel, so code-only and
config-only changes also create snapshots. Bundle, live-code, and private-file
bytes are divided into small content-addressed chunks suitable for WebRTC data
channels.

- Bundle chunks and manifests use PeerPigeon's immutable `frozen` storage
  space.
- While a watcher is online, browsers read the same verified chunks through an
  encrypted, backpressured binary `ReadableStream` over PeerPigeon's existing
  WebRTC data channel. A 32-frame window and cumulative acknowledgements avoid
  one storage request per chunk. PeerPigeon storage remains the durable
  recovery path for cached, interrupted, and offline-seeded transfers.
- A small `public` head record points to each device's newest immutable
  manifest.
- A mergeable device registry lets offline and newly joined devices discover
  every per-device head without forcing concurrent writers onto one ref.
- PeerPigeon's `sessionId` and `syncSecret` encrypt all storage synchronization
  envelopes, including live code and private workspace files.
- GitPigeon keeps a persistent cache in `.git/gitpigeon/` and re-seeds
  PeerPigeon's in-memory Node storage when the watcher restarts.
- The single detached service uses an authenticated heartbeat and stop request
  in GitPigeon's per-user application-data directory, so concurrent `init` and
  `watch` calls cannot spawn a second process on macOS, Linux, or Windows. It
  publishes the machine directory through a separate PeerPigeon storage session
  protected by a per-machine secret.

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
Git data travels through the PeerPigeon mesh. By default GitPigeon leaves relay
selection to PeerPigeon, so each peer independently chooses a nearby FreeRTC
relay and FreeRTC federates matching Network + Room peers across relays. No
local bridge, fixed relay, or relay argument is required. Storage envelopes are
encrypted with the invite secret. Anyone who has the invite can join and read
the repository, so rotate to a new repository identity if an invite is exposed.

Working-tree code and private workspace files remain ordinary plaintext files
in each trusted working directory. Persistent content chunks under
`.git/gitpigeon/` are encrypted with the repository secret; restored files and
conflict copies are owner-readable.
The invite secret itself is stored in `.git/gitpigeon/config.json` with
owner-only permissions where the platform supports them. Disk encryption and
normal operating-system account protections remain important.

GitPigeon is peer-to-peer rather than a hosted forge. A device holding a wanted
snapshot must be online for a brand-new device to retrieve it. Once retrieved,
the new device caches and re-seeds that snapshot too.

Git bundles already contain Git packfiles, whose objects are compressed by Git.
Wrapping the pack in a second compression layer would add CPU and buffering
without removing the transport round trips, so the live fast path streams the
pack bytes directly. The current implementation sends complete Git bundles
after ref changes; live
working-tree updates reuse the unchanged bundle and transfer only new
content-addressed chunks. Git's pack format and chunk cache avoid corruption,
but very large monorepositories will benefit from a future incremental pack
negotiation layer.

## Development

```bash
npm test
npm run check
```

The tests exercise real local Git repositories, fast-forward and divergence
behavior, invite validation, chunked snapshot integrity, exact Git exclusion,
automatic secret/config discovery, single-service watcher control, encrypted
multi-repository Pigeon indexing, config-only private sync, deletion and
concurrent-secret conflict safety, and a two-device simulation of PeerPigeon's
exact-key storage subscriptions.
