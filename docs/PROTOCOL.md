# GitPigeon protocol v1

GitPigeon uses one PeerPigeon session per repository. The mesh session is the
repository ID and storage key derivation uses `gitpigeon-v1:<repository-id>` plus
the invite's sync secret.

## Storage keys

For repository `R` and device `D`:

```text
public gitpigeon/v1/R/registry
public gitpigeon/v1/R/head/D
frozen gitpigeon/v1/R/manifest/<bundle-sha256>
frozen gitpigeon/v1/R/chunk/<chunk-sha256>
```

The registry contains a sorted set of device IDs. Each participant unions that
set with its locally known IDs and republishes only when the union differs. A
head key has one logical writer, so concurrent devices do not overwrite one
another's reachable history.

## Publication order

1. Run `git bundle create --branches --tags`.
2. Split the resulting bytes into 16 KiB chunks.
3. Store chunks in PeerPigeon `frozen` space by SHA-256.
4. Store the manifest in `frozen` space by the bundle SHA-256.
5. Update the publishing device's `public` head.

Consumers subscribe to the registry and known head keys. After receiving a new
head, they explicitly retrieve the manifest and each missing chunk. Every chunk,
the total bundle size, and the final bundle digest are verified before Git sees
the bundle.

## Import safety

Bundle branches are fetched into device-scoped remote-tracking refs first. A
local branch is updated only when:

- it does not exist and the checkout is clean; or
- its current object is an ancestor of the incoming object and the checkout is
  clean when that branch is checked out.

Already-ahead branches are left alone. Divergent branches are left alone and
reported with the corresponding remote-tracking ref. Tags are created only when
the local tag does not already exist.

