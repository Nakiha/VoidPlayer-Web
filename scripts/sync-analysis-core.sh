#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${ANALYSIS_CORE_DIR:-${1:-$(dirname "$ROOT")/VoidPlayer-FFmpeg-Build/dist/voidplayer-analysis}}"
node "$ROOT/scripts/prepare-analysis-core.mjs" "$SOURCE"
