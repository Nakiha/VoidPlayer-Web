# Optional native XPSNR sequences

XPSNR is an objective full-reference measurement. This package does not establish perceptual superiority or certify the declared reference relationship. Human blind testing is not a prerequisite for computing a correctly identified objective score. No private media is required: regression inputs are committed public synthetic fixtures.

## Fixed optional component

The component uses `Nakiha/FFmpeg` revision `8998a1a670c81a04d144c36f9e2d3aa680c10720`, the same supplier/revision as the fixed decoder. `libavfilter/vf_xpsnr.c` SHA256 is `4b59b32eb4a501ac74f6d767a916ef1a29833e1895b150cfa96b8e4ffb91f3d7`. Its copyright header specifies LGPL-2.1-or-later. The build explicitly disables GPL, version3, nonfree, autodetection, network and assembler optimizations. Only rawvideo/file inputs, the XPSNR filter and null output are enabled. No libx264/libx265 or user's executable is distributed. The optional FFmpeg process is separate from the Web service; complete corresponding source, license, exact options and supervisor source travel with its directory. See [FFmpeg legal guidance](https://ffmpeg.org/legal.html) and [official filter documentation](https://ffmpeg.org/ffmpeg-filters.html#xpsnr).

Build explicitly on Linux x64 with existing `git`, `cc` and `make`:

```
node scripts/native/build-xpsnr.mjs /absolute/output/xpsnr
```

`XPSNR_SOURCE_DIR` may supply the clean exact pinned source. It is checked, never checked out or modified. The script may clone the fixed public source if absent; it installs no software and changes no host service configuration. The optional component is not bundled automatically. Preserve `ffmpeg-source.tar.gz`, `native-limit.c`, `NOTICES.txt`, binaries and `manifest.json` together. Do not redistribute an arbitrary system or Windows executable under this recipe's license declaration.

Explicitly configure trusted host `nativeXpsnr: {directory,manifestSha256}` using the printed manifest SHA. HTTP requests cannot set an executable path, model or build. Runtime hashes every component file and checks the fixed recipe/source/supervisor. Missing, unsupported-platform, corrupted or untrusted component reports `component-unavailable`; there is no PATH executable lookup, download, PSNR substitution or hidden computation. The minimal binary uses host libc/libm; only Linux x64 is supported in this first component. No new platform certification is implied.

## Input and budget

Use existing discovery and explicit quality-index preparation, immutable reference relation and C correspondence plan. Accept only 2–32 fully mapped **continuous presentation frames**, sampling `all`, no holes, exact equal integer-microsecond cadence on both sides (1..1000000us), same geometry/bit depth and complete trusted source caches. Source packets may be reordered; opaque AU tokens and the existing bounded closed-GOP decoder bind all output including drain. FLV/EnhancedFLV and strict self-contained nonfragmented MP4 plus both mixed directions retain their existing restrictions. MP4 avc1 H2648 or hvc1 HEVC8/10 only; no fragmented/encrypted/external/config-switch/nontrivial-edit/open-CRA/ambiguous clocks. No negative PTS/VFR, ROI, crop/rotate/SAR, scaling, tone mapping, range or color conversion. Only whole-frame limited BT.709 SDR YUV420 8/10-bit; output color is verified during execution, not assumed from preflight.

The XPSNR adapter reuses the existing native sequence decode task and source eligibility. It adds no demux or metric to WASM. Its own bounded durable service has no new general scheduling platform. It owns one shared `qualityAdmission` permit from before component/decode through physical native/Worker exit, final source/index verification and raw deletion. Existing preparation, correspondence, PSNR/range and VMAF operations use that same instance. Parents never hold an outer permit while waiting for nested scoring.

Bounds reuse the published native sequence constants: raw disk128MiB, cumulative index64MiB/1M packets, whole admitted execution120s, native CPU60s/address space512MiB, stdout/stderr64KiB each, result4MiB. Frozen C budgets cover every repeated dependency decode, pre/post-roll/drain output and numeric input. Raw YUV disk bytes and SHA256 are retained. Index reads include initial eligibility, every reopened pair, final decode validation and post-native verification, without pretending failed work was fully measured. Component verification also reads fixed source/archive/binary files within fixed file-size bounds and is covered by the whole deadline. Request16KiB, queue4/actor2, queue wait60s, history16 rows/64MiB reservation (8MiB per row), frame pages≤4. The actual history admission can fill on reserved bytes before the row cap.

## Official numerical contract

The first input to FFmpeg XPSNR is **reference**, the second distorted. `-cpuflags 0`, single decoder/filter/output thread, rawvideo at exact rational `1000000/cadenceUs`, no conversion. Temporal state begins at the selected clip boundary and is preserved across every contiguous frame; final flush completes before parsing. A short clip's boundary reset is part of the measurement recipe and cannot be extrapolated to the whole file.

The filter's exact `stats_file` text (4 decimals), SHA256, per-frame Y/U/V values and official sequence Y/U/V averages plus minimum are persisted. The official `get_avg_xpsnr` pools square roots of weighted distortions then squares their mean, with its low-distortion log-domain fallback. The application never derives that pool from rounded frame dB. The minimum is the minimum of the official per-plane sequence averages, not a spatial heatmap, per-frame minimum average, YUV weighting or VMAF pool. `inf` is represented as `{kind:"positive-infinity",db:null}`; finite dB has no artificial0–100 VMAF range. Unrecognized/truncated/nonfinite/out-of-order or wrong-count output fails closed. Original stats are kept so precision limits are visible.

PSNR/optional SSIM are independently measured from the same decoded native planes. Failure/cancellation of XPSNR can retain completed companions as `partial`/`cancelled` with XPSNR absent. Successful native output is discarded if final source/cache validation fails. Reference integrity remains `not-certified`; concealment detection `unavailable`. Existing negative playback performance evidence is unchanged; native throughput and playback timeline speed are different measurements.

## HTTP, GUI and comparison

Start at `/llms.txt` → `/api/agent/tasks/quality.xpsnr` or `/agent/quality/xpsnr.md` (embedded without frontend). All writes retain exact service Origin, action `quality-job`, cookie/captured actor and existing identity semantics (self-declared attribution, not authentication).

- `GET /api/quality/xpsnr/capability`: bounded component check, no job.
- `POST /api/quality/xpsnr/preflight`: same job body, validates frozen C/source facts, no decode/native score; observer disconnect cancels this one-shot read.
- `POST /api/quality/xpsnr/jobs`: schema `voidplayer-native-xpsnr-job` version1, client, plan{id,attemptId,digest}, recipe `ffmpeg-xpsnr-reference-first-temporal-v1`, cadenceUs, metrics{psnr:true,ssim:boolean}, explicit budget{maxRawBytes,maxElapsedMs,nativeCpuSeconds,nativeMemoryBytes}. Actor/client/key+normalized body gives one durable job.
- `GET /jobs?after=&limit=`, `GET /jobs/{id}`, `/result`, `/frames?after=0&limit=4`, `/candidates` under the XPSNR prefix. Frame cursor is presentation ordinal, not decode AU. `/result` excludes full companion pixels/index documents; results preserve individual source/cache/decoder/MP4 track/sample/ticks/table facts.
- `POST /jobs/{id}/cancel` with `{}`: stopping state is not proof of exit. No automatic replay/recomputation after restart. Own native process identity (PID/start ticks/boot ID) is durably recorded before releasing the supervisor's start gate; recovery stops it before accepting new work.
- `GET /api/quality/xpsnr/compare?ids=ID1,ID2`: explicitly compare2–4 completed own variants. Reference binding/producer/version/build, exact selected reference clocks, reference raw hash, native component and whole recipe must match. Mismatch returns409. Caller order is retained, with official Y/U/V pool and minimum; no guessed content relation or claim of perceptual superiority. Each variant needs its own explicit relation/plan/submission. Replaying a submission does not create a variant.

The quality GUI can take a committed C plan, explicitly submit/freeze/replay, page scores, compare checked variants, cancel and publish candidates. It observes the same durable service as an HTTP Agent. Closing/reloading observation never cancels jobs. Actor/epoch/view fences clear private details and block late responses. The task center adds `kind=xpsnr`/`metric=xpsnr`, exhaustive bounded projections and original C/result/receipt links, without loading complete results or indexes for summaries or moving playback.

Candidates require explicit space/side/maxScore0..200 (finite minimum per-plane **frame** XPSNR threshold), topN≤8, minimum frame spacing, text and severity. Infinity does not create threshold candidates. These selected full-frame temporal observations are not localized defects or human judgments. Selection and operation IDs freeze before annotation transactions; partial/unknown commits replay original IDs/policy, receipt-first even after result reclamation. Shared evidence carries immutable recipe/component/plan/raw/stats and all sequence clocks plus selected original frame facts. Ordinary edits preserve evidence; import/copy downgrades verification to historical. The independent read-only original pair viewer uses verified caches and never reads someone else's private job, scores frames or controls playback. Existing FLV v1 and MP4 v2 evidence/fingerprints remain unchanged when no XPSNR association is present.

The public-only `examples/http-quality.mjs` accepts `mode:"xpsnr"` and an explicit `xpsnr` recipe/budget object. Its default remains read-only; identity/prepare/plan/compute/candidate permissions are separate. It consumes only the public operation descriptions and HTTP responses; no service imports or browser are used.

Unknown POST receipt: retain the exact actor/client/body/key, read original history/receipt and replay that same submission. Never silently use a new key or automatically publish. Process restart interrupts unfinished work and retains already committed companion facts, with no retry/resume.

## Reproducible regression entry points

```
node --test test/unit/native-xpsnr.test.ts
node scripts/native/run-xpsnr-tests.mjs node --test test/media/native-xpsnr-http.test.ts test/media/native-xpsnr-lifecycle.test.ts
npm run build
node scripts/native/run-xpsnr-tests.mjs node scripts/check-native-xpsnr-browser.mjs chromium 8
node scripts/native/run-xpsnr-tests.mjs node scripts/check-native-xpsnr-browser.mjs webkit 10
node scripts/check-native-xpsnr-release.mjs /absolute/compiled-package.tar.gz
```

The real HTTP matrix consumes committed synthetic H2648/HEVC8/10 FLV and strict MP4 remux fixtures with independently decoded YUV. A direct fixed official CLI consumes those oracle YUV files, independent of the pipeline's raw extraction; full emitted text/per-plane/official pool must equal. Matrix includes FLV↔FLV, MP4↔MP4 and both mixed directions, exact PSNR SSE/SSIM companions, frame pagination, shared evidence/historical downgrade, actor/idempotency, comparison and unknown publication recovery. Lifecycle tests retain real CPU/address-space/file limits and physical process supervision, cancellation, native failure, preparation vs native deadline, SIGKILL/restart, final source/cache/table change and queue/permit controls. Phase-controlled native deadline proves exit ownership at that boundary; it does not certify that every end-to-end5s workload reaches native execution. No stopped VFR experiment or private material is used.

For the read-only pooled/frame comparison, pinned recovery and original-frame return workflow, see [XPSNR version comparison](xpsnr-comparison.md).
