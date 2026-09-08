# Growing FLV timelines and open GOP

FLV has two distinct time concepts:

- `FlvIndex.firstPts` is the earliest indexed packet PTS. It can decrease when a
  background scan discovers reordered pictures.
- `flvMediaTiming().firstPtsUs` is the immutable media origin: the first
  decode-order key packet's PTS. Public frame times and marks are relative to it.

Index completion preserves the origin and computes duration from the final
presentation end minus that origin. Negative relative packet times are retained
as preroll, including in server caches; H.264 packets are not filtered by their
PTS. `PacketTimeline` feeds decode order and uses actual decoder outputs for
presentation. The review interval starts at the initial key picture; discovering
preroll does not move the already displayed picture or existing marks.

This does not claim that every FLV key flag is an IDR, or that every leading
picture is independently decodable. H.264 open GOP uses recovery semantics, not
HEVC's CRA terminology. Decoder output is authoritative for what can be shown.

A failed background index is not EOF. A generator resumed after an index failure
must reject before attempting to continue beyond its startup index. Completion
logs include the stable origin, earliest relative packet PTS, packet count, old
and new durations, and cache source.

## Regression evidence

`scripts/open-gop-fixture.ts` generates x264 open GOP with a fixed GOP and B-frame
pattern, then stream-copies a cut at the second recovery point. The regression
asserts that at least one packet precedes the startup origin; it compares every
WASM display timestamp against independent FFmpeg decoding, checks cache timing,
and verifies repeated seeks return identical pixels at time zero. This fixture
is generated test media, not an FFmpeg FATE download.

`check-flv-startup-browser.mjs` also exercises the cut in Chromium and WebKit,
checks completed duration and stable time zero, and benchmarks actual track
advancement (not merely the session clock). The release workflow gates on these
checks and the existing FATE oracle suite.

The official [FATE H.264 samples](https://fate-suite.ffmpeg.org/h264/) include
`h264_4bf_pyramid_nobsrestriction.mp4` (already pinned by this project) and
`intra_refresh.h264`; FFmpeg's
[H.264 FATE definitions](https://github.com/FFmpeg/FFmpeg/blob/master/tests/fate/h264.mak)
include `fate-h264-intra-refresh-recovery`. These cover related reordering and
recovery behavior, but neither is asserted to reproduce the reported CDN FLV
cut. Use the generated regression for that exact startup/full-index conflict.
