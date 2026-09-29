# Unified media index

The shared contract unifies index identity, lifecycle, progress, persistence, transport, and player state. Container adapters keep their own record formats and rules for publishing seekable coverage.

## Current behavior

- **FFmpeg container fallback:** the main-thread `FfmpegContainerSession` owns its `FfmpegMediaIndexSession`, which starts or joins the versioned server index stream. The decoder worker opens the container and primes the first presentable frame, then returns a playable source before indexing finishes. The session sends validated manifest and record events to the worker for core import; a compatible warm cache skips the full scan.
- **MPEG-TS:** the server uses a demux-only full scan; it does not decode every packet to build timing and seek metadata. It publishes validated batches after EOF, while the first presentable frame remains independently available before index completion. TS records retain PTS, DTS, packet position/size, key flags, and seek anchors. The core's decoder-backed progressive scan remains available for comparison and focused tests.
- **Other FFmpeg containers:** the same record protocol and lifecycle apply, but without a proven stable prefix the server publishes records after its full scan. The first frame can still appear early; later seeks wait until the full index arrives.
- **FLV packet path:** playback already has client-side progressive indexing and its own packet-offset records. Completed indexes are cached on the server and transferred through the compatibility document protocol. Cold FLV indexing is not yet performed by the server.
- Direct local files, unavailable server indexing, and incompatible core builds retain the client-side FFmpeg indexing fallback.

## Shared contract

The media index identity is `(media ID, media version, kind, stream key, schema version, indexer build)`. SQLite stores identity-keyed manifests and sequence-keyed batches. FFmpeg metadata includes source size, stream index, codec, time base, dimensions, and core build SHA. Release checks require index ABI v2, stream ABI v1, 40-byte records, the scan/export/import symbols, and a core build ID matching the pinned revision.

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

For a cold index, the versioned frame-index endpoint returns NDJSON protocol 2 events: `manifest`, `progress`, `batch`, `complete`, and `error` (plus `reset` when the server has replaced a build). A batch includes a monotonic sequence, build ID, record count, raw FFmpeg records encoded as base64, and a safe presentation watermark. The server commits a batch to SQLite before making it visible to subscribers. Reconnects send `buildId` and `after`; a changed build is explicitly reset and clients never mix records from two builds.

The server persists scan packet/byte progress, stable coverage, and each batch. A failed build remains marked failed with its durable prefix; a subsequent request starts a new build. A complete cache hit uses the same record event protocol. Older complete FFmpeg documents are lazily converted to record batches, while the JSON endpoint remains compatible with older clients. FLV continues to use its existing document transport until its server producer is migrated.

Build jobs are independent of HTTP subscribers. The server runs one build at a time with up to eight queued jobs; disconnecting a stream removes that subscriber but leaves the identity-deduplicated job running. NDJSON streams use a 90-second lease. Clients resume with the same `buildId` and last accepted `after` sequence, so lease expiry does not create another build. A build fails only after 120 seconds without packet or scanned-byte progress, or at the configurable 24-hour safety cap. Set `VOIDPLAYER_INDEX_IDLE_TIMEOUT_MS` and `VOIDPLAYER_INDEX_ABSOLUTE_TIMEOUT_MS` to adjust those bounds; the absolute cap must exceed the idle timeout. Client waits use a per-request idle timeout and continue reconnecting while the source remains open, rather than applying a wall-clock deadline to the whole index build.

The default FFmpeg scan waits for EOF before exporting the completed index as bounded batches. This keeps packet discovery separate from decode work and prevents partial packet order from being mistaken for stable seek coverage. Every batch includes the demux seek anchors required by the pinned core ABI. Media version and cache epoch are checked before committing progress, batches, and completion.

## Client consumption

The FFmpeg worker opens the media and primes the first frame independently of the index stream. It validates the server manifest against the opened stream, starts core append-import once, imports each validated batch, and appends only presentation records at or after the immutable origin to the public timeline. Preroll records remain in the core so seeks can use their anchors.

`MediaSource.ensureIndexed(target)` waits only when the target is beyond stable coverage. As batches arrive, the main-thread index session updates coverage and the source wakes waiters so seeking can continue within the newly covered region while the index remains in `building`. For the default MPEG-TS producer, scan progress is reported before batches and the full demux scan has reached EOF before the first record batch is published; `building` then means the complete index is not yet imported/final, not that demux is still running. Other producers may expose a stable prefix during scanning. Progress reaches `MediaInfo.indexProgress`. Completion changes the source to `complete`; transport or import failure changes it to `error` and wakes waiters. An already imported prefix remains usable up to its coverage, while a restarted build is rejected rather than mixed into that prefix.

`MediaIndexClient` is a compatibility facade over `IndexStreamTransport` and the index consumers. For FFmpeg, it now runs in the main-thread container session, never in the decoder worker. The transport owns HTTP, bounded NDJSON parsing, idle timeout, reconnect, abort, and generic `after`/`buildId` cursor handling. `FfmpegIndexConsumer` validates FFmpeg manifest identity, record layout, ordering, watermark, byte/frame limits, and build ID, then emits accepted records through callbacks; it does not own HTTP or WASM. The decoder worker receives only already-accepted record events, checks that their metadata matches the opened stream, imports them, and decodes frames. The compatibility document consumer retains the FLV and older FFmpeg JSON payload behavior. A transient disconnect resumes from the last accepted sequence. If the server build identity changes after a prefix has been imported, the source fails beyond its existing stable coverage; it does not claim completion or splice in a different scan.

## Rollout and remaining work

1. Preserve the software reference source after failed native first-frame verification.
2. Pin and check FFmpeg index ABI v2 and stable-prefix/append-import ABI v1.
3. Add identity-keyed server persistence, bounded build coordination, and first-frame readiness.
4. Stream and append FFmpeg record batches; publish the complete MPEG-TS record set after the demux scan reaches EOF, and use stable-prefix publication only for producers that can prove it.
5. Move FFmpeg HTTP ownership into a main-thread `ContainerSession`/`MediaIndexSession`; keep worker messages limited to import, append, and decode.
6. Keep FLV's packet-offset record semantics while converging its progressive lifecycle with the common index session contract. Browser playback, reference/hardware admission, and reference/software playback must reuse one `FlvEngine`, packet index, reader, and timeline. A temporary software witness decodes from that engine's existing index; failed admission swaps the decoder in place instead of opening a second `MediaSource`.
7. Evaluate server indexing for the separate MP4 packet path without changing its sample/edit-list record contract.

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

## M0 diagnostics

The development log records `媒体管线追踪` at container selection, first-frame readiness, the first streamed index batch, and index completion. Each event includes the selected demux/index/decoder backends and, when available, the versioned media ID, index identity, build ID, request count, first PTS, duration, stable coverage, and timing milestones. These events are diagnostic only and do not select a media path.

Server cold builds emit one JSON `frame-index-build-profile` record after completion. It separates WASM open/prime/scan time, scan calls and packet/byte progress, CPU time, local AVIO reads and copies, record export, SQLite progress/batch/finish work, and time to first presentable frame and first persisted batch. Run `npm run bench:index -- /path/to/media.ts [video-stream-index]` to compare a cold build with a warm index-store lookup on the same machine and core. The benchmark reports server indexing timings; browser first-frame latency and Range counts remain browser integration measurements.

## M1 timeout and job lifecycle

`test/frame-index-build-policy.test.ts` checks defaults and environment overrides. Client stream regression tests cover build-ID resume after disconnect and a continuously active stream that lasts longer than its idle timeout. A stream subscriber can be dropped by its 90-second lease or by client cancellation without terminating the server job.

## M2 transport separation

`src/index-stream-transport.ts` contains the HTTP/NDJSON reconnect loop. `src/ffmpeg-index-consumer.ts` validates and publishes container-specific FFmpeg records, while `src/media-index-client.ts` remains the FLV/FFmpeg compatibility facade. At this milestone FFmpeg still constructs the facade inside its decoder worker; M3 moves that ownership to the main-thread container session.

## M3 FFmpeg container session

`src/media-index-session.ts` adds the first `ContainerSession` and `MediaIndexSession` implementation. `src/ffmpeg-media.ts` owns the HTTP subscriber on the main thread and sends validated record events to the FFmpeg worker. The worker no longer imports `MediaIndexClient` or performs HTTP/reconnect work. Local files and server-unavailable cases still ask the worker to build a local fallback index through the same session sink. `test/media-index-session.test.ts` covers local fallback, coverage/finality, subscriber abort on dispose, and the worker's lack of transport dependencies.

## M4 FLV decoder admission

`FlvEngine` keeps ownership of the reader, packet index, progressive scan, and `PacketTimeline` across browser and reference modes. Reference/hardware admission decodes a temporary software witness through that existing index; if native output does not match, `switchToSoftware()` replaces the decoder inside the same engine. The witness no longer opens a second complete FLV `MediaSource`. `scripts/check-media-open-matrix.mjs` verifies one FLV index GET per open, shared `flv-engine` selection, no software-source open during reference/hardware witness admission, and matching browser/reference timelines for FLV H.264 and HEVC.

The FLV compatibility index may still be sourced from a local progressive scan or the server's completed document cache depending on cache state. This does not create a second demux/index session inside one open. Migrating FLV cold builds to the server streaming transport remains separate work.

## M5 MP4 container plan and decoder switching

`chooseMp4DemuxPlan()` runs after container probing and before reading color or decoder preferences. It selects the packet sample-table path only when the MP4 has a zero-rotation primary video track, a packet-supported codec, and one validated sample description; other MP4 structures use the FFmpeg container/index plan. MPEG-TS and other non-FLV/non-MP4 inputs also use FFmpeg independent of color or decoder preference. The selected plan is recorded in the pipeline trace. For packet-plan MP4, WebCodecs and WASM use the same `Mp4Engine` sample table, byte reader, and timeline. A temporary reference witness decodes from that same sample table, and a failed native check switches only the decoder. FFmpeg sources keep the same index session during color changes and validate YUV output in reference mode.

Packet and FFmpeg sources expose `reconfigureColorMode()` so `ReviewSession` can change browser/reference mode without invoking the saved opener. The packet worker can replace WebCodecs with WASM or restore WebCodecs while retaining the MP4 or FLV index. FFmpeg stays on its current decoder and index session because its worker currently exposes only the WASM decoder. Matrix regression asserts one container-open trace across browser → reference → browser for MP4 and MPEG-TS, and one demux backend across all fixture modes.

## M6 server index profiling

The original build profile measured the decoder-backed progressive WASM FFmpeg scan on this machine. A synthetic 347,742,284-byte MPEG-2 TS completed cold indexing in 9.7 s (34.15 MiB/s); synthetic 337,538,772-byte and 694,932,788-byte H.264 TS files completed in 51.3 s (6.27 MiB/s) and 105.8 s (6.26 MiB/s), respectively. The larger run spent 105.6 s in `vp_index_scan_step` with 105.7 s CPU user time. It produced the first frame in 140 ms and the first persisted stable batch in 5.2 s; warm manifest lookup took 25 ms.

For the 694.9 MB run, local AVIO read, allocation, and ArrayBuffer copy totaled about 115 ms; SQLite batch writes totaled 39 ms. These were negligible beside that scan. M6.1 compares the scan modes directly and measures the current demux-only default below.

## M6.1 MPEG-TS demux-only scan

`scripts/compare-index-scan-modes.mjs` compares the same file/core using `vp_index_scan_stream_begin()` and `vp_index_scan_begin()`, including exact exported record bytes and random-seek pixel hashes. On a 367.6 MB, 350-second HEVC TS synthesized by looping the checked-in 10-second HEVC fixture, decoder-backed scanning took 97.8 s (3.58 MiB/s; 96.8 s CPU user time). Demux-only scanning took 352 ms (996 MiB/s). Both produced 21,000 records with the same SHA-256, 350 seek anchors, identical first PTS/duration, and matching pixels for five distributed random seeks. First-frame output also matched. The WASM scan API's progressive-supported flag was false by EOF, after it had already decoded and exposed the stable prefix during nearly the entire scan.

The server now uses `vp_index_scan_begin()` and sends the completed index after EOF. On the same file, end-to-end cold build took 642 ms; the build profile reported 607 ms total, 399 ms in scan steps, 165 ms to first presentation, and 577 ms to the first persisted batch. Warm manifest lookup was 31 ms. This removes packet-index construction's dependency on playback decode throughput while keeping first-frame readiness separate. The small MPEG-TS regression compares the two modes' record bytes and random-seek pixels. This result uses a synthetic repeated fixture, not the original large HEVC TS.

## M7 demux-only equivalence and stream finality

`test/frame-index-scan-modes.test.ts` runs the decoder-backed scan and demux-only scan against H.264 TS, MPEG-2 TS, and a generated HEVC TS containing B-frames and CRA pictures from open GOPs. It compares exported record bytes (including PTS/DTS, duration, packet position/size, and flags), record count/hash, seek-anchor count, first PTS, duration, first-frame pixels, and five distributed random-seek pixel hashes. The test no longer requires the old progressive scan API to expose stable coverage for every codec; it proves the two complete indexes and their seek outputs are equivalent.

`scripts/check-container-browser.mjs` verifies the server stream lifecycle separately: a first frame is available before index finality, scan progress events precede every record batch, the batch sequence is contiguous under one build ID, safe coverage is monotonic while the full index imports, all records arrive before `complete`, and a warm reopen reuses the server index. It does not interpret `indexState: building` as proof that the server is still scanning.
