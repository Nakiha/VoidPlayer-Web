# Unified media index

The shared contract unifies index identity, lifecycle, progress, persistence, transport, and player state. Container adapters keep their own record formats and rules for publishing seekable coverage.

## Current behavior

- **FFmpeg container fallback:** the main-thread `FfmpegContainerSession` owns its `FfmpegMediaIndexSession`, which starts or joins the versioned server index stream. The decoder worker opens the container and primes the first presentable frame, then returns a playable source before indexing finishes. The session sends validated manifest and record events to the worker for core import; a compatible warm cache skips the full scan.
- **MPEG-TS:** the server uses a demux-only full scan; it does not decode every packet to build timing and seek metadata. It publishes validated batches after EOF, while the first presentable frame remains independently available before index completion. TS records retain PTS, DTS, packet position/size, key flags, and seek anchors. The core's decoder-backed progressive scan remains available for comparison and focused tests.
- **Other FFmpeg containers:** the same record protocol and lifecycle apply, but without a proven stable prefix the server publishes records after its full scan. The first frame can still appear early; later seeks wait until the full index arrives.
- **Library container selection:** the versioned container endpoint classifies the source from a bounded server-side header read. The browser routes on that response and requires the appropriate server playback index.
- **MP4/QuickTime:** the server builds and caches a separate playback sample document, including fragmented sample locators, decoder configuration and HEVC picture-order recovery. The browser validates the source version and decodes only the requested sample ranges. Quality preparation retains its separate index identity.
- **FLV:** library playback waits for the completed server packet-offset document before requesting media bytes. Local Blob files and arbitrary remote URLs retain client progressive indexing.
- **Matroska/WebM:** the server records physical payload offsets and decoder configuration for admitted, untransformed video blocks. The browser reads those payloads directly. The new index build namespace rebuilds older documents on the server.
- **TS and FFmpeg container playback:** the browser uses the server index for timing and seek coverage. The decoder can still read container headers or reassemble transport packets to access encoded data. Missing or invalid library indexes do not select a browser index build.
- **Local TS:** a bounded, closed-GOP startup prefix can present before the background scan. The source grows only at verified GOP boundaries, holds at the frontier, and retains the initial presentation clock. The full result must agree with all published packets before the live decoder consumes it. MPEG-2, broadcast recovery and sources without a qualifying startup GOP keep the finite route.
- **Local TS, Matroska and WebM:** no whole-media hash or cross-open IndexedDB playback index. Fresh enumeration uses the selected Blob and preserves packet/clock checks. Library indexes retain their separate version-bound validation.
- Direct local files and non-library URLs retain client-side FFmpeg indexing. Library playback requires an import-capable core.

## Shared contract

The media index identity is `(media ID, media version, kind, stream key, schema version, indexer build)`. SQLite stores identity-keyed manifests and sequence-keyed batches. FFmpeg metadata includes source size, stream index, codec, time base, dimensions, and core build SHA. Release checks require index ABI v3, stream ABI v2, 48-byte records, the scan/export/import symbols, and a core build ID matching the pinned revision.

Mediabunny-backed TS, Matroska and MP4 playback identities include the dependency version from `shared/media/mediabunny-version.ts`, which must match `package.json`. A parser upgrade changes this namespace; old documents cannot be reused under the new identity. Metadata probes record the same parser version. Existing frozen quality witnesses are not relabeled.

The lifecycle keeps four facts separate:

1. **Presentation ready:** the first presentable frame is available.
2. **Stable coverage:** records through this relative presentation time are safe for seek and playback.
3. **Scan progress:** packets and source bytes examined so far.
4. **Index finality:** whether the complete index is known.

The first presentable source PTS is immutable after the frame is exposed. Earlier records discovered later remain demux preroll and never renormalize the public timeline. The player exposes only stable coverage for an incomplete source; scan progress and record count do not imply coverage. Reaching the current frontier waits for more records instead of reporting decoder EOF. Workspace restore continues to wait through `ensureIndexed(target)` and commits only after every track is ready. Annotations remain anchored to media identity and presented PTS, never batch sequence or record ordinal.

Payload adapters preserve format-specific seek data:

- FLV records retain packet offsets/sizes, raw timestamps, key flags, and configuration changes.
- MP4 sample indexes retain offsets/sizes, decode and presentation timing, edit-list mapping, and configuration boundaries.
- FFmpeg records retain PTS, DTS, duration, packet position/size, and flags. MPEG-TS keyframe records restore demux seek anchors. A timestamp-only list is insufficient to skip demux indexing or preserve random seek behavior.

## Server producer and transport

FFmpeg builds run in a bounded worker pool, currently one active build and eight queued builds. Builds deduplicate by full identity. The database worker remains separate, so cache lookup is not held behind a long media scan. The builder uses the bundled core and a bounded local-file reader rather than a system `ffmpeg` or `ffprobe` executable.

For a cold index, POST `/api/media/ID/frame-index/build?v=VERSION&kind=...` with an empty JSON body and the frame-index action header explicitly starts or joins a build and returns 202 (200 for a complete cache). GET `/api/media/ID/frame-index?v=VERSION&kind=...` only observes an existing build or reads its cache and returns NDJSON protocol 2 events: `manifest`, `progress`, `batch`, `complete`, and `error` (plus `reset` when the server has replaced a build). A batch includes a monotonic sequence, build ID, record count, raw FFmpeg records encoded as base64, and a safe presentation watermark. The server commits a batch to SQLite before making it visible to subscribers. Reconnects send `buildId` and `after`; a changed build is explicitly reset and clients never mix records from two builds.

The server persists scan packet/byte progress, stable coverage, and each batch. A failed build remains marked failed with its durable prefix; a subsequent explicit POST can start a new build. A complete cache hit uses the same record event protocol. Stored complete FFmpeg documents can be exposed as record batches; the HTTP read endpoint never starts a media scan. FLV uses protocol 1 progress events during its shared-parser server scan, followed by resumable chunks of the completed document; it does not yet publish playable server prefixes.

Build jobs are independent of HTTP subscribers. The server runs one build at a time with up to eight queued jobs; disconnecting a stream removes that subscriber but leaves the identity-deduplicated job running. NDJSON streams use a 90-second lease. Clients resume with the same `buildId` and last accepted `after` sequence, so lease expiry does not create another build. A build fails only after 120 seconds without packet or scanned-byte progress, or at the configurable 24-hour safety cap. Set `VOIDPLAYER_INDEX_IDLE_TIMEOUT_MS` and `VOIDPLAYER_INDEX_ABSOLUTE_TIMEOUT_MS` to adjust those bounds; the absolute cap must exceed the idle timeout. Client waits use a per-request idle timeout and continue reconnecting while the source remains open, rather than applying a wall-clock deadline to the whole index build.

The default FFmpeg scan waits for EOF before exporting the completed index as bounded batches. This keeps packet discovery separate from decode work and prevents partial packet order from being mistaken for stable seek coverage. Every batch includes the demux seek anchors required by the pinned core ABI. Media version and cache epoch are checked before committing progress, batches, and completion.

## Client consumption

The FFmpeg worker opens the media and primes the first frame independently of the index stream. It validates the server manifest against the opened stream, starts core append-import once, imports each validated batch, and appends only presentation records at or after the immutable origin to the public timeline. Preroll records remain in the core so seeks can use their anchors.

`MediaSource.ensureIndexed(target)` waits only when the target is beyond stable coverage. As batches arrive, the main-thread index session updates coverage and the source wakes waiters so seeking can continue within the newly covered region while the index remains in `building`. For the default MPEG-TS producer, scan progress is reported before batches and the full demux scan has reached EOF before the first record batch is published; `building` then means the complete index is not yet imported/final, not that demux is still running. Other producers may expose a stable prefix during scanning. Progress reaches `MediaInfo.indexProgress`. Completion changes the source to `complete`; transport or import failure changes it to `error` and wakes waiters. An already imported prefix remains usable up to its coverage, while a restarted build is rejected rather than mixed into that prefix.

`MediaIndexClient` is a compatibility facade over `IndexStreamTransport` and the index consumers. For FFmpeg, it now runs in the main-thread container session, never in the decoder worker. The transport owns HTTP, bounded NDJSON parsing, idle timeout, reconnect, abort, and generic `after`/`buildId` cursor handling. `FfmpegIndexConsumer` validates FFmpeg manifest identity, record layout, ordering, watermark, byte/frame limits, and build ID, then emits accepted records through callbacks; it does not own HTTP or WASM. The decoder worker receives only already-accepted record events, checks that their metadata matches the opened stream, imports them, and decodes frames. The compatibility document consumer retains the FLV and older FFmpeg JSON payload behavior. A transient disconnect resumes from the last accepted sequence. If the server build identity changes after a prefix has been imported, the source fails beyond its existing stable coverage; it does not claim completion or splice in a different scan.

## Acceptance

- For representative 350 MB and 691 MB MPEG-TS files, measure cold build, in-progress join, and warm-cache startup separately: first-frame time, browser Range count, server scan throughput, and browser `vp_index_build` calls. Large local benchmark inputs can be generated reproducibly from the checked-in fixtures (assuming FFmpeg is installed):

  ```sh
  ffmpeg -hide_banner -loglevel error -stream_loop 16 -i fixtures/video/mpeg2_10s_1280x720.ts -map 0:v:0 -c copy -f mpegts /tmp/voidplayer-index-350mb-mpeg2.ts
  ffmpeg -hide_banner -loglevel error -stream_loop 16 -i fixtures/video/h264_9s_1920x1080.mp4 -map 0:v:0 -c copy -f mpegts /tmp/voidplayer-index-338mb-h264.ts
  ffmpeg -hide_banner -loglevel error -stream_loop 34 -i fixtures/video/h264_9s_1920x1080.mp4 -map 0:v:0 -c copy -f mpegts /tmp/voidplayer-index-695mb-h264.ts
  npm run bench:index -- /tmp/voidplayer-index-350mb-mpeg2.ts
  npm run bench:index -- /tmp/voidplayer-index-338mb-h264.ts
  npm run bench:index -- /tmp/voidplayer-index-695mb-h264.ts
  ```

  These are synthetic repeated streams for repeatable load and scan profiling. Their measured sizes were 347,742,284 bytes (MPEG-2), 337,538,772 bytes (H.264), and 694,932,788 bytes (H.264). They do not stand in for content-specific correctness checks. Compare runs on the same machine, FFmpeg, WASM core, and input.
- Verify a cold TS displays its first frame before index completion. Scan progress must precede record batches, but batches are not expected during the demux scan; coverage can grow as the completed index imports and `building` continues until all records are final. Check contiguous batch sequence, monotonic `safePresentationUs`, complete record count, and warm-cache reuse without a new build.
- Compare PTS, duration, dimensions, color metadata, random seeks, and open-GOP output against the client-indexed path, including pixel/hash equivalence.
- Cover duplicate concurrent requests, batch resume, build restart, cache clear, file replacement during build, truncated input, worker failure, and failed-prefix behavior.
- Preserve atomic workspace restore, cancellation without late commit, immutable annotation PTS, FLV progressive-index tests, multi-track index waiting, and Node 24/Bun standalone CI.

## Diagnostics and profiling

The development log records `媒体管线追踪` at container selection, first-frame readiness, the first streamed index batch, and index completion. Each event includes the selected demux/index/decoder backends and, when available, the versioned media ID, index identity, build ID, request count, first PTS, duration, stable coverage, and timing milestones. These events are diagnostic only and do not select a media path.

Server cold builds emit one JSON `frame-index-build-profile` record after completion. It separates WASM open/prime/scan time, scan calls and packet/byte progress, CPU time, local AVIO reads and copies, record export, SQLite progress/batch/finish work, and time to first presentable frame and first persisted batch. Run `npm run bench:index -- /path/to/media.ts [video-stream-index]` to compare a cold build with a warm index-store lookup on the same machine and core. The benchmark reports server indexing timings; browser first-frame latency and Range counts remain browser integration measurements.

## Lifecycle verification

`test/frame-index-build-policy.test.ts` checks defaults and environment overrides. Client stream regression tests cover build-ID resume after disconnect and a continuously active stream that lasts longer than its idle timeout. A stream subscriber can be dropped by its 90-second lease or by client cancellation without terminating the server job.

## FLV decoder admission

`FlvEngine` keeps ownership of the reader, packet index, progressive scan, and `PacketTimeline` across browser and reference modes. Reference/hardware admission decodes a temporary software witness through that existing index; if native output does not match, `switchToSoftware()` replaces the decoder inside the same engine. The witness no longer opens a second complete FLV `MediaSource`. `scripts/check-media-open-matrix.mjs` verifies one FLV index GET per open, shared `flv-engine` selection, no software-source open during reference/hardware witness admission, and matching browser/reference timelines for FLV H.264 and HEVC.

Library FLV cold builds now run in the server index worker through a bounded disk reader; warm opens reuse the completed document cache. Local Blob files use the same scanner through the client reader. Local startup prefixes and complete indexes belong to one engine. Library playback uses the completed server document for its first frame. Failed library builds are reported before requesting source bytes.

## MP4 container plan and decoder switching

MP4 and QuickTime use the packet sample-table path independently of decoder preference. The library build and local playback share the same sample-table parser. Library playback consumes the server result, while local playback reads the tables in the browser. WebCodecs and WASM share a packet timeline in either case. A temporary reference witness decodes from that same table, and a failed native check switches only the decoder.

Packet and FFmpeg sources expose `reconfigureColorMode()` so `ReviewSession` can change browser/reference mode without invoking the saved opener. The packet worker can replace WebCodecs with WASM or restore WebCodecs while retaining the MP4 or FLV index. FFmpeg stays on its current decoder and index session because its worker currently exposes only the WASM decoder. Matrix regression asserts one container-open trace across browser → reference → browser for MP4 and MPEG-TS, and one demux backend across all fixture modes.

## Demux-only equivalence and stream finality

`test/frame-index-scan-modes.test.ts` runs the decoder-backed scan and demux-only scan against H.264 TS, MPEG-2 TS, and a generated HEVC TS containing B-frames and CRA pictures from open GOPs. It compares exported record bytes (including PTS/DTS, duration, packet position/size, and flags), record count/hash, seek-anchor count, first PTS, duration, first-frame pixels, and five distributed random-seek pixel hashes. The test compares the two complete indexes and their seek outputs; it does not require the decoder-backed scan API to expose stable coverage for every codec.

`scripts/check-container-browser.mjs` verifies the server stream lifecycle separately: a first frame is available before index finality, scan progress events precede every record batch, the batch sequence is contiguous under one build ID, safe coverage is monotonic while the full index imports, all records arrive before `complete`, and a warm reopen reuses the server index. It does not interpret `indexState: building` as proof that the server is still scanning.

## Shared packet views

FFmpeg-backed WebM, Matroska, TS, PS and AVI use one scan and one persisted packet table for playback and analysis. Each 48-byte record contains PTS, DTS, duration, byte position, compressed payload size, key/seek flags and its original selected-video demux ordinal. Storage is sorted by PTS (ties by original ordinal), with missing PTS records at the end. Playback derives a timed presentation view; analysis derives PTS and DTS views without decoding. IDs and decode ordinals always use the original ordinal, including bucket maxima and lookup.

Missing timestamps remain null. Their bytes and identities remain queryable, but the affected axis has unknown bitrate coverage and the panel reports excluded packet counts and bytes. Key flags are container flags, not I/P/B or QP classification. Sample payload bytes exclude container overhead and other streams.

The server scans with demux-only mode; `scanDecodedPackets` must be zero. Opening still probes the codec and primes the first presentable frame, and seeking still decodes the necessary GOP. Analysis queries perform neither media reads nor decode. Local files build the same records in the decoder Worker. Streamed and warm-cache records feed the same analysis adapter. ABI v2 caches cannot provide original ordinals and are rebuilt under the new identity.

## Damaged recordings

See [container-recovery.md](container-recovery.md) for source integrity, terminal
prefixes, decode boundaries, cache/transport behavior and recovery limits.

### Inspector container clocks

The inspector shows source file size beneath the track title. Container metadata includes separate video and audio time bases in seconds per tick, preserving multiple declared tracks. MP4/MOV playback carries original `mdhd` timescales and audio declarations directly from the JS demuxer through its Worker result and persisted playback index. Schema 2 requires these facts; older indexes rebuild under the new identity, so eviction or absence of raw `moov` bytes cannot erase them. Other containers use the bounded cache-only header reader: Matroska/WebM `TimestampScale`, FLV millisecond timestamps and MPEG-TS PES 90 kHz timestamps. These are container clocks, not frame rates, audio sample rates or the normalized microsecond presentation timeline. Missing, invalid or unsupported clock metadata stays unknown; confirmed absent audio has no audio time-base row. No additional media IO or decoder work is started to populate these fields. On first inspection, track selection responds immediately while details wait for one coalesced metadata snapshot (already parsed MP4 facts, or the cache-only query for other containers). Publish the first metadata snapshot together, retaining the previous coherent details during a track switch rather than briefly inserting unknown clock rows. Closed inspectors do not start this query; source generations fence late replies.
