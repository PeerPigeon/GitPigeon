#!/bin/sh
set -eu

binary=${1:?standalone GitPigeon binary is required}
output=${2:?output deb path is required}
version=${3:-0.1.0}
arch=${4:-amd64}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

install -d "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/share/applications" "$stage/etc/xdg/autostart"
install -m 0755 "$binary" "$stage/usr/bin/git-pigeon"
printf '%s\n' \
  'Package: gitpigeon' \
  "Version: $version" \
  'Section: devel' \
  'Priority: optional' \
  "$([ "$arch" = x64 ] && printf 'Architecture: amd64' || printf 'Architecture: %s' "$arch")" \
  'Maintainer: PeerPigeon <opensource@gitpigeon.dev>' \
  'Description: Real-time peer-to-peer synchronization for native Git repositories' \
  'Depends: git' > "$stage/DEBIAN/control"
printf '%s\n' \
  '[Desktop Entry]' \
  'Name=GitPigeon' \
  'Comment=Approve this device and open your Pigeons' \
  'Exec=/usr/bin/git-pigeon install --enroll' \
  'Terminal=false' \
  'Type=Application' \
  'MimeType=x-scheme-handler/gitpigeon;' \
  'Categories=Development;' > "$stage/usr/share/applications/gitpigeon.desktop"
printf '%s\n' \
  '[Desktop Entry]' \
  'Name=GitPigeon background service' \
  'Exec=/usr/bin/git-pigeon install' \
  'Terminal=false' \
  'Type=Application' \
  'NoDisplay=true' \
  'X-GNOME-Autostart-enabled=true' > "$stage/etc/xdg/autostart/gitpigeon.desktop"
dpkg-deb --root-owner-group --build "$stage" "$output"
