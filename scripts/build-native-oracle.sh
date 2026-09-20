#!/usr/bin/env bash
# Minimal native reference decoder for raw-plane comparisons in Linux CI.
# Source revision is supplied by the same immutable release lock as the WASM core.
set -euo pipefail
source_dir="$(cd "$1" && pwd)"
output_dir="$2"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
cd "$source_dir"
./configure --disable-everything --disable-autodetect --disable-doc --disable-network \
  --disable-x86asm --disable-programs --enable-ffmpeg \
  --enable-protocol=file,pipe --enable-demuxer=mov,matroska,rawvideo \
  --enable-decoder=ffv1,hevc,vvc,rawvideo --enable-encoder=rawvideo,ffv1 \
  --enable-muxer=rawvideo,matroska --enable-filter=setsar,format,null,scale \
  --enable-parser=hevc,vvc --enable-swscale --enable-avfilter
make -j2 ffmpeg
cp ffmpeg "$output_dir/ffmpeg"
"$output_dir/ffmpeg" -version
