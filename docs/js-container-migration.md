# JS container packets and reusable indexes

This delivery extends #63 on accepted main `f5826f4`, without depending on #95. It consumes the unchanged playback/analysis core pin `353088620d08ee4ec2669842508f0fc84da2db28`. Container parsing, indexing, clock metadata and packet selection stay in JS. WebCodecs and packet-fed WASM receive the same packets and index; choosing a decoder does not choose another demuxer.

## Admitted and verified combinations

| Container | Video | Playback | Independent analysis | Boundaries |
| --- | --- | --- | --- | --- |
| 188-byte TS | H.264 | WebCodecs / packet WASM | Exact H.264 pictures | One video, confirmed no audio, static single program/configuration, progressive single-slice pictures |
| 188-byte TS | HEVC Main / Main10 | WebCodecs / packet WASM | Exact HEVC blocks; existing QP capability limits remain | One video, no audio, static single program/configuration, progressive 4:2:0 single-layer pictures; only verified closed IDR anchors |
| Matroska | H.264 / HEVC Main / Main10 | WebCodecs / packet WASM | Same independent packet analysis | One video track/configuration; interleaved audio allowed, existing cache-only optional audio policy retained |
| WebM | VP8 / VP9 | WebCodecs / packet WASM | Packet/index statistics; block/QP explicitly `unsupported-codec` | Verified visible single-picture packets; hidden/show-existing/superframe, alpha/additional and laced-video layouts are outside admission |

The real fixtures contain 600 output pictures each. Tests check full EOF, first/tail/later random access, complete visible pixel planes against the independent container-decoder oracle, and clocks against ffprobe. Browser tests cover local/library and software/browser policies, actual presentation, independent analysis and cancellation. Actual backend and preference are recorded separately; a WebCodecs or `prefer-hardware` result does not establish physical hardware use.

AV1/FFV1/VVC Matroska and other unmigrated codec/container combinations retain their explicitly declared existing route. Matroska crop, non-square display transforms, projection/stereo/alpha, track composition and encoded/scaled/delayed video tracks are outside this admission; those metadata have real presentation semantics in the [Matroska specification](https://www.matroska.org/technical/elements.html). TS with audio, other video codecs, non-188-byte packets, changing/fragmented PSI and unverified layouts are not declared migrated. This delivery does not remove those still-used WASM demuxers. Corrupt clocks/CRC/structure, IO/resource errors and cancellation are failures, not an excuse to switch containers. The server carries a stable `js-combination-not-migrated` admission result through Worker/RPC/NDJSON; only that declared result can select an unmigrated route before decoding. Once admitted, decoder fallback still consumes JS packets.

## Identity, clocks and ownership

`TsPacketSource` and `MatroskaPacketSource` use Mediabunny **1.55.7**. Their opaque sequence numbers are checked against stable whole-track decode ordinals. TS locators are not payload offsets. Matroska locators are cluster data position plus the selected track's block ordinal; a small metadata supplement verifies original block clocks/size and rejects unsupported transformations/lacing, without extracting compressed payloads. Payload reads always go through the independently owned `EncodedPacketSink` cursor and verify locator, size and timestamp.

Original TS PES ticks retain their 1/90000 timebase and explicit missingness. Derived timestamps cannot mint exact picture identity. Matroska retains the original cluster/block timestamp and TimestampScale; raw DTS stays **null**, including B-frame streams. DTS is never replaced with PTS. Static parameter sets, progressive HEVC SPS structure and safe IDR anchors are verified. Picture/cache identity includes source, selected stream, JS build, configuration and AU; old FFmpeg or incompatible JS cache documents cannot stand in for these indexes.

Playback, local analysis and server analysis each own reader, demux cursor, abort state and decoder. Reusing metadata borrows none of the playback seek state. Analysis success/failure/cancellation must preserve the committed playback picture and position; the browser matrix checks that boundary.

## Persistent reuse and rebuilding

Self-reported `complete`, packet count and checksums are structural data, not complete-scan authority. Runtime indexes are sealed only after complete source enumeration or a verified cache delivery.

- **Local:** a bounded-memory SHA-256 chunk tree includes every source byte and size. IndexedDB stores a receipt signed by a separately persisted non-extractable HMAC key after a completed scan. New Workers/pages verify that receipt and the current source identity before using the index. Shape/build/source mismatch, dropped/renumbered records or modified receipts cause a new **JS** scan. Warm local opens still perform the all-byte identity pass; this is reuse of demux/index computation, not a claim of zero media IO. Storage failure keeps the independent JS scan path.
- **Library:** the server alone constructs JS indexes, checks file version before/after scanning, and persists a separate integrity seal. Uploading JS completeness claims is rejected. Source/build-bound HTTP delivery and internal server analysis snapshots authorize reuse in a new consumer Worker. A server restart preserves valid indexes; damaged documents are invalidated and rebuilt by the same JS parser. Library clients do not replace a missing required server index with a client full-track scan or container WASM.

The local cache is bounded to 32 documents / 256 MiB, with a 64 MiB document limit. Full rebuild is conservative: sparse repair of partially damaged indexes is not claimed. The TS JS build changes from v2 to v3, so earlier JS and FFmpeg identities rebuild rather than silently reuse changed semantics.

## Reproduce

```sh
node scripts/run-tests.mjs --case node-js-container-index,node-js-container-matrix,node-js-container-server-cache
node scripts/run-tests.mjs ci-analysis-matrix-js-containers --engine chromium
node scripts/run-tests.mjs ci-analysis-matrix-js-containers --engine webkit
```

Fixtures are generated locally by the registered preparation command; no local media upload is involved. The existing required CI matrix has a separate `js-containers` partition in both engines. Raw browser observations and failure screenshots are retained by the standard fixture/runner artifact lifecycle. See [delivery evidence](evidence/js-container-reuse.json) for revisions, counts, performance verdicts and remaining acceptance. Neither issue is closed by this document; remaining global format coverage, performance acceptance and actual cross-repository demux removal still gate a new alpha.
