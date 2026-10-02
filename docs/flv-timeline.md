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
  policy adds no lookahead frame or extra startup decode for zero-reorder sources.
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

## Native HEVC callback reordering

The shared MP4/FLV native decoder reads `sps_max_num_reorder_pics` across every
SPS sublayer. It keeps that many decoded resources across asynchronous output
callbacks and releases the smallest actual output PTS only when the queue exceeds
the bound. Sorting one callback batch alone cannot handle a later B-picture
callback arriving after a future reference picture. A zero bound preserves the
existing immediate-output behavior; unknown/invalid bounds decline native
decoding through the existing decode-stage selection.

Input backpressure allows feeding while only the reorder window is retained,
and the accepted input window is at least the reorder bound plus one. Otherwise
a legal large DPB can stall before producing any output. Flush releases the final
retained pictures; reset, configuration changes and close explicitly close old
resources. Queue limits remain bounded and diagnostics report the reorder bound.
The timeline still rejects genuinely decreasing output timestamps. No timestamp,
source color tag or output pixel resource is relabeled.

`check-hlg-browser.mjs` checks every frame against independent FFprobe display
times for both local and Range inputs, including EOF, repeated seeks/steps and
same-browser pixel identity. On macOS WebKit it also requires native decoding.
The simulated decoder regressions cover separate out-of-order callbacks, the
maximum declared reorder bound, deferred input and resource release. The real
HLG UI regression continues to require successful playback in browser color.

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

## Damaged tails

Incomplete trailing tags retain complete indexed packets. A structurally corrupt
suffix (stream ID, tag type/flags or footer mismatch) is also ignored only after
a configured initial key packet, within the last 64 KiB, and when a bounded scan
finds no later complete tag with a valid stream ID and footer. The index completes
with `truncatedAt` and an explicit warning, persisted in shared caches. Interior gaps can recover after a playable prefix: search at most 4 KiB ahead
and validate two consecutive complete, nonempty tags (type/flags, stream ID,
size and PreviousTagSize). Candidate probing is capped at 64 chains and recovery
at 16 gaps per file. The normal codec/configuration parser still validates every
resumed tag. Original offsets, timestamps and compressed packets are retained;
no frames or timestamps are invented. `recoveredGaps` survives immutable scan
checkpoints and cache round trips and produces an explicit warning. Inserted
garbage can leave decoding unchanged; lost compressed data may affect nearby
pictures and still fail decoding. Unproven or over-limit gaps, longer corrupt
suffixes, IO/version errors and codec/configuration errors remain failures.
Recovery never indexes bytes from the rejected gap or suffix.

## Index ownership and shared scanner

Library URLs (`/api/media/<id>?v=<version>`) request a server build on cache miss.
The server Worker reads the library file directly through a bounded 2 MiB disk
cache and runs the same `scanFlv` used for local files. Parsing, reorder handling,
duplicate timestamps, damaged tails and bounded resynchronization are identical.
FLV remains outside FFmpeg demuxing; index building needs no decoder or WASM core.
Builds share the version/identity/epoch-deduplicated queue and SQLite cache, and
verify the file descriptor and current path version before committing.

Startup still reads only enough compressed bytes to display the first frame.
Server scan progress is streamed, then the completed FLV document transfers in
resumable NDJSON chunks. This does not yet publish FLV packet prefixes during
server scanning; seeks/playback beyond startup coverage wait for the completed
index. Cache hits skip building. Local Blob files and arbitrary URLs without a
library service endpoint scan on the client. A library server failure or index
prefix mismatch is explicit, never a silent full-file browser rescan.
