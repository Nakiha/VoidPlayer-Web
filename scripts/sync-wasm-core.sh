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

# Handles both raw sibling ST/MT builds and flat, pinned release artifacts.
node "$SCRIPT_DIR/core-artifacts.mjs" "$SRC" "$DEST"
