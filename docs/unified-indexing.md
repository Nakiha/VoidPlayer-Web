# Unified media index

This document tracks the index unification rollout. The first server producer targets MPEG-TS and other containers handled by the FFmpeg fallback. FLV and MP4 retain their format-specific index records and validation.

## Current behavior

- FLV stores and reads a complete index document. Its playback path can show frames while a client-side background scan continues; the server cache is populated after that scan finishes.
- FFmpeg container fallback can request a server index for a versioned library media item. On a cache miss, the server runs the bundled FFmpeg WASM core against a bounded local-file reader, stores the completed index, and returns it. On a hit, the browser imports the stored records into the decoder context and skips its full index scan.
- With the compatible server-backed core, opening returns the first presentable frame before the complete index arrives. That frame's source PTS fixes the media timeline origin; the initial seek coverage is only that frame.
- FFmpeg cache transfer uses the shared media-index client and the versioned frame-index endpoint. Direct local files, servers without the matching core, and older browser cores keep the client indexing fallback.
- The FFmpeg core exposes packet-budgeted begin/step/complete calls, and the server build worker now yields between packet batches while tracking scanned bytes. A cold NDJSON GET sends a `building` manifest and scan progress before the final document is ready. After completion it sends sequenced 64 KiB base64 byte slices and can resume with `?after=N`. These wire slices still have no record or coverage semantics. The independently primed first frame can be displayed during the scan, but later seek positions and playback beyond that frame wait until the browser assembles and imports the complete document.
- Persistence now uses identity-keyed manifests and sequence-keyed batches. The identity includes media ID/version, format kind, stream key, schema version, and indexer build. A complete bootstrap document is stored as batch 0; FLV and FFmpeg payload validation remain format-specific.

## Shared contract

Unify media-version checks, cache lifecycle, progress reporting, persistence, and transport while keeping each container adapter responsible for valid seek records and time reconstruction.

The persisted key is (media ID, media version, kind, stream key, schema version, indexer build). FFmpeg cache documents also carry source size, stream index, codec, time base, dimensions, and the core build SHA. The Web release check requires index ABI v2, 40-byte records, and an embedded core build ID equal to the pinned revision. Every remote FFmpeg index is checked against the opened source before import.

The manifest carries identity, state, last sequence, scanned-byte progress, stable presentation coverage, and completion status. The schema supports building, streaming, complete, and failed states. Once the first presentable frame is exposed, its source PTS is the immutable timeline origin; earlier records discovered later are preroll and must not renormalize that origin. Index-record batch sequence numbers are monotonic and immutable; each record batch boundary must carry a container-provided safe presentation watermark. The current completed-document transport chunks have no playback coverage, and the client must not infer one from transfer progress.

Payload adapters retain the data needed by their seek implementation:

- FLV: packet byte offsets and sizes, raw PTS/DTS, key flags, and configuration changes.
- MP4: validated sample offsets and sizes, decode/presentation timing, edit-list mapping, and configuration boundaries.
- FFmpeg containers such as MPEG-TS: exact stream time base, packet/frame identity, timestamps, byte positions or usable demuxer seek anchors, key flags, and codec configuration identity. A timestamp-only list does not let the client skip demux indexing or restore seek behavior.

Keep the public session timeline in integer microseconds. FFmpeg ABI v2 uses fixed 40-byte little-endian records with PTS, DTS, duration, packet position, packet size, and flags. MPEG-TS keyframe records restore the demuxer seek anchors on import. This payload belongs to the FFmpeg adapter; FLV and MP4 keep their own record models.

## Producer and transport

The FFmpeg cold build runs in a dedicated bounded build worker and reads the media through local-file AVIO. It does not copy the complete source into WASM memory. Builds deduplicate by media version and full index identity; one scan runs at a time with a bounded queue. Cache lookup and writes use a separate database worker, so a long scan does not block warm reads. Commit checks both media version and cache epoch.

The versioned frame-index GET endpoint supports NDJSON with `manifest`, `batch`, `progress`, `complete`, and `error` events. On a cold FFmpeg build, the server sends a `building` manifest followed by packet and byte progress as the bounded scan advances. It then sends a `complete` manifest and deterministic byte slices from the finished JSON document; `?after=N` resumes after the last accepted slice. SQLite still stores only the completed document in its bootstrap batch, and the wire slices are recreated for each request. A JSON response remains available to older clients. The next stage will replace these document-byte chunks with validated format-adapter record batches that carry a safe presentation watermark.

The job coordinator and cache workers are separate. Concurrent clients join the same in-memory build and receive its latest scan progress; completed documents resume from a deterministic sequence cursor. Persisted in-progress record batches and restartable scan jobs remain outstanding. Build concurrency stays bounded independently from cache lookup, library scanning, and playback requests. Incomplete jobs must not be represented as complete after restart.

The standalone server has no ffmpeg or ffprobe executable dependency. Continue using the bundled FFmpeg core with a server worker and bounded file reader. Keep client indexing as the fallback for direct local files, unavailable server support, and unsupported containers.

## Client consumption

For a versioned library URL, the client requests a compatible server cache or cold build. It parses NDJSON events incrementally, accepts scan progress before the completed-document manifest, validates transfer sequence and byte counts, resumes a broken transfer, and imports only after the final `complete` event. On the compatible FFmpeg path, the source can return its primed first frame while this transfer/build continues; the complete index is still required before exposing later seek positions.

The next client stage needs FFmpeg core partial export and append/import operations. The worker must yield between batches so it can publish progress and serve frame requests after the first frame. The decoder must preserve random-access anchors, open-GOP preroll, duplicate-PTS handling, timestamp wrap/discontinuity behavior, and stream time-base semantics when it imports a partial or complete index.

The existing session contract remains authoritative: first presentation, indexed duration, complete scan, and decoder EOF are distinct. A decoder reaching the current indexed frontier waits for more data; it does not flush or claim EOF until the index completes. An explicit seek requests enough prefix to cover the target. Scan failure or cancellation leaves ordinary client-side playback fallback available.

## Rollout

1. Preserve the already validated software reference source when native first-frame verification fails. This avoids reopening and rescanning the same source.
2. Add and validate FFmpeg core index import/export. ABI v2 preserves MPEG-TS seek anchors; packet-budgeted scanning and byte progress are implemented in Core PR #1, with the Web server integration in this rollout. Partial-index import/export remains.
3. Add server-side FFmpeg cold generation, exact cache identity, separate cache/build workers, and complete-index reuse. This is implemented for versioned library media.
4. Return the first presentable FFmpeg frame before index completion and keep its timeline origin immutable. Route later seeks through `ensureIndexed(target)` so workspace restore remains atomic. This first-presentation milestone is implemented for compatible server-backed media.
5. Add a demuxer-provided safe presentation watermark. Persist format-adapter record batches while the scan runs, then let the player consume the stable indexed prefix before completion.
6. Move FLV and MP4 through the same lifecycle and transport while preserving their format-specific payload adapters.

## Acceptance

- On the reported 211 MB TS file, record cold server build, an in-progress join, and warm-cache startup separately. Measure time to first frame, browser Range count, server scan throughput, and whether vp_index_build ran in the browser.
- Verify a warm hit imports the index and performs no full client scan. A cold scan must show its first presentable frame before completion; seeks beyond that frame's coverage wait. After safe record batches are implemented, playback and seeks should advance through the stable prefix before EOF.
- Compare displayed PTS, duration, dimensions, color metadata, seeks, and open-GOP output with the existing client path.
- Cover duplicate concurrent requests, reconnect from a sequence cursor, cancellation, cache clearing, file replacement during build, truncated input, worker failure, and server restart.
- Keep Node 24 semantic tests and the Bun standalone package covered. Retain the current FLV progressive-indexing and multi-track index-wait regressions.
