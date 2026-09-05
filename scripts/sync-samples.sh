#!/usr/bin/env bash
set -euo pipefail

# Copies the shared QA sample videos into fixtures/video/ (gitignored).
# Default source: a sibling VoidPlayer checkout's resources/video.
# Override with VOIDPLAYER_SAMPLES or the first argument.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SRC="${VOIDPLAYER_SAMPLES:-${1:-$(cd "$REPO_ROOT/.." && pwd)/VoidPlayer/resources/video}}"
DEST="$REPO_ROOT/fixtures/video"

[ -d "$SRC" ] || { echo "ERROR: sample directory not found: $SRC" >&2; exit 1; }
mkdir -p "$DEST"
cp "$SRC"/* "$DEST"/
echo "synced samples: $SRC -> $DEST ($(ls "$DEST" | wc -l | tr -d ' ') files)"
