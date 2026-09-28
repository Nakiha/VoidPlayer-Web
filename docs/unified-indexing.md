# Unified media index

This document proposes the shared index contract and service lifecycle for progressive client and server indexing. The first implementation target is MPEG-TS through the FFmpeg container fallback; FLV and MP4 keep their established format adapters.

## Current behavior

- The frame-index endpoint accepts and caches a complete FLV index document. A browser can later download that whole document; it does not subscribe to a server scan.
- FLV begins playback from a local startup prefix and continues scanning in the background. Its server cache is populated only after a complete client scan.
- The FFmpeg worker calls vp_index_build synchronously, then returns the complete timestamp and duration arrays. It has no index import or partial-index API.
- MP4 sample-table indexing and FLV tag indexing have different source metadata and validation rules. The shared packet timeline consumes those format-specific records.

## Shared contract

Unify identity, lifecycle, progress, persistence, and transport. Keep each container adapter responsible for its own valid seek records and time reconstruction.

An index identity is the tuple media ID, observed media version, selected video stream, index schema version, and indexer/core build. A cached index is reusable only when every identity field matches. Continue validating the opening packet/sample against source bytes before using remote cache data.

The common manifest carries identity, source size, index kind, state, revision, scanned-byte progress, indexed presentation coverage, and completion status. States are building, complete, and error. Batches have monotonically increasing sequence numbers and immutable contents. A batch boundary includes a container-provided safe presentation watermark; the client must not infer that later packets cannot precede the last observed PTS.

Payload adapters retain the data needed by their seek implementation:

- FLV: packet byte offsets and sizes, raw PTS/DTS, key flags, and configuration changes.
- MP4: validated sample offsets and sizes, decode/presentation timing, edit-list mapping, and configuration boundaries.
- FFmpeg containers such as MPEG-TS: exact stream time base, packet/frame identity, timestamps, byte positions or usable demuxer seek anchors, key flags, and codec configuration identity. A timestamp-only list does not let the client skip demux indexing or restore seek behavior.

Keep the public session timeline in integer microseconds. The wire representation should use bounded batches with validated integer values; a compact binary or delta-encoded representation can replace JSON after the end-to-end contract is stable.

## Producer and transport

A server request for a library media version joins or starts one deduplicated background job. The job opens the media through a bounded local-file random-access adapter and runs in a worker. It publishes immutable batches to persistent storage and active subscribers. Use the existing media-version and cache-epoch checks at commit time.

GET on the versioned frame-index resource streams a manifest, index batches, progress updates, and one terminal complete or error record as NDJSON. Accept an after-sequence cursor so a disconnected client can resume. A cache hit replays stored batches in sequence and completes immediately. A cache miss starts the shared job; the HTTP request itself never owns the scanner.

The existing frame-index request gate serializes request-body preparation and complete-document reads. Streaming subscribers therefore need a separate bounded job coordinator and fan-out; holding that gate for the lifetime of a stream would prevent other clients from joining. Build concurrency remains bounded independently from library scanning and playback requests. Persist complete batches transactionally; incomplete jobs are discarded or explicitly resumed after restart, never represented as complete.

The standalone server currently has no ffmpeg or ffprobe executable dependency. Prefer the project’s custom FFmpeg core with a server worker and bounded file reader. Do not buffer the whole source file into WASM memory. Keep client indexing as the fallback for direct local files, unavailable server support, and unsupported containers.

## Client consumption

For a versioned library URL, the client opens an index subscription alongside ordinary media probing. On a complete cache hit, it imports the index into the decoder context and skips a full client scan. On a cold build, the first usable server batch initializes the decoder and makes the covered prefix available for playback; later batches extend the same source and timeline.

The FFmpeg core needs explicit begin, next-batch, export, and import operations. Scanning must yield between bounded batches so the worker can publish progress and serve frame requests without blocking for the whole file. The decoder must preserve random-access anchors, open-GOP preroll, duplicate-PTS handling, and stream time-base semantics when it imports a partial or complete index.

The existing session contract remains authoritative: first presentation, indexed duration, complete scan, and decoder EOF are distinct. A decoder reaching the current indexed frontier waits for more data; it does not flush or claim EOF until the index completes. An explicit seek requests enough prefix to cover the target. Scan failure or cancellation leaves ordinary client-side playback fallback available.

## Rollout

1. Preserve the already validated software reference source when native first-frame verification fails. This avoids reopening and rescanning the same source.
2. Add FFmpeg core index export/import and bounded scan batches, with a local client progressive path. Verify early first-frame presentation before adding server generation.
3. Add a separate server build-job coordinator, local-file input adapter, versioned batch storage, and resumable NDJSON streaming.
4. Connect versioned library sources to the provider. Keep the existing FLV document cache readable during migration, then move it to the common envelope.
5. Add MP4 and FLV server producers through their existing adapters after MPEG-TS has passed the end-to-end contract.

## Acceptance

- On the reported 211 MB TS file, record cold server build, an in-progress join, and warm-cache startup separately. Measure time to first frame, browser Range count, server scan throughput, and whether vp_index_build ran in the browser.
- Verify a warm hit imports the index and performs no full client scan. Verify a cold scan presents from the first valid prefix before completion.
- Compare displayed PTS, duration, dimensions, color metadata, seeks, and open-GOP output with the existing client path.
- Cover duplicate concurrent requests, reconnect from a sequence cursor, cancellation, cache clearing, file replacement during build, truncated input, worker failure, and server restart.
- Keep Node 24 semantic tests and the Bun standalone package covered. Retain the current FLV progressive-indexing and multi-track index-wait regressions.
