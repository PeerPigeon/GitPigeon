#!/bin/sh
set -eu

binary=${1:?standalone GitPigeon binary is required}
output=${2:?output package path is required}
version=${3:-0.1.0}
stage=$(mktemp -d)
scripts=$(mktemp -d)
trap 'rm -rf "$stage" "$scripts"' EXIT

install -d "$stage/usr/local/bin" "$stage/Applications/GitPigeon.app/Contents/MacOS"
install -m 0755 "$binary" "$stage/usr/local/bin/git-pigeon"
printf '%s\n' '#!/bin/sh' \
  'case "${1-}" in' \
  '  gitpigeon:*) exec /usr/local/bin/git-pigeon protocol "$1" ;;' \
  '  *) exec /usr/local/bin/git-pigeon "$@" ;;' \
  'esac' > "$stage/Applications/GitPigeon.app/Contents/MacOS/git-pigeon-handler"
chmod 0755 "$stage/Applications/GitPigeon.app/Contents/MacOS/git-pigeon-handler"
printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0"><dict>' \
  '<key>CFBundleDisplayName</key><string>GitPigeon</string>' \
  '<key>CFBundleExecutable</key><string>git-pigeon-handler</string>' \
  '<key>CFBundleIdentifier</key><string>dev.gitpigeon.native</string>' \
  '<key>CFBundleName</key><string>GitPigeon</string>' \
  '<key>CFBundlePackageType</key><string>APPL</string>' \
  "<key>CFBundleShortVersionString</key><string>$version</string>" \
  '<key>LSUIElement</key><true/>' \
  '<key>CFBundleURLTypes</key><array><dict>' \
  '<key>CFBundleURLName</key><string>dev.gitpigeon.clone</string>' \
  '<key>CFBundleURLSchemes</key><array><string>gitpigeon</string></array>' \
  '</dict></array>' \
  '</dict></plist>' > "$stage/Applications/GitPigeon.app/Contents/Info.plist"

printf '%s\n' '#!/bin/sh' \
  'set -eu' \
  'console_user=$(stat -f %Su /dev/console)' \
  'if [ "$console_user" != root ] && [ "$console_user" != loginwindow ]; then' \
  '  uid=$(id -u "$console_user")' \
  '  launchctl asuser "$uid" sudo -u "$console_user" /usr/bin/open -a /Applications/GitPigeon.app --args install >/dev/null 2>&1 &' \
  'fi' \
  'exit 0' > "$scripts/postinstall"
chmod 0755 "$scripts/postinstall"

pkgbuild \
  --root "$stage" \
  --scripts "$scripts" \
  --identifier dev.gitpigeon.native \
  --version "$version" \
  --install-location / \
  "$output"
