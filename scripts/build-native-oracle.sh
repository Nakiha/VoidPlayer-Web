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
  --enable-protocol=file,pipe --enable-demuxer=mov,matroska,rawvideo,mpegts,flv,avi,mpegps,mpegvideo \
  --enable-libdav1d --enable-decoder=ffv1,h264,hevc,vvc,rawvideo,mpeg1video,mpeg2video,mpeg4,mjpeg,prores,vp8,vp9,libdav1d --enable-encoder=rawvideo,ffv1 \
  --enable-muxer=rawvideo,matroska --enable-filter=setsar,format,null,scale,select \
  --enable-parser=h264,hevc,vvc,mpegvideo,mpeg4video,mjpeg,vp8,vp9 --enable-swscale --enable-avfilter
make -j2 ffmpeg
cp ffmpeg "$output_dir/ffmpeg"
"$output_dir/ffmpeg" -version
