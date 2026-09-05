#!/usr/bin/env bash
set -euo pipefail

# Copies the self-built VoidPlayer WASM decoder core into public/vendor for
# bundling. Default source: the sibling VoidPlayer-FFmpeg-Build checkout's
# dist output (branch `wasm`, see its README). Override with WASM_CORE_DIR
# or the first argument.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_ROOT="$(dirname "$SCRIPT_DIR")"
DEFAULT_SRC="$(cd "$BROWSER_ROOT/.." && pwd)/VoidPlayer-FFmpeg-Build/dist/voidplayer-ffmpeg-wasm-n9.0.1"
SRC="${WASM_CORE_DIR:-${1:-$DEFAULT_SRC}}"
DEST="$BROWSER_ROOT/public/vendor/voidplayer-core"

for f in voidplayer-core.js voidplayer-core.wasm; do
    [ -f "$SRC/$f" ] || { echo "ERROR: $SRC/$f not found. Build it with VoidPlayer-FFmpeg-Build/scripts/build-wasm.sh" >&2; exit 1; }
done

mkdir -p "$DEST"
cp "$SRC/voidplayer-core.js" "$SRC/voidplayer-core.wasm" "$DEST/"
# Multi-threaded variant (build with --mt): optional, used when the page is
# cross-origin isolated.
MT_SRC="$(dirname "$SRC")/voidplayer-ffmpeg-wasm-mt-n9.0.1"
if [ -f "$MT_SRC/voidplayer-core-mt.js" ]; then
    cp "$MT_SRC/voidplayer-core-mt.js" "$MT_SRC/voidplayer-core-mt.wasm" "$DEST/"
    echo "synced multi-threaded core from $MT_SRC"
fi
[ -d "$SRC/LICENSES" ] && rm -rf "$DEST/LICENSES" && cp -R "$SRC/LICENSES" "$DEST/"
echo "synced $SRC -> $DEST"
