# Native single-source CAMBI screening (#116)

This work uses the optional Linux x64 component installed for [native VMAF](native-vmaf.md), pinned to Netflix/vmaf v3.0.0, revision `17a67b238ce0539bdeafdc95961abac64fa16ea8`. The CAMBI command executes `--no_prediction --feature cambi`; no VMAF model is loaded and full-reference mode is disabled. The public request identifies one source; the CLI receives that same raw file in both API slots because the upstream feature API requires two paths.

CAMBI is a no-reference, uncalibrated banding indication: higher means more detected banding, zero is a completed numeric result, and neither is a product quality pass/fail. Each frame is independent, so deterministic stride sampling is allowed and unsampled pictures remain explicit. No temporal tracking or reference integrity certification is claimed; decoder concealment detection is unavailable.

## Verified component boundary

The installed scalar v3.0.0 binary was executed on a synthetic 640×360 8-bit YUV420 input. It produced one CAMBI score and five upstream heatmaps with exact dimensions 640×360, 320×180, 160×90, 80×45 and 40×23. Each file contains row-major native uint16, little endian on the only supported x64 platform; successive frame planes are concatenated. Upstream rounds each downscaled dimension upward and writes at `frame * width * height * 2`. Its values are scaled internal c-values, not independent cropped-region CAMBI scores.

Source audit and actual execution found that both dimensions below 320 are unsupported; the CLI with threads may exit zero with no frames. Admission therefore requires a long edge ≥320, and zero exit is never sufficient: exact scores, file set and all five lengths must match. Capability checks run a real one-frame feature/heatmap self-test under the shared admission slot.

The scope remains trusted complete FLV/Enhanced FLV H.264/HEVC, original planar 8/10-bit limited BT.709 SDR, exact square uncropped/unrotated geometry. No HDR, extra containers, conversion, GPU, browser WASM CAMBI, or distributed execution.

## Budget model

All five scale byte counts are computed before native execution, multiplied by the selected frame count and checked against the aggregate heatmap budget. Raw sequence bytes are bounded separately. The fixed audited binary writes exactly five known heatmap files and one result file: temporary reservation charges **six per-file caps plus raw bytes**, so `RLIMIT_FSIZE` is not represented as a total directory quota. Exact file set, regular-file status and final lengths are checked after physical exit. This is a trusted-component bound, not a sandbox for arbitrary executables. Paths and feature options never come from HTTP. Scores and image bytes remain separate; frame/scale heatmap reads are on demand.

Implementation is a full candidate; formal PR checks and independent review are still required before merge.

## Single-source HTTP and Agent workflow

`GET /api/quality/cambi/capability` reports `enabled`, `component-unavailable`, or `cambi-feature-unavailable`; a successful response includes an actual `executed-CAMBI-and-five-heatmaps` self-test. Other platforms remain unavailable. Use the existing component installer and trusted `nativeVmaf: {directory, manifestSha256}` service configuration. There is no HTTP executable, model, output-directory or arbitrary feature-option input. No model is loaded for CAMBI prediction.

1. Use `/api/library/discovery?limit=16` and its exact `nextCursor` to choose a versioned source. Coverage/unknown reasons remain those of discovery. Metadata-readable MP4/MKV/TS is not CAMBI scoring support.
2. Read `/api/media/{id}/psnr-source?v={version}`. Copy its complete `binding` into `source`. A missing/stale cache is an explicit refusal. Prepare a trusted FLV cache only through the existing **explicit**, budgeted `/api/library/preparations` or `/psnr-index` command; reading/submitting CAMBI never builds one.
3. Select a half-open interval in **actual source PTS microseconds**, plus deterministic decode-order interval-AU stride. At most256 indexed AUs in the interval and32 selected supported pictures. Negative or nonuniform presentation clocks in this first matrix are rejected; no VFR certification. Closed dependency windows remain≤32 AU. Unsupported sampled pictures and unsampled AUs are counted separately, never silently called coverage.
4. Submit once, retain the exact body/client/key for an unknown HTTP outcome. Choose an actor first; the captured actor header must equal the cookie actor **before** any mutation. HTTP/GUI/Agent use the same command and durable job.

```http
POST /api/quality/cambi/jobs
Cookie: voidplayer-user=SELECTED_ACTOR
X-VoidPlayer-Actor: SELECTED_ACTOR
Origin: http://YOUR_SERVICE
X-VoidPlayer-Action: quality-job
Idempotency-Key: RETAIN_THIS_EXPLICIT_KEY
Content-Type: application/json

{"schema":"voidplayer-cambi-job","version":1,
 "client":{"id":"my-nr-agent","kind":"agent"},
 "source":{"mediaId":"PINNED_ID","mediaVersion":"PINNED_VERSION","size":PINNED_SIZE,
   "indexIdentity":EXACT_INDEX_IDENTITY,"indexBuildId":"PINNED_BUILD"},
 "interval":{"startPtsUs":0,"endPtsUs":1000000},"sampling":{"stride":1},
 "budget":{"maxRawBytes":67108864,"maxHeatBytes":33554432,"maxTemporaryBytes":268435456,
   "maxElapsedMs":120000,"nativeCpuSeconds":60,"nativeMemoryBytes":536870912}}
```

The single-source body has **no reference, correspondence plan or VMAF model**. Raw decode is independent of loaded browser tracks. The native CLI receives the identical packed raw file in its two upstream API slots, `--no_prediction`, `full_ref=false`, EOTF BT.1886, no resizing, one thread, CPU mask0, subsampling1. `enc_bitdepth` and source/encoding resolution overrides remain upstream defaults0, derived from the actual frame. Requested window63 is adjusted by upstream integer `floor(floor(63*(width+height)/375)/16)`; all other fixed feature parameters are in the immutable recipe. Source bit depth and exact full-resolution geometry remain separate from the internal10-bit processing domain.

Read `/api/quality/cambi/jobs?after=ROW&limit=8`, `/jobs/{id}`, `/jobs/{id}/result`, and `/jobs/{id}/frames?after=INDEX&limit=4`. Result summaries contain coverage, worst≤8 frames, source/recipe/component identity, output reservations and measured native CPU/RSS/wall/bytes. They never embed whole heatmap images. `/jobs/{id}/heatmap?index=N&scale=S` returns one original plane with SHA256. Frame pages distinguish `provisional-uncommitted-attempt` during evidence persistence after successful native execution/source-final verification from `immutable-completed`. Only complete immutable results can create candidates. Progress is real prepared/scored frame counts, not invented percentages. Failed, cancelled, unavailable, incomplete, no-results and completed zero scores remain different states.

`POST /jobs/{id}/cancel {}` explicitly stops a durable job; observer disconnect/window close only stops observation. Shared admission covers component check, owned WASM Worker, native supervisor, final source check, durable heatmap copy and raw cleanup. No outer coordinator holds a second slot. CPU/address-space/single-file/stdout/whole-time limits remain enforced; all dependency input/output/drain/index reads are counted. Exactly five scale files plus one JSON result are accepted, with exact lengths and regular-file checks. No output glob/path comes from HTTP. A conservative six-file reservation bounds the fixed trusted producer; this is not an arbitrary-program filesystem security sandbox. Queues4/actor2, a60s queue deadline, eight retained job receipts, and256MiB **logical** durable reservations bound this instance. SQLite pages/WAL add storage overhead beyond logical content; this is not a filesystem quota.

Cancellation/timeout/shutdown waits for real Worker IO closure and native process exit before releasing admission. Uncertain stop poisons the executor and retains capacity/files. Restart validates durable PID/start/boot ownership, stops the matching process and records `interrupted`; it never retries computation. Successful request replays consult the durable actor/client/key receipt before source/result lookup. There is no automatic sharing of computations.

## Actual multiscale evidence and candidates

Explicit `POST /jobs/{id}/candidates`:

```json
{"space":"default","minScore":0,"limit":1,"scale":1,"cellThreshold":1,
 "text":"Inspect this uncalibrated banding candidate","severity":3}
```

`minScore` is an uncalibrated whole-frame score filter (higher first, index tie-break), and `cellThreshold` is an explicit0..65535 heatmap-code threshold, minimum1. A nonzero map-cell bounding region is derived from the **actual** selected scale. No score-only spatial box is invented. Disconnected cells may share a bounding rectangle; this does not claim one object or contiguous defect. The evidence preserves region sample count/mean/max, source frame/AU/PTS/namespace/build/proof, raw-plane hash, every scale hash, mapping factor/ceil edges and full fixed recipe. Cell coordinates denote a decimated source lattice and local analysis windows include neighboring context; the rectangle is an evidence region, not a certified defect boundary. This is `official-heatmap-cell-statistics-not-cropped-CAMBI`, never a small-crop rescore.

The policy, selected result references and new annotation/operation IDs freeze before publication. Each shared candidate is the ordinary transactional `create-cambi-candidate` annotation command (same receipt, record and activity event transaction), with explicit text/severity and `not-subjectively-assessed`. The standalone annotation HTTP command accepts `cambi: {jobId,attemptId,digest,index,scale,region}` and resolves ownership after receipt lookup. Replays still work after result reclamation; policy changes conflict. Empty selection is an explicit empty publication, not fabricated spatial evidence.

CAMBI attachments are **single-source**, separate from PSNR pair evidence. Normal edits/replies preserve them and cannot forge/remove immutable facts. Workspace/review version3 is required and old v1/v2 rejects instead of dropping the attachment. Annotation DB version5 prevents older programs rewriting these records. Imported/copied facts retain historical data and lose service verification.

The new-window viewer opens `/quality.html?cambi=1&space=...&annotationId=...&evidenceId=...`. It reads the shared annotation and `/api/quality/cambi/shared/{space}/{annotationId}/{evidenceId}?scale=S`, never another actor's private job. All five official scales are available on demand. It obtains one separately decoded raw source snapshot, verifies its source/cache/AU/configuration/decoder/layout/raw hash against the attachment and routes it through the normal presenter. Generation numbers are ephemeral; all packet content/identity facts remain checked. There is no rescoring or playback seek. Source/cache changes, historical/foreign/deleted/removed evidence or late replies hide the view. Heatmap display is a declared fixed0..65535 linear color mapping; it is not a subjective severity scale.

## Samples, observed limitations and performance

Formal fixtures are original synthetic banded/smooth gradients, flat, high-frequency texture and grain, plus the licensed official processed natural image `KristenAndSara_1280x720_8bit_processed.yuv` from Netflix/vmaf_resource revision `5e7b853baf97cea275ce8175d80c6f3c817169d4`. The official file SHA256 is `41a2c05e4c5ba39b3ea01b6c8afde05b79f129f7da3ea1a4c6639013929c5bf8`; retain `test/helpers/native-cambi-official-NOTICE.txt` (BSD-2-Clause-Patent). That single original frame is explicitly repeated four times; its10-bit derivative left-shifts8-bit codes and does **not** restore source precision. Fixture regeneration uses FFmpeg only offline; native Node/Bun/compiled tests consume fixed FLV plus independently decoded raw byte oracles without PATH tools. No private/user footage is included.

Initial four-frame local observations (one run each, not calibrated benchmarks): banded640×352 scored≈19.31 in8bit/10bit;8-bit nominally smooth quantized gradient≈11.80 while10-bit smooth was0; flat/texture/grain were0. Grain masking a known banded signal is a false-negative warning. The processed natural image1280×720 scored≈0.21 (8bit) /1.09 (derived10bit); source depth semantics/preprocessing need not give equal CAMBI scores. These examples neither validate general natural-footage false-positive rates nor provide a product threshold.

For640×352×4, native CPU≈15–39ms and RSS≈7–9.5MiB, heatmaps2,400,640bytes, raw1,351,680/2,703,360bytes, conservative temporary reservation15,286,272bytes; complete service preparation≈0.6–0.9s. The1280×720 natural example native CPU≈74–97ms/RSS≈20–29MiB, heatmaps9,820,800bytes, raw5,529,600/11,059,200bytes, temporary reservation55,296,000bytes; whole preparation≈0.86–1.06s. These bounded examples are not throughput/real-time acceptance. Existing performance gate **16/16 failed samples** remains unchanged.

| Original proxy | Migration decision |
| --- | --- |
| banding | Official pinned CAMBI with source-depth/recipe/heatmap evidence; uncalibrated candidate signal |
| blockiness | Experimental; no general migration/subjective calibration evidence |
| blur | Experimental; no production migration |
| noise | Experimental; grain may mask banding and must not be treated as universal degradation |
| flicker | Experimental; CAMBI is per-frame and does not track temporal defects |

Validation includes fixed official frame scores/pools and byte-for-byte five-scale layouts, original raw-plane hashes, source/capability/aggregate-budget/shape failures, actor/key/receipt/historical fences, real process cancel/deadline/crash/restart and shared admission. Real GUI submission and evidence viewing are exercised in Chromium/WebKit8/10, with another player's actual source PTS advancing. The installed compiled Bun test runs with an empty PATH. Final exact-commit PR CI and independent review remain the merge gate; this document does not claim they have completed for an unmerged candidate.

The compiled multi-entry build explicitly pins Bun's output root to `server`. A local full-entry probe reproduced the unpinned build embedding Worker files under `/$bunfs/root/server/`, while existing compiled URLs address `/$bunfs/root/analysis/...`; explicit `--root server` restored those actual Worker entries without changing runtime paths or assertions. All compiled native tests must run after this build-root fix; a successful source/Bun interpretation is insufficient.
