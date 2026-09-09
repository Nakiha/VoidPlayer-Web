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

## Equal presentation timestamps

Compressed packets and display instants are different identities. Distinct FLV
packets may carry equal PTS, including a dependent picture followed by a key
picture with different DTS/composition offsets. This is recorded as an index
warning rather than failing the entire track. It does not identify who produced
the timestamp collision or prove the pictures contain identical pixels.

- `packets` and stable `order` retain every packet with its original PTS/DTS.
  Equal PTS preserve decode-order ties across incremental merges and cache reads.
- `displayOrder`, when present, selects the first packet of each equal-PTS group.
  Public times are unique; each group spans to the next distinct timestamp.
  The final group uses the last positive interval, or the existing 40ms fallback
  when the file has only one distinct timestamp. No synthetic timestamps appear.
- The shared packet timeline accepts nondecreasing decoder output PTS. The first
  output at each instant is displayed; subsequent equal-PTS resources are closed.
  Actual decreasing or invalid decoder timestamps still fail explicitly. This
  policy adds no lookahead frame or extra startup decode for normal sources.
  Some decoders recover distinct best-effort output times from DTS despite
  packet PTS collisions. Those distinct actual outputs remain visible; packet
  grouping must not override a decoder's recovered display timestamps.
- Seek selects the first packet in the target equal-PTS group before locating
  the decode anchor. A later key packet at the same PTS must not replace an
  earlier picture just because the user seeks. The policy relies on the decoder
  retaining its display order for equal timestamps; it does not invent picture
  identities for outputs whose timestamps have genuinely moved backwards.
- Cache payloads continue to contain all original packets; derived unique times
  and warnings are rebuilt on read. No cache schema bump or source rewrite is
  required. Warnings include duplicate count and the first conflicting offsets.

This is a temporal display policy, not a lossless inspection UI for multiple
pictures at one instant. Such an inspector would need picture IDs beyond PTS;
ordinary playback and stepping advance through distinct display times.

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

WebCodecs AVC `key` chunks require an IDR picture, per the
[AVC codec registration](https://www.w3.org/TR/webcodecs-avc-codec-registration/#encodedvideochunk-type).
Native decoding now inspects NALs rather than copying the container key flag.
A cut beginning at a non-IDR recovery point fails the native first-frame contract
before feeding the browser and selects WASM during open, with an explicit reason.
This fixes the browser-only seek failure exposed after the initial timeline fix.

## Playback ownership

Session queues are keyed by source identity. Pause suspends them without losing
unseen frames. Removing/replacing a track releases only that source's queue;
position changes and stepping invalidate sources before touching their decoder.
A removal which clamps the common clock therefore still repositions survivors.
Workspace replacement and disposal release all remaining queues.

Logs distinguish reused queues from newly created queues and record why a queue
was released. Native FLV diagnostics include capability probe preferences and
results, policy exclusions, and first-frame failure reasons. Packet open logs
also include the chosen WASM variant and requested thread count. Neither a
hardware preference nor capability acceptance proves the GPU actually used.
