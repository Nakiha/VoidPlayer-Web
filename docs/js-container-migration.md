# JS container packets and reusable indexes

Container parsing, indexing, source clocks and packet selection belong to JS for
MP4/MOV/fMP4, FLV, admitted MPEG-TS and Matroska/WebM inputs. WebCodecs and
packet-fed WASM receive the same packets and index; decoder selection does not
select another demuxer. AVI, MPEG-PS and elementary MPEG video retain the
FFmpeg container backend. Removed MOV/Matroska/TS demuxers are not fallback
routes for rejected JS inputs.

## Admitted combinations

| Container | Video | Playback and analysis boundary |
| --- | --- | --- |
| 188-byte TS | H.264 / HEVC Main / Main10 | Browser or packet WASM; exact analysis additionally requires verified coding layout, source clocks and a safe reference chain. |
| 188-byte TS | MPEG-2 frame pictures | Packet WASM playback; no new exact block/QP analysis capability. |
| Matroska | H.264 / HEVC Main / Main10 | Browser or packet WASM and independent packet analysis under the existing codec limits. |
| Matroska/WebM | VP8 / VP9 | Browser or packet WASM; packet statistics do not imply block/QP support. |
| Matroska | FFV1 | Packet WASM with admitted configuration and source-plane geometry; no block/QP analysis. |
| WebM | AV1 temporal units | Packet playback preserves hidden/show-existing inputs; no exact one-AU picture identity. |
| MP4/MOV/fMP4 | Supported visual sample descriptions | JS sample tables drive browser or packet WASM; multiple descriptions retain the conservative software policy. |

Finite static stream/configuration rules are checked by the corresponding
adapter. Dynamic/live TS, unsupported field layouts, linked/multiple/laced or
invisible Matroska arrangements and unverified codec/container combinations
remain outside admission. Multi-slice AVC and MBAFF TS playback can preserve
actual decoded pictures while recording `exactPictureMapping:false`; playback
success does not authorize exact analysis. AV1, FFV1 and MPEG-2 playback likewise
do not inherit H.264/HEVC block capability.

Current parser provenance is defined by `shared/media/mediabunny-version.ts`;
TS and Matroska index schemas/builds are owned by
`shared/media/indexing/ts-packet-index.ts` and
`shared/media/containers/matroska-packet-index.ts`. Release locks and actual core
capability manifests define the consumed artifacts. Historical pins and initial
migration matrices are not current support tables.

## Identity, clocks and ownership

TS locators are opaque packet locators, not payload byte offsets. The PES-header
supplement preserves original 90 kHz ticks and explicit missingness. Derived
presentation timestamps cannot mint exact picture identity. Matroska retains
original cluster/block clocks and TimestampScale; raw DTS remains null and is
never replaced with PTS. Payload reads verify the selected locator, size,
timestamp and configuration against the source-owned index.

Playback, local analysis and server analysis each own their reader, container
cursor, abort state and decoder. Metadata reuse borrows no playback seek state.
Independent analysis success, failure and cancellation preserve the committed
playback picture and position. Source/build/configuration/AU identity prevents
old FFmpeg or incompatible JS cache documents from aliasing current pictures.

## Persistent reuse and rebuilding

Self-reported completeness, packet counts and checksums do not prove a complete
scan. Runtime indexes are sealed after complete enumeration or verified delivery
through the application's own source-bound library protocol.

- Local opens use a session-local source identity. File name, size and mtime do
  not authenticate a cached packet table. Eligible TS can begin with a bounded
  playback prefix; that prefix cannot authorize complete exact analysis.
- Library indexes bind media ID/version/size, selected stream, parser build and
  integrity. The server validates source version before and after scanning and
  owns the persistent seal. Self-asserted complete JS uploads are rejected.
- Library consumers verify the application's origin and current ready source
  metadata; a matching pathname or serialized reference alone grants no trust.
  Index redirects are rejected. Corrupt or incompatible documents rebuild with
  JS. A missing required library index does not trigger a client full-track scan
  or a whole-container WASM fallback.

Index terminal state and retained-source integrity remain separate; see
[container recovery](container-recovery.md). IO/version errors, cancellation,
unsupported layouts and resource limits retain their explicit failure category.
A full first scan can read substantial payload data. Logical read counters,
underlying filesystem/Blob IO, decoded queue memory and process RSS describe
different costs and must not be substituted for one another.

## Verification and historical evidence

```sh
node scripts/run-tests.mjs --case node-js-container-index,node-js-container-matrix,node-js-container-server-cache
node scripts/run-tests.mjs ci-analysis-matrix-js-containers --engine chromium
node scripts/run-tests.mjs ci-analysis-matrix-js-containers --engine webkit
```

The registered cases verify complete native-visible pixels, EOF, seeks, raw
clocks, independent readers, corruption, cache reuse and cancellation. Full
codec/container assertions and required selections live in the unified test
manifest; packet statistics are not an exact-picture oracle.

[Final migration evidence](evidence/demux-removal/final/README.md) preserves the
original functional checks, first-scan IO cost and unresolved headless Chromium
throughput/seek-tail observations. The earlier
[TS product matrix](evidence/js-ts-product-route.json),
[initial CI matrix](evidence/js-ts-product-route-ci-initial.json) and
[artifact comparison](evidence/js-ts-core-provenance-comparison.json) retain their
negative performance results and distinct local/CI playback bytes.
[Reuse evidence](evidence/js-container-reuse.json) records its own historical
revision and acceptance limits. None of these earlier measurements certifies
current performance, physical hardware decoding or display scanout.
