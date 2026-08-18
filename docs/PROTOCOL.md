# GitPigeon protocol v1

GitPigeon uses one PeerPigeon session per repository. The mesh session is the
repository ID and storage key derivation uses `gitpigeon-v1:<repository-id>` plus
the invite's sync secret.

## Storage keys

For repository `R` and device `D`:

```text
public gitpigeon/v1/R/registry
public gitpigeon/v1/R/head/D
frozen gitpigeon/v1/R/manifest/<snapshot-sha256>
frozen gitpigeon/v1/R/chunk/<chunk-sha256>
```

The registry contains a sorted set of device IDs. Each participant unions that
set with its locally known IDs and republishes only when the union differs. A
head key has one logical writer, so concurrent devices do not overwrite one
another's reachable history.

## Publication order

1. Read branches, tags, and the exact private paths registered in
   `.git/gitpigeon/tracked-files.json`.
2. Run `git bundle create --branches --tags` when Git refs exist.
3. Split bundle and private-file bytes into 16 KiB chunks.
4. Store chunks in PeerPigeon `frozen` space by SHA-256.
5. Store a manifest containing the bundle descriptor, private-file descriptors,
   and deletion tombstones in `frozen` space by the composite snapshot SHA-256.
6. Update the publishing device's `public` head.

Consumers subscribe to the registry and known head keys. After receiving a new
head, they explicitly retrieve the manifest and each missing chunk. Every chunk,
the total bundle size, bundle digest, private-file size, and private-file digest
are verified before anything is applied. PeerPigeon's storage session encrypts
the synchronized envelopes with the invite secret.

Persistent content chunks in `.git/gitpigeon/chunks/` are independently sealed
with AES-256-GCM using a repository-secret-derived local cache key. The content
SHA-256 is authenticated as associated data. This prevents the cache from
leaving a second plaintext copy of a private file outside the working tree.

The composite snapshot ID binds the optional Git bundle digest and the private
workspace digest. A separate head content digest binds Git ref object IDs and
the workspace digest, allowing the watcher to detect a config-only change
without generating a Git bundle on every poll. A manifest may contain only
private files, so repositories without a first commit can still sync config.

## Import safety

Bundle branches are fetched into device-scoped remote-tracking refs first. A
local branch is updated only when:

- it does not exist and the checkout is clean; or
- its current object is an ancestor of the incoming object and the checkout is
  clean when that branch is checked out.

Already-ahead branches are left alone. Divergent branches are left alone and
reported with the corresponding remote-tracking ref. Tags are created only when
the local tag does not already exist.

## Private workspace safety

At initialization and periodically while watching, GitPigeon discovers regular
files that are ignored by Git or have conventional secret/local-config names.
Automatic files are capped at 1 MiB and generated dependency, build, coverage,
and cache directories are excluded. Explicitly tracked private paths bypass the
size and naming heuristic but remain exact repository-relative regular files.

Each device mirrors the private path list into a managed `.git/info/exclude`
section, keeping the files out of Git without publishing a `.gitignore` change.
Manifest entries contain either content descriptors or deletion tombstones.

For each path, the receiver records the newest peer version as a baseline. An
incoming update is applied only when the local file is missing, identical to the
incoming file, or still identical to that baseline. A concurrent local edit is
never overwritten: the incoming bytes are stored under
`.git/gitpigeon/conflicts/<device>/`, and incoming deletion is represented by a
`.deleted-by-peer` marker. Selecting the incoming conflict copy makes that
version the local baseline for subsequent updates.

## Watcher lifecycle

`init` launches the watcher as a detached Node process with inherited log file
descriptors and no shell. Its PID, random control token, and heartbeat live under
`.git/gitpigeon/`. `unwatch` writes a token-authenticated stop request that the
watcher polls locally. This file-based control channel works across macOS,
Linux, and Windows and does not require a Unix socket or loopback port. Stale
state is ignored, and an unresponsive authenticated watcher is terminated when
the user explicitly requests `unwatch`.
