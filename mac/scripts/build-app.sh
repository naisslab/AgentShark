#!/bin/bash
# Build a portable desktop application. Runtime bundling is the default.
set -euo pipefail
MAC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$MAC_DIR/.." && pwd)"
BUNDLE_NODE=1
CONFIGURATION=release
for arg in "$@"; do
  case "$arg" in
    --bundle-node) BUNDLE_NODE=1 ;;
    --without-node) BUNDLE_NODE=0 ;;
    --debug) CONFIGURATION=debug ;;
    --help|-h) echo "Usage: $0 [--debug] [--without-node]. NODE and NODE_LICENSE select an offline runtime; default downloads verified Node 24 LTS."; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done
cd "$REPO"
APP="${APP_OUTPUT:-$REPO/dist/AgentShark.app}"
[[ "$APP" == /* ]] || APP="$REPO/$APP"
# iCloud Drive's Desktop and Documents folders tag every bundle with Finder information, which codesign rejects.
DIR="$(dirname "$APP")"
while [[ "$DIR" != / ]]; do
  if xattr -p com.apple.file-provider-domain-id "$DIR" > /dev/null 2>&1; then
    echo "$DIR is synced by iCloud Drive, which adds Finder information that codesign rejects. Set APP_OUTPUT to a folder outside it." >&2; exit 1
  fi
  DIR="$(dirname "$DIR")"
done
node scripts/build.mjs
if [[ "$BUNDLE_NODE" == 1 ]]; then
  # npm run sets NODE to the interpreter running npm; that is not a runtime choice.
  if [[ -n "${npm_node_execpath:-}" && "${NODE:-}" == "$npm_node_execpath" ]]; then unset NODE; fi
  if [[ -z "${NODE:-}" ]]; then
    NODE="$(node scripts/fetch-runtime.mjs --platform darwin --arch "$(node -p 'process.arch')" --out "${RUNTIME_CACHE:-$REPO/.runtime}")"
  fi
  NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")"
  NODE_LICENSE="${NODE_LICENSE:-$(dirname "$NODE")/../LICENSE}"
  [[ -f "$NODE_LICENSE" ]] || { echo "Runtime license is missing; set NODE_LICENSE to the official Node LICENSE." >&2; exit 1; }
  PROBE="$(mktemp -d)"
  trap 'rm -rf "$PROBE"' EXIT
  cp "$NODE" "$PROBE/node"
  "$PROBE/node" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; import { createZstdCompress } from "node:zlib"; const db=new DatabaseSync(":memory:"); if(typeof db.location!=="function" || typeof db.isTransaction!=="boolean" || typeof createZstdCompress!=="function") process.exit(1); db.close()'
  "$PROBE/node" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<24 || major===24&&minor<12) process.exit(1)'
  if otool -L "$PROBE/node" | tail -n +2 | grep -qvE '^[[:space:]]+(/usr/lib/|/System/)'; then
    echo "Runtime is not self-contained. Use an official nodejs.org build." >&2; exit 1
  fi
fi
SWIFT_BUILD_PATH="${SWIFT_BUILD_PATH:-$MAC_DIR/.build}"
swift build --package-path "$MAC_DIR" --scratch-path "$SWIFT_BUILD_PATH" -c "$CONFIGURATION" --product AgentShark
BIN="$(swift build --package-path "$MAC_DIR" --scratch-path "$SWIFT_BUILD_PATH" -c "$CONFIGURATION" --show-bin-path)/AgentShark"
CONTENTS="$APP/Contents"
RES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$RES"
install -m 755 "$BIN" "$CONTENTS/MacOS/AgentShark"
printf 'APPL????' > "$CONTENTS/PkgInfo"
VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).version')"
# A source download without git history (GitHub's Download ZIP) builds as number 0.
BUILD="${BUILD_NUMBER:-$(git rev-list --count HEAD 2> /dev/null || echo 0)}"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" "$MAC_DIR/Resources/Info.plist" > "$CONTENTS/Info.plist"
plutil -lint -s "$CONTENTS/Info.plist"
ICON_CACHE="$SWIFT_BUILD_PATH/icon"
mkdir -p "$ICON_CACHE"
swift "$MAC_DIR/scripts/make-icon.swift" "$ICON_CACHE/AppIcon.iconset" > /dev/null
iconutil -c icns -o "$RES/AppIcon.icns" "$ICON_CACHE/AppIcon.iconset"
mkdir -p "$RES/backend"
rsync -a --delete "$REPO/build/" "$RES/backend/"
cp "$REPO/LICENSE" "$RES/AgentShark-LICENSE"
cp "$REPO/NOTICE" "$RES/NOTICE"
if [[ "$BUNDLE_NODE" == 1 ]]; then
  install -m 755 "$NODE" "$RES/node"
  cp "$NODE_LICENSE" "$RES/Node-LICENSE"
else
  rm -f "$RES/node" "$RES/Node-LICENSE"
  echo "Development-only bundle: a system Node runtime will be required." >&2
fi
xattr -cr "$APP"
IDENTITY="${CODESIGN_IDENTITY:--}"
if [[ "$IDENTITY" == "-" ]]; then
  [[ "$BUNDLE_NODE" == 0 ]] || codesign --force --sign - "$RES/node"
  codesign --force --sign - "$APP"
else
  [[ "$BUNDLE_NODE" == 0 ]] || codesign --force --options runtime --timestamp --entitlements "$MAC_DIR/Resources/runtime-entitlements.plist" --sign "$IDENTITY" "$RES/node"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
fi
codesign --verify --deep --strict "$APP"
echo "Built $APP ($VERSION). Runtime bundled: $BUNDLE_NODE. Signing identity: $IDENTITY"
