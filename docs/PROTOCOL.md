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

1. Read branches, tags, live working-tree deviations from `HEAD`, and the exact
   private paths registered in `.git/gitpigeon/tracked-files.json`.
2. Run `git bundle create --branches --tags` when Git refs exist.
3. Split bundle, live-code, and private-file bytes into 16 KiB chunks.
4. Store chunks in PeerPigeon `frozen` space by SHA-256.
5. Store a manifest containing the bundle descriptor, live-code descriptors,
   private-file descriptors, and deletion tombstones in `frozen` space by the
   composite snapshot SHA-256.
6. Update the publishing device's `public` head.

Consumers subscribe to the registry and known head keys. After receiving a new
head, they explicitly retrieve the manifest and each missing chunk. Every chunk,
the total bundle size, bundle digest, live-file size, private-file size, and all
file digests are verified before anything is applied. PeerPigeon's storage
session encrypts the synchronized envelopes with the invite secret.

An online native peer additionally advertises its current PeerPigeon transport
ID in the encrypted presence lease. A browser can request the manifest's bundle
over the existing WebRTC data channel using `GPSTRM1` frames. Request, data,
cumulative acknowledgement, end, error, and cancel frames are sealed with
AES-256-GCM under a key derived from the repository secret. Each frame uses a
fresh 96-bit IV and authenticates its type, random request ID, and sequence
number. The sender permits at most 32 unacknowledged 16 KiB frames and the
browser acknowledges every eight consumed frames. The browser exposes those
ordered frames as a backpressured `ReadableStream`, verifies each descriptor and
the complete bundle digest, and falls back to exact-key PeerPigeon storage for
any missing frame. Durable chunk addressing and recovery therefore remain the
same; the direct stream removes per-record request latency while the watcher is
online.

Persistent content chunks in `.git/gitpigeon/chunks/` are independently sealed
with AES-256-GCM using a repository-secret-derived local cache key. The content
SHA-256 is authenticated as associated data. This prevents the cache from
leaving a second plaintext copy of a private file outside the working tree.

The version-2 composite snapshot ID binds the optional Git bundle digest, the
private workspace digest, and the live workspace digest. A separate head
content digest binds Git ref object IDs and both workspace digests, allowing the
watcher to detect code-only or config-only changes without generating a new Git
bundle. A manifest may contain only live or private files, so repositories
without a first commit can synchronize immediately. Readers remain compatible
with version-1 manifests that have no live workspace fields.

## Import safety

Bundle branches are fetched into device-scoped remote-tracking refs first. A
local branch is updated only when:

- it does not exist and the checkout is clean; or
- its current object is an ancestor of the incoming object and the checkout is
  clean when that branch is checked out.

Already-ahead branches are left alone. Divergent branches are left alone and
reported with the corresponding remote-tracking ref. Tags are created only when
the local tag does not already exist.

## Live working-tree CRUD safety

Every non-ignored tracked deviation from `HEAD`, plus each non-ignored untracked
regular file, is represented in the live workspace manifest. A rename is a
delete plus a create. Generated dependency, build, cache, and coverage trees are
excluded. Live code has no GitPigeon file-size cap. Exact private paths are
removed from this channel and sent only through the private workspace channel.

Each live descriptor binds its incoming content to the SHA-256 of that path in
the publisher's `HEAD`. A receiver applies a create, update, or delete only when
its current file matches that Git baseline, the incoming value, or the last
live value received from that device. Concurrent local edits are never
overwritten; incoming bytes are stored under
`.git/gitpigeon/live-conflicts/<device>/`, with a `.deleted-by-peer` marker for
an incoming deletion.

When a publishing device commits its live overlay, the receiver first restores
only unchanged received-overlay paths to its current `HEAD`, performs the
normal Git fast-forward, and then applies any remaining live descriptors on top
of the new commit. Staged or independently edited local files are not restored.

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

`init` registers a repository and ensures that exactly one detached Node service
is running for the operating-system user. An exclusive startup lock serializes
concurrent `init` and `watch` calls. The service owns every registered
repository session plus one machine-index PeerPigeon session; adding a second
repository never launches a second process.

The service PID, random control token, heartbeat, startup lock, and log live in
GitPigeon's per-user application-data directory. The file-based control channel
works across macOS, Linux, and Windows and needs neither a Unix socket nor a
loopback port. `unwatch` only removes one repository from the persistent index;
the running service observes that change and closes that repository session.
`stop` sends one token-authenticated stop request to the service and leaves all
repository entries intact with an inactive status.

The machine directory is stored as an encrypted `public`-space record; `public`
describes its ACL inside that session, while PeerPigeon's `syncSecret` encrypts
the entire synchronization envelope. Each directory item includes a live
watcher count, which is one while the machine service owns that repository
session and zero while the service is stopped.

GitPigeon does not set a signaling relay for repository, machine-index, or
enrollment sessions by default. PeerPigeon independently selects a nearby
FreeRTC relay for each peer. Peers remain discoverable because FreeRTC federates
the exact shared Network + Room scope across its Kademlia relay overlay. An
explicit signaling URL in an older or custom repository invite remains an
opt-in override for that repository only.

## Browser enrollment

`init` never places the permanent machine-index capability in a URL. It creates
a two-minute pairing ID, an ephemeral PeerPigeon sync secret, a P-256 ECDH key,
and a random six-digit approval code. The URL fragment contains only the pairing
ID, ephemeral sync secret, and native ephemeral public key; fragments are not
sent to the web server.

The browser generates its own P-256 key and encrypts the terminal code to the
ECDH shared key using AES-256-GCM. The claim is bound to the pairing ID, browser
ID, and browser public key as authenticated data. The native peer permits five
attempts. On success it encrypts the permanent index ID and secret to the same
browser-specific ECDH key, waits for an authenticated acknowledgment, and then
destroys the temporary PeerPigeon node. Enrollment therefore proves possession
of both the short-lived URL rendezvous and the out-of-band terminal code without
exposing the permanent capability to either one. Native state is marked paired
only after that acknowledgment. A failed or abandoned attempt remains pending,
so the next `init` creates a fresh enrollment instead of suppressing the code.

`git pigeon pair` creates another temporary enrollment. `git pigeon pair
--rotate` changes the permanent machine-index secret before enrollment, which
invalidates prior browser capabilities. Version-1 machine-index state is marked
legacy and automatically rotates during its first secure enrollment. No HTTP
listener or loopback bridge participates in discovery or approval.
