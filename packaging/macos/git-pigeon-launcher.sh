#!/bin/sh
# GitPigeon launcher. Root installs this file once; no future release needs
# root again. The real binary auto-updates into the invoking user's state
# directory, so this launcher prefers the newest verified update binary and
# falls back to the packaged one. Keep it POSIX sh with no dependencies.
set -u
state="${GITPIGEON_STATE_DIR:-$HOME/Library/Application Support/GitPigeon}"
record="$state/updates/current.json"
if [ -r "$record" ]; then
  candidate=$(sed -n 's/.*"executable"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$record" | head -n 1)
  # Mirror readInstalledUpdate's containment check: only run executables
  # that live inside the state directory's updates tree.
  case "$candidate" in
    "$state/updates/"*)
      if [ -x "$candidate" ]; then exec "$candidate" "$@"; fi
      ;;
  esac
fi
if [ -x /usr/local/libexec/gitpigeon/git-pigeon ]; then
  exec /usr/local/libexec/gitpigeon/git-pigeon "$@"
fi
# Last resort: the newest version directory the auto-updater left behind,
# for machines whose update record was cleared mid-replace.
newest=$(ls "$state/updates" 2>/dev/null \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
if [ -n "${newest:-}" ] && [ -x "$state/updates/$newest/git-pigeon" ]; then
  exec "$state/updates/$newest/git-pigeon" "$@"
fi
echo 'git-pigeon: no GitPigeon binary found; reinstall from https://gitpigeon.dev' >&2
exit 1
