#!/usr/bin/env bash
set -euo pipefail

# Synthesizes the HLG regression sample from the shared H.265 sample.
# The upstream QA sparse checkout does not carry dolby_hlg_1080p30.mp4, so CI
# generates it deterministically instead of depending on an external binary.
# Never overwrites an existing file (keeps a manually synced original).

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/fixtures/video/h265_10s_1920x1080.mp4"
DEST="$REPO_ROOT/fixtures/video/dolby_hlg_1080p30.mp4"

[ -f "$SRC" ] || { echo "ERROR: HLG source sample not found: $SRC (sync samples first)" >&2; exit 1; }
if [ -f "$DEST" ]; then echo "hlg fixture exists, skip: $DEST"; exit 0; fi
ffmpeg -y -v error -i "$SRC" -t 9.4 -c:v libx265 -pix_fmt yuv420p10le -preset veryfast -crf 23 \
  -x265-params colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited \
  -brand mp42 "$DEST"
echo "hlg fixture: $DEST"
