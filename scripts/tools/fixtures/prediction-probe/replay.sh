#!/usr/bin/env bash
# Build the diagnostic module in a fresh directory and read the three QA streams.
set -euo pipefail
scripts=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$scripts/../../../.." && pwd)
work=${1:?Usage: bash replay.sh NEW_DIRECTORY}
mkdir "$work"
cd "$work"
work=$(pwd)
emcc --version | head -1 | grep -F '6.0.9'
mkdir builder ffmpeg work
fetch() {
  curl --fail --silent --show-error --location "https://codeload.github.com/Nakiha/$1/tar.gz/$2" |
    tar -xz --strip-components=1 -C "$3"
}
fetch VoidPlayer-FFmpeg-Build 5ccd3566bdb791e44479439c81b4852fa3340183 builder
fetch FFmpeg fc5b9f1c45775b46cba7c1d9000977df27724080 ffmpeg
patch -p1 < "$scripts/collector.patch"
cp builder/analysis/stream.c ffmpeg/libavcodec/voidplayer_vachunk.c
cp builder/analysis/voidplayer_block_sort.h ffmpeg/libavcodec/
cd work
emconfigure ../ffmpeg/configure --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --target-os=none --arch=wasm32 --cpu=generic --enable-cross-compile --disable-stripping --disable-programs \
  --disable-doc --disable-debug --disable-avdevice --disable-avfilter --disable-swresample --disable-swscale \
  --disable-avformat --disable-network --disable-everything --disable-autodetect --disable-pthreads --disable-w32threads \
  --disable-os2threads --enable-voidplayer-analysis --enable-avcodec --enable-avutil --enable-decoder=h264,hevc,vvc \
  --enable-parser=h264,hevc,vvc --optflags=-O2 --extra-cflags='-msimd128 -DVP_HEVC_NO_PIXELS=1 -DVP_VVC_NO_PIXELS=1'
make -j"${JOBS:-8}"
symbols=_malloc,_free,_vp_probe_count,_vp_probe_rows,_vpa_open,_vpa_execution_mode,_vpa_feed,_vpa_step,_vpa_drain
symbols+=,_vpa_count,_vpa_ordinal,_vpa_poc,_vpa_take,_vpa_blocks,_vpa_close,_vpa_invalid,_vpa_execution_path
emcc -O2 -msimd128 libavcodec/libavcodec.a libavutil/libavutil.a -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=node \
  -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=4194304 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 -sFILESYSTEM=0 \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8 -sEXPORTED_FUNCTIONS="$symbols" -o "$work/probe.mjs"
cd "$work"
capture() {
  for mode in 0 1; do
    node "$scripts/read.mjs" ./probe.mjs "$1" "$root/fixtures/video/$2" "$mode" "$1-$mode.jsonl"
  done
  node "$scripts/read.mjs" "$root/public/vendor/voidplayer-analysis/voidplayer-analysis.js" \
    "$1" "$root/fixtures/video/$2" 1 "$1-release.jsonl"
}
capture avc h264_9s_1920x1080.mp4
capture hevc h265_10s_1920x1080.mp4
capture vvc h266_10s_1920x1080.mp4
