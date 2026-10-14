# Issue63 cross-repository demux removal: read-only preparation

Preparation branch `codex/container-demux-trim` starts at PR96 head `678436b6b31faf49fa287b389aa436076799aaf8`; this branch contains documentation only and has no separate PR. Implementation must wait for review acceptance or explicitly retain that prerequisite base.

Snapshot: Web PR96 product source f5e5430; accepted Web main107c3005. Core pin353088620d08ee4ec2669842508f0fc84da2db28; remote wasm8c81271cea656d79af566fc7d541562c1f8a9f20 has the same file tree (merge-only). No core file or build artifact was modified. Destructive trimming is paused pending PR96 review acceptance.

## Actual artifacts and source

Consumed playback ST: 6,312,687 bytes, SHA256 7c71f847fee0f5e1afa27022d0bf45b6fb29fea1a1c69313a25594a7dadf9b44. MT: 6,370,831 bytes, SHA256 8fe821a5739b2149e4857d4d202bc305692110bc196040c3adfa5d5c93413a65. Analysis:3,199,869 bytes, SHA256 5ab1865c66e0789e6c38bc6b93df05ccbec8d5cb7eefa0624701a9d44fac25ef.

[current-artifact-exports.json](evidence/demux-removal/current-artifact-exports.json) records binary imports/exports. The consumed ST actually opens all six formats through vpd_open: H264 MP4→mov, FFV1 MKV→matroska, H264 TS→mpegts, MPEG2 PS→mpeg, raw MPEG2→mpegvideo, MJPEG AVI→avi. The consumed analysis opens H264 TS and rejects the other five. [current-runtime-demux.json](evidence/demux-removal/current-runtime-demux.json) records these observations and JS runtime ABI keys; analysis binary export names are minified, so checking only literal binary vpd_* names would miss its reachable glue ABI. ST and MT both export vp_open/vp_open_blob, all vp_index_* and all21 vpd_* functions. Analysis glue also exposes those21 vpd_* functions plus codec vpa_* functions.

Source scripts/build-wasm.sh:103–105 enables mov matroska mpegts mpegps mpegvideo avi; decoders ffv1 h264 hevc mpeg1video mpeg2video mpeg4 mjpeg prores vvc vp8 vp9 plus libdav1d; parsers ffv1 h264 hevc mpegvideo mpeg4video mjpeg vvc vp8 vp9. Generated ST/MT demuxer_list.c matches the six. Local playback bytes differ from consumed CI artifacts, so source lists alone are not represented as byte-identical artifact proof. build-analysis.sh:35–51 enables only mpegts and links libavformat plus all shared demux code. Analysis generated registry has only ff_mpegts_demuxer; its artifact hash matches consumed bytes.

## Product combinations and genuine remaining dependencies

| Format / video shape | Current playback route | Independent deep analysis | Evidence / removal implication |
| --- | --- | --- | --- |
| MP4/MOV/fMP4 H264, HEVC, VVC, AV1 with one supported description | Mediabunny Mp4Engine; WebCodecs or packet WASM | H264/HEVC/VVC packets, existing codec limits; AV1 unavailable | Existing MP4/fMP4 matrix and packet pixel tests. mov overlaps, but cannot delete it wholesale yet. |
| MP4 other codecs/descriptions/unsupported layouts | chooseMp4DemuxPlan→openFfmpeg; openSoftwareMedia also retains a staged container/codec fallback | Only explicitly admitted JS analysis | ProRes is recognized by Mediabunny but omitted by Mp4Engine codec mapping; MPEG4 ASP/MJPEG and other compiled codec candidates require actual fixture audit. Multiple sample descriptions are routed to FFmpeg even though some engine config support exists. Do not label every compiled codec/container cross-product accepted without a runtime probe. |
| Legacy/enhanced FLV H264/HEVC/AV1/VVC | Existing JS FlvEngine→native or packet WASM | H264/HEVC/VVC per existing matrix; AV1 unavailable | No FLV demuxer is compiled today; no FLV demux removal remains. Preserve codec decoders and analysis packet feed. |
| Finite static video-only H264/HEVC Main/Main10 188-byte TS | PR96 JS TsPacketSource/index→native or packet WASM | Independent JS packet input→analysis vpa_* | Nine600-picture matrix, two engines. Entire mpegts demux cannot yet be deleted because MPEG2 TS is an established real playback capability. |
| MPEG2 TS; TS audio/other layouts including legacy H264 exact analysis | FFmpeg container/index | Existing ts-input can still read finite single-video H264 using vpd_* and FFmpeg tuple identity; its gate does not exclude interleaved audio | test/media/ffmpeg-media.test.ts explicitly verifies actual MPEG2 TS playback/seek/EOF. MB1.55.7 PMT video mapping is only AVC/HEVC. Before analysis demux deletion, migrate/rebind the remaining admitted legacy H264 shape and rebuild old identities, including audio interleaving; never remove it by unsupported relabeling. |
| Single-video static H264/HEVC Main/Main10 MKV; visible single-picture VP8/VP9 WebM | PR96 JS MatroskaPacketSource→native or packet WASM | H264/HEVC packets; VP8/9 packet statistics, block/QP unavailable | True nine-fixture and local/library decoder matrix. Invisible/virtual/time-slice/output-transform cases are explicitly outside this exact mapping; preserve declared unmigrated route. |
| AV1/ProRes MKV/WebM | FFmpeg container route although MB recognizes the codec | Deep codec analysis unavailable | AV1 WebM exists in QA. AV1 decoder already exists (libdav1d); add a verified output-picture mapping rather than force H264/HEVC syntax proof. ProRes packet codec/config mapping is missing. |
| FFV1 MKV | FFmpeg container; four QA pixel formats | No prior FFV1 block/QP capability | Actual FFV1 playback is asserted. MB1.55.7 Matroska codec dispatch has no V_FFV1. Needs a narrow pinned-library codec/config extension and correct packet decoder setup before deleting matroska. |
| VVC MKV and other existing FFmpeg Matroska candidates | Declared unmigrated FFmpeg route | No accepted MKV VVC deep-analysis fixture | MB1.55.7 has no V_VVC dispatch. Must establish actual existing support and add narrow codec/config wiring or keep the container explicitly not wholly migrated. Do not silently discard compiled capability. |
| AVI / MPEG-PS / raw MPEG video | Genuine FFmpeg residual route | No admitted deep container analysis | Actual artifact probes prove AVI/MJPEG, PS/MPEG2 and raw MPEG2. Mediabunny ALL_FORMATS does not provide these demuxers. Retain these residual demuxers and generic vp_open/index APIs. |

Production call paths: media.ts openInput→chooseMp4DemuxPlan / JS admission→openFFmpegMedia or openFFmpegContainerFromUrl→ffmpeg-worker init→vp_open_blob/vp_open; server/frame-index-build-worker→frame-index-builder→vp_open_blob. Legacy TS analysis: bitstream-analysis/input.ts→ts-input.ts→analysis core vpd_open/bind_index/read/seek. Packet decoder path: flv-decoder.ts→vp_packet_open/send/receive; analysis stream.c→vpa_feed_known, independent of avformat.

## Exact deletion plan, in one coordinated delivery group

1. Audit and add real fixtures for the remaining accepted combinations first. Wire MB-supported AV1/ProRes and MP4 descriptions without coupling decoder choice to demux; implement narrow pinned MB extensions for genuinely retained FFV1/VVC container codecs. TS MPEG2 is not supported by this MB pin: preserving it while removing mpegts requires a real bounded JS packet/AU/clock extension, not an extension-name rule. Preserve original unknown timestamps, actual output identity, interlaced/non-output semantics and declared existing behavior. No general transport/framework rewrite.
2. Complete migration of legacy H264 TS analysis to the JS identity and independent source, including its previously admitted audio-interleaved shape. Explicitly invalidate/rebuild old FFmpeg tuple-index and analysis caches. Then remove Web ts-input.ts, reader.readSync/ffmpegIndex demux plumbing used only by that adapter and runner demuxCore injection; retain independently needed legacy playback indexes for residual formats.
3. In build-analysis.sh: replace --enable-avformat/--enable-demuxer=mpegts with --disable-avformat, remove libavformat.a and shared/vp_demux.c, shared/vp_packet_demux.c, shared/vp_parser_timing.c plus the link wrapper; remove all21 _vpd_* exports and demux compatibility assertions. Preserve all vpa_* codec analysis exports, h264/hevc/vvc decoders/parsers, original timestamp-known feed and budgets. Change build identity/manifest contract and Web release-analysis lock/preparer/verifier together.
4. Playback vpd_* is not used by product playback: its only Web production consumer is the separate analysis core. Remove shared/vp_packet_demux.c and all21 _vpd_* exports from both ST and MT, while retaining shared/vp_demux.c and parser timing wrapper for genuine residual format decoding/indexing. Preserve vp_packet_* and frame/color APIs. Upstream paired-demux regression assertions must be moved to independent JS/native answers or a clearly separate test oracle; do not drop them to make exports disappear.
5. Only after every retained combination is wired and verified, change playback DEMUXERS to the genuine residual set mpegps mpegvideo avi, removing mov matroska mpegts. vp_open/vp_open_blob/vp_index_* remain necessary for residual formats, but runtime enumeration must prove those three removed formats are unregistered, so a generic container entry cannot silently reopen them. If a format still has a genuine unresolved capability, report it as an explicit remaining migration blocker rather than claiming full removal from a flag edit.
6. Fix build cache correctness: current playback .build-signature excludes DEMUXERS/DECODERS/PARSERS, so changing the script can reuse stale configure output. Include normalized configure capability inputs/source in the signature and reject stale roots. Analysis signature must likewise describe the actual no-avformat capability set.
7. Publish generated actual demux registries, configure identity, runtime exports and library/link list for ST/MT/analysis in a hashed capability manifest. Current Web packaging copies provenance hashes but omits the playback source package demux manifest; require the capability manifest in prepare-release-core, prepare-analysis-core, core-artifacts, package manifest and release checks. Validate runtime instantiated glue as well as binary exports (minified analysis names); include a bounded actual av_demuxer_iterate diagnostic for residual playback. Expected playback list mpegps/mpegvideo/avi; analysis list empty; vpd_* absent in both. Actual removed-format opens must fail, while residual opens still succeed.
8. Build fresh pinned artifacts in the decoder repository, push the source revision, then update Web locks to that immutable revision and test actual consumed hashes. Run the retained original codec/color/frame/analysis tests, complete JS routing/cache/cancel matrix with container ABI guards, both engines, portable package checks and unchanged playback bench. No old product core/demux hidden in an auxiliary package. Submit one cross-repository group with explicit Web base/codec artifact dependency. No alpha until #63 acceptance is met.

Immediately removable without product capability loss: unused playback independent vpd_* API/link unit (after preserving its QA through the new source contract). No whole overlapping playback demuxer is proven safe to remove yet. Analysis mpegts/avformat is close, but legacy H264 shapes must first move to JS; current video-only admission does not establish that equivalence.

## Performance evidence discipline

Device Apple M5 MacBook Pro (Mac17,2),10 CPU cores,32GiB, Apple M5 GPU; macOS27.2 build26B5101f; Node24.15.0. Headless Chromium153 and Playwright WebKit from installed lock. Original8,000ms ×3 repetitions and original thresholds remain. Baseline f5826f4 and candidate revisions use identical fixtures/core. Repeat1 starts a fresh page and cold per-source server index; repeats2/3 replace source/Worker in the same page with warm server metadata. This is not an OS disk-cache flush. No physical scanout/hardware claim.

The existing report startupMs and firstPresentationMs are playback-start measurements after load_library_item has already completed, not cold media-open/first-source-frame latency. peakBytes/peakFrames measures decoded queues only, not JS/index/WASM/GPU/RSS totals. Server build profiles record actual diskReadCalls/diskReadBytes and packet counts; metadataOnly is not treated as zero payload IO. Full local identity still reads all source bytes even on warm reuse. A full same-sample cold/warm first-open plus two late positions, cancellation latency, actual IO/packet advancement and sampled JS/WASM/RSS ledger is still required; unavailable fields stay null, not inferred.

Chromium baseline and candidate both fail the absolute0.9x threshold, while WebKit software passes. This observation is neither proof of no regression nor a reason to halt other implementation. Separate baseline absolute failure from paired changes, report distributions with backend/policy/configuration, and diagnose material new regressions. The published existing baseline used the former accepted main f5826f4, so it is not mislabeled as a fresh107c baseline.

See [source inventory](evidence/demux-removal/source-inventory.json), [actual QA fixture inventory](evidence/demux-removal/qa-fixture-inventory.json), and [bounded performance ledger](evidence/demux-removal/performance-ledger.json).

## Actual coordinated implementation

Core draft: https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/pull/7
Immutable source/artifact pin: `e88064cb20e4ae4dfad5395a6bf1103a9efa0154`.
ST and pthread playback binaries instantiate with only AVI, MPEG-PS and MPEG
video demuxers. Analysis instantiates with no demuxer and links avcodec/avutil.
All three capability manifests record actual binary registries and SHA-256;
`vpd_*` is absent. Web preparation checks live registries and packages both
variant manifests/capabilities under byte provenance. Old overlapping caches
rebuild under JS packet build v4; no removed container route remains as a
whole-container decoder fallback.

Existing product cases retained: H264/HEVC static TS (including interleaved
AAC), H264/HEVC/VP8/VP9 Matroska/WebM, FFV1 8/10/16-bit Matroska (odd geometry,
SAR and source tags), MPEG-2 TS and AV1 WebM. Small MPEG-4/MJPEG/ProRes MOV/MP4
fixtures retain already compiled decoder capability through sample tables.
AV1 temporal units preserve hidden/show-existing decoder input without claiming
one-AU exact picture identity. Block/QP support still covers the admitted AVC
and HEVC cases; other codecs keep explicit existing analysis limits.

The original damaged-tail assertions run on JS owners: TS short tails retain
confirmed AUs, larger transport gaps quarantine the last GOP, and HEVC CRA is a
quarantine boundary without being promoted to a closed seek anchor. Finished
index enumeration is separate from `indexIntegrity: prefix`; truncated bounds
and warnings survive authenticated cold/warm server cache reuse. IO failures,
unknown clocks and unsupported coding layouts are not treated as truncation.
A finite Matroska Segment can retain its declared frames when foreign bytes
follow the Segment; linked/multiple Segments and damage inside its declared
bounds still fail closed.

Validation ownership is explicit. The old C-only TS progressive-prefix counters
belong to an intentionally removed container API; historical scripts remain in
the core repository and are not claimed as passing against the new binary.
Web regressions retain damage/prefix pixel, imported cache boundary, full EOF,
seek, independent readers and resource assertions. Residual C demux/index tests
retain AVIO/CPU/storage counters, original packet timestamps and atomic untimed
index import on AVI/PS/elementary inputs. Existing FATE geometry, sample-description
changes, cropped AVC, interlaced MP4 and frozen sample fingerprints are retained.

Final acceptance still requires the registered full suites, both headless
engines, portable packaging, original benchmark thresholds and measured
cold/warm/late-seek IO/memory evidence. No statistical no-regression or physical
hardware claim is inferred from headless results; unmeasured ledger fields stay
null. Neither issue closure nor a release is requested by this draft group.
