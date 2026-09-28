# Unified media index

This document tracks the index unification rollout. The first server producer targets MPEG-TS and other containers handled by the FFmpeg fallback. FLV and MP4 retain their format-specific index records and validation.

## Current behavior

- FLV stores and reads a complete index document. Its playback path can show frames while a client-side background scan continues; the server cache is populated after that scan finishes.
- FFmpeg container fallback can request a server index for a versioned library media item. On a cache miss, the server runs the bundled FFmpeg WASM core against a bounded local-file reader, stores the completed index, and returns it. On a hit, the browser imports the stored records into the decoder context and skips its full index scan.
- FFmpeg cache transfer uses the shared media-index client and the versioned frame-index endpoint. Direct local files, servers without the matching core, and older browser cores keep the client indexing fallback.
- The FFmpeg core currently scans synchronously and the server responds with one complete JSON document. Cold builds do not yet publish intermediate batches, and the FFmpeg path does not yet present its first frame before index completion.
- The common storage table can hold FLV or FFmpeg documents, but their payload schemas remain format-specific. MP4 sample-table indexing and FLV tag indexing have different source metadata and validation rules.

## Shared contract

Unify media-version checks, cache lifecycle, progress reporting, persistence, and transport while keeping each container adapter responsible for valid seek records and time reconstruction.

The current cache identity includes the library media ID and observed media version at the service boundary, plus source size and FFmpeg stream metadata in the FFmpeg document. A follow-up schema should explicitly include selected stream identity, index schema, and indexer/core build before cache compatibility is widened. Every remote index still needs validation against the opened source before it is trusted.

The target manifest carries identity, source size, index kind, state, revision, scanned-byte progress, indexed presentation coverage, and completion status. States are building, complete, and error. Batches have monotonically increasing sequence numbers and immutable contents. A batch boundary includes a container-provided safe presentation watermark; the client must not infer that later packets cannot precede the last observed PTS.

Payload adapters retain the data needed by their seek implementation:

- FLV: packet byte offsets and sizes, raw PTS/DTS, key flags, and configuration changes.
- MP4: validated sample offsets and sizes, decode/presentation timing, edit-list mapping, and configuration boundaries.
- FFmpeg containers such as MPEG-TS: exact stream time base, packet/frame identity, timestamps, byte positions or usable demuxer seek anchors, key flags, and codec configuration identity. A timestamp-only list does not let the client skip demux indexing or restore seek behavior.

Keep the public session timeline in integer microseconds. The current FFmpeg wire records use a fixed 24-byte little-endian layout with ticks, duration, and key flag. The target streaming envelope can begin with bounded JSON batches; compact binary or delta encoding can follow once the end-to-end contract is stable.

## Producer and transport

The current FFmpeg cold-build request runs in the frame-index worker and reads the media through local-file AVIO. It does not copy the complete source into WASM memory. The completed cache is committed only if the media version and cache epoch still match.

The target server API uses a deduplicated background job for each media version. The job publishes immutable batches to persistent storage and active subscribers. GET on a versioned frame-index resource streams a manifest, index batches, progress updates, and one terminal complete or error record as NDJSON. It accepts an after-sequence cursor so a disconnected client can resume. A cache hit replays stored batches in sequence.

Streaming subscribers need a bounded job coordinator and fan-out separate from request-body preparation and complete-document reads. Holding the current request gate for a stream lifetime would prevent other clients from joining. Build concurrency remains bounded independently from library scanning and playback requests. Incomplete jobs must not be represented as complete after restart.

The standalone server has no ffmpeg or ffprobe executable dependency. Continue using the bundled FFmpeg core with a server worker and bounded file reader. Keep client indexing as the fallback for direct local files, unavailable server support, and unsupported containers.

## Client consumption

For a versioned library URL, the client requests a compatible server cache or cold build. On a complete cache hit, it imports the index and skips a full client scan. On a cold build today, it waits for the server's complete index document before importing it.

The next client stage needs FFmpeg core begin, bounded-step, partial export, and partial import operations. The worker must yield between batches so it can publish progress and serve frame requests. The decoder must preserve random-access anchors, open-GOP preroll, duplicate-PTS handling, timestamp wrap/discontinuity behavior, and stream time-base semantics when it imports a partial or complete index.

The existing session contract remains authoritative: first presentation, indexed duration, complete scan, and decoder EOF are distinct. A decoder reaching the current indexed frontier waits for more data; it does not flush or claim EOF until the index completes. An explicit seek requests enough prefix to cover the target. Scan failure or cancellation leaves ordinary client-side playback fallback available.

## Rollout

1. Preserve the already validated software reference source when native first-frame verification fails. This avoids reopening and rescanning the same source.
2. Add and validate FFmpeg core index import/export. This is implemented for complete indexes; bounded scanning and partial-index import/export remain.
3. Add server-side FFmpeg cold generation and complete-index cache reuse. This is implemented for versioned library media.
4. Add bounded index jobs, versioned batch storage, resumable NDJSON streaming, and client partial-index consumption so cold builds can present frames before scanning completes.
5. Extend explicit identity fields and migrate FLV and MP4 producers through their existing adapters after the MPEG-TS flow passes the end-to-end contract.

## Acceptance

- On the reported 211 MB TS file, record cold server build, an in-progress join, and warm-cache startup separately. Measure time to first frame, browser Range count, server scan throughput, and whether vp_index_build ran in the browser.
- Verify a warm hit imports the index and performs no full client scan. Verify a cold scan presents from the first valid prefix before completion.
- Compare displayed PTS, duration, dimensions, color metadata, seeks, and open-GOP output with the existing client path.
- Cover duplicate concurrent requests, reconnect from a sequence cursor, cancellation, cache clearing, file replacement during build, truncated input, worker failure, and server restart.
- Keep Node 24 semantic tests and the Bun standalone package covered. Retain the current FLV progressive-indexing and multi-track index-wait regressions.
