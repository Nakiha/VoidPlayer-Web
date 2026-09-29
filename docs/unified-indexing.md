# Unified media index

The shared contract unifies index identity, lifecycle, progress, persistence, transport, and player state. Container adapters keep their own record formats and rules for publishing seekable coverage.

## Current behavior

- **FFmpeg container fallback:** for versioned library media, the browser primes the first presentable frame and returns a playable source before indexing finishes. The first frame PTS fixes the timeline origin. The server then scans with the bundled FFmpeg WASM core and local-file AVIO; the browser imports records as the server publishes them. A compatible warm cache skips the full scan.
- **MPEG-TS:** the core exposes a stable record prefix at demuxer-proven boundaries. The server persists each new prefix batch before notifying subscribers. The player appends validated batches and wakes `ensureIndexed(target)` when stable coverage reaches the requested time. TS batches retain PTS, DTS, packet position/size, key flags, and seek anchors.
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

For a TS build the scan loop exports only records newly added to the core's stable prefix. For containers without a safe partial-export proof, it waits for EOF and emits the final record set as batches. In both cases every batch includes the demux seek anchors required by the pinned core ABI. Media version and cache epoch are checked before committing progress, batches, and completion.

## Client consumption

The FFmpeg worker opens the media and primes the first frame independently of the index stream. It validates the server manifest against the opened stream, starts core append-import once, imports each validated batch, and appends only presentation records at or after the immutable origin to the public timeline. Preroll records remain in the core so seeks can use their anchors.

`MediaSource.ensureIndexed(target)` waits only when the target is beyond stable coverage. As batches arrive, the source wakes waiters and allows seeking within the newly covered region while the scan remains in `building`. Progress reaches `MediaInfo.indexProgress`. Completion changes the source to `complete`; transport failure changes it to `error` and wakes waiters. An already imported prefix remains usable up to its coverage, while a restarted build is rejected rather than mixed into that prefix.

The record client incrementally parses NDJSON and validates identity, batch sequence, record size/structure, per-batch ordering, watermark, byte/frame limits, and build ID. It resumes a transient disconnect from its last accepted sequence. If the server build identity changes after a prefix has been imported, the source fails beyond its existing stable coverage; it does not claim completion or splice in a different scan.

## Rollout and remaining work

1. Preserve the software reference source after failed native first-frame verification.
2. Pin and check FFmpeg index ABI v2 and stable-prefix/append-import ABI v1.
3. Add identity-keyed server persistence, bounded build coordination, and first-frame readiness.
4. Stream and append FFmpeg record batches; publish stable TS coverage during scan and the full record set at EOF for other FFmpeg containers.
5. Migrate FLV cold indexing to the server and its packet-record adapter. Keep FLV's record semantics while adopting the common lifecycle and streaming transport.
6. Evaluate server indexing for the separate MP4 packet path without changing its sample/edit-list record contract.

## Acceptance

- For the reported 211 MB TS, measure cold build, in-progress join, and warm-cache startup separately: first-frame time, browser Range count, server scan throughput, and browser `vp_index_build` calls.
- Verify a cold TS displays its first frame before completion, publishes stable batches while scanning, and permits seeks within stable coverage. A warm hit imports anchors and performs no client full scan.
- Compare PTS, duration, dimensions, color metadata, random seeks, and open-GOP output against the client-indexed path, including pixel/hash equivalence.
- Cover duplicate concurrent requests, batch resume, build restart, cache clear, file replacement during build, truncated input, worker failure, and failed-prefix behavior.
- Preserve atomic workspace restore, cancellation without late commit, immutable annotation PTS, FLV progressive-index tests, multi-track index waiting, and Node 24/Bun standalone CI.

## M0 diagnostics

The development log records `媒体管线追踪` at container selection, first-frame readiness, the first streamed index batch, and index completion. Each event includes the selected demux/index/decoder backends and, when available, the versioned media ID, index identity, build ID, request count, first PTS, duration, stable coverage, and timing milestones. These events are diagnostic only and do not select a media path.

Server cold builds emit one JSON `frame-index-build-profile` record after completion. It separates WASM open/prime/scan time, scan calls and packet/byte progress, CPU time, local AVIO reads and copies, record export, SQLite progress/batch/finish work, and time to first presentable frame and first persisted batch. Run `npm run bench:index -- /path/to/media.ts [video-stream-index]` to compare a cold build with a warm index-store lookup on the same machine and core. The benchmark reports server indexing timings; browser first-frame latency and Range counts remain browser integration measurements.
