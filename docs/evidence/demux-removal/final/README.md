# Final demux migration evidence

Functional migration checks passed. Performance acceptance remains open: headless Chromium fails the unchanged absolute benchmark on both baseline and candidate, and its MPEG-2 paired throughput and seek tail need further assessment. These observations do not establish statistical non-regression.

Product code: `6470cb81365b1b7a15385bfd5213568c3f1c9c4c`; product source digest `1e8b29a65948b7a9b737d9a0cb1aa82568c74d96879b3e8e1f4fdef4db9e5182`. Core/artifact pin: `e88064cb20e4ae4dfad5395a6bf1103a9efa0154`. Later documentation-only commits do not change these measured product bytes.

## Original playback benchmark

All four original scenarios, three repetitions, 8,000ms or clip end, unchanged assertions/thresholds. Only the documented `--headless` option and service/report URLs are supplied. No original scenario is filtered. Hardware use and physical display scanout are unverified.

| Scenario | Adjacent baseline WebKit speed median | Candidate WebKit | Adjacent baseline Chromium | Candidate Chromium |
| --- | ---: | ---: | ---: | ---: |
| hevc-4k-solo | 0.995x | 0.995x | 0.238x | 0.236x |
| vvc-wasm-solo | 1.000x | 1.000x | 0.249x | 0.226x |
| vvc+hevc-4k | 1.000x | 1.000x | 0.235x | 0.235x |
| mpeg2ts+h264 | 0.999x | 1.000x | 0.504x | 0.437x |

WebKit adjacent baseline and final candidate each pass12/12. Chromium baseline and final candidate each pass0/12; below-realtime and presentation-stall failures remain failures. Candidate MPEG-2+AVC median speed is about0.437x versus0.504x in the adjacent baseline. This difference is retained as an open performance limitation, not waived because the baseline also fails.

The earlier WebKit baseline was about0.5x in every scenario, while an adjacent rerun passes. Both cohorts are preserved; a purported2x implementation improvement would be confounded. No outliers are removed.

## Cold/warm and late-seek IO

Eight identical fixture files are measured on baseline/candidate and both engines. Each source starts with a fresh server index DB and browser context, then has two warm source/Worker replacements. Each open is followed by60% and93% seeks, plus independent analysis cancellation where supported. This does not flush host OS caches. The full fixture SHA-256, actual source/index/decoder state, original presentation clocks, requests, completed body bytes, server build profiles and phase observations are in [summary.json](summary.json) and its compressed raw cohorts.

MPEG-2 server first-scan filesystem reads are61,593,312 bytes for the JS implementation versus24,450,744 AVIO bytes in the baseline (20,531,104-byte source). The JS validation/clock/payload passes are an explicit first-scan IO cost. Warm metadata reuse avoids another server build; it is not zero client payload IO.

| Chromium MPEG-2 93% seek cohort | Cold ms | Warm1 ms | Warm2 ms |
| --- | ---: | ---: | ---: |
| baseline / initial | 53.4 | 52.6 | 50.7 |
| candidate / initial | 612.5 | 613.9 | 607.6 |
| candidate-preroll / preroll | 20.5 | 21.8 | 617.0 |
| candidate-preroll-timing / preroll | 22.0 | 19.9 | 589.2 |

The final MPEG-2 receive threshold skips preroll conversion/pixel copies while preserving an output-led retry if an indexed floor produces no actual output. Original missing-floor/EOF, complete native pixels and seek assertions pass. Instrumentation confirms20 compressed packets accepted and only1 pixel materialization for each93% seek. Long-tail samples remain: a589ms seek spent about9.9ms in packet send and0.1ms in packet receive; most observed latency is outside those synchronous WASM calls. The specific remaining cause has not been proven. The instrumented cohort is separate from unmodified page-latency runs and the unchanged benchmark.

## Memory and packet observations

Node RSS is sampled every10ms in the owned server/harness process, including its Node Workers and Playwright controller overhead. Chromium main-context JS heap values are snapshots, not a whole-browser peak; WebKit has no corresponding measurement. Supplemental IO runs wrap the real playback-core `ccall` boundary to record `HEAPU8.byteLength` (reserved linear capacity, not live allocation or resident bytes), active Worker ownership and accepted compressed packet inputs. Original benchmark runs are not instrumented.

These components overlap or omit memory domains and must not be added into a claimed application peak. Browser Worker JS heap, GPU memory, physical residency, combined peak and container-internal packet advancement are null where unavailable. Decoder queue `peakBytes` in the original benchmark only describes queued frames. No hardware-use or complete memory-budget claim is inferred.

## Functional validation and support boundaries

- Final code:19/19 targeted unit checks,24/24 native packet/pixel/damage checks, TypeScript and production build.
- Existing browser open matrix:all8fixtures ×3modes in each engine. Original loewe bytes are retained; no positive case becomes an unsupported expectation.
- Incremental FLV:both engines retain pending, partial completed GOPs, incomplete index, cancellation, continuation to300pictures and unchanged playback position/state.
- Earlier shared-container matrix:36local/library/software/browser analysis cases per engine, corrupted persisted receipt rebuild and fresh-runtime reuse. Finite library Worker drains verify complete FFV1/MPEG-2/AV1/legacy MP4 outputs; local UI cases verify presentation/seek/EOF.
- Real loewe recovery:physical alignment1, CRC-valid delayed PSI within1MiB, actual in-band HEVC IRAP,9physical PES packets, original PTS/nullable DTS and6actual native-matching decoded outputs, including every-frame seek. Prefix damage and unverified picture identity remain explicit.
- Multi-slice AVC and coding MBAFF:ST/MT25/50/50full outputs match native; no exact picture token; independent exact analysis rejects unverified mapping after cache reuse.
- Native darwin-arm64 preview at the final product head:service, isolated deployment/restart, native analysis/cache and full WebKit/Chromium acceptance passed.
- Core exact pin CI passes actual ST/MT registry and removed-format/residual-open, packet ABI and PQ/HLG checks.

Admitted finite video combinations include AVC/HEVC188-byte TS (verified static shapes and the bounded broadcast recovery), MPEG-2 frame-picture TS, AVC/HEVC/VP8/VP9/FFV1 Matroska/WebM, AV1 WebM temporal units, and supported MP4/MOV visual sample descriptions including MPEG-4/MJPEG/ProRes/VVC. H264/HEVC exact deep analysis retains its coding-layout and timing proof requirements. AV1/FFV1/MPEG-2 playback does not imply new exact block/QP analysis.

Dynamic/live PSI, unsupported field layouts, linked/multiple/laced/invisible Matroska arrangements and unverified codec/container combinations remain outside this finite admission. AVI, MPEG-PS and raw MPEG video retain the genuine FFmpeg residual demuxers. No removed MOV/Matroska/TS whole-container route silently falls back to FFmpeg. An earlier intermittent WebKit blob error remains unproven; diagnostics and the empty-page-errors assertion are retained. Later matrices passed without filtering it.

## Raw evidence and reproduction

The raw manifest inside [summary.json](summary.json) binds each deterministic gzip archive to both compressed and original JSON SHA-256. All early, adjacent, pre-optimization, final and supplemental cohorts remain present with exact product/build IDs. This directory contains measurements, not a replacement test oracle.

Prepare both checkouts and their exact pinned cores, build their frontends, and supply the same generated/QA fixtures. Each invocation owns and closes its DB, service and headless browser. Run serially:

```sh
VP_EVIDENCE_FIXTURES_ROOT="$candidate/fixtures" node run-comparison.mjs "$baseline" webkit baseline bench "$out"
VP_EVIDENCE_FIXTURES_ROOT="$candidate/fixtures" node run-comparison.mjs "$candidate" webkit candidate bench "$out"
VP_EVIDENCE_FIXTURES_ROOT="$candidate/fixtures" node run-comparison.mjs "$candidate" chromium candidate io-plain "$out"
VP_EVIDENCE_FIXTURES_ROOT="$candidate/fixtures" node run-comparison.mjs "$candidate" chromium candidate io "$out"
```

Repeat the applicable baseline/candidate engine cells; `bench` always uses the unchanged original defaults. `io-plain` collects unmodified supplementary latency and IO; `io` adds the disclosed WASM component instrumentation. `VP_EVIDENCE_FILE` optionally restricts a diagnostic IO run and is written into its report; it never filters the benchmark. No user browser or unrelated process is stopped.

Final CI/acceptance, merge and release remain with the coordinating parent; no issue is closed by this evidence commit.
