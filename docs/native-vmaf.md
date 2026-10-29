# Native VMAF continuous sequence workflow (#122)

> 默认执行器已迁移至现有分析 WASM core。当前架构和阶段验收见 [analysis-wasm-scoring.md](analysis-wasm-scoring.md)；本文中的 Linux 原生组件、临时 YUV 和 supervisor 描述保留为历史执行器契约，不代表新任务路径。

The optional `quality.vmaf` executor consumes a committed, actor-owned [clock
correspondence plan](reference-clock-plans.md). GUI and HTTP agents share the
same durable commands, independent of playback. It is separate from the existing
PSNR/SSIM [range aggregate](bounded-quality-ranges.md): sparse observations are
never joined into a pretend continuous clip.

## Installed component and model identity

First platform: **Linux x64**. Other platforms report `component-unavailable`;
shipping the Web application does not imply a native component is installed.
The application never searches PATH, downloads an executable, installs a model,
or accepts executable/model paths or extra command-line arguments over HTTP.
A trusted service administrator explicitly configures the component directory
and its manifest SHA256. Local administrators and OS shared libraries remain in
the trusted host boundary; hashes are not a sandbox against a malicious local
administrator or concurrent replacement of that administrator's files.

Official source: [Netflix/vmaf v3.0.0](https://github.com/Netflix/vmaf/tree/17a67b238ce0539bdeafdc95961abac64fa16ea8),
revision `17a67b238ce0539bdeafdc95961abac64fa16ea8`; CLI reports `17a67b2`.
At that revision [models.md](https://github.com/Netflix/vmaf/blob/17a67b238ce0539bdeafdc95961abac64fa16ea8/resource/doc/models.md)
is authoritative. The newer upstream `models_v0.md` describes this model family;
**v0.6.1 is a fixed baseline, not the newest model**. The HDTV model's calibration
assumes 1080p at approximately three picture heights. Accepting a small test clip
without rescaling does not certify subjective quality under different viewing
conditions.

| Request model | Official JSON | SHA256 |
| --- | --- | --- |
| `vmaf_v0_6_1` | `vmaf_v0.6.1.json` | `5950d61fa1f861bd45d8149d80539ed9f3376cfc2495b8f0fa8e9f57cb131ee3` |
| `vmaf_v0_6_1neg` | `vmaf_v0.6.1neg.json` | `1fcda193aaa2a3136471b7516b3c5dc344546c05fcde2d58609f8c60a2387392` |

For these two fixed models, higher is better and the official default model clipping is 0..100; this does not assign the same range or viewing conditions to future models.

NEG is an explicit alternative for encoding comparisons; the executor does not
silently switch models. The fixed recipe uses one CPU thread, CPU mask 0,
subsample 1, no preprocessing/rescale/phone/4K/HDR transform or score-enhancement
options. Native CLI computes one entire sequence, resets temporal state at clip
start and performs its final flush. Results retain every official frame score and
`min`, `max`, `mean`, `harmonic_mean` unchanged; identical inputs need not score
exactly 100 in every frame. These are not individual-frame VMAF calls averaged
by the application.

Build/install (Python 3 with venv, Git and a C/C++ compiler required):

```sh
node scripts/native/prepare-vmaf.mjs /absolute/component-directory
```

The explicit build step installs local Meson 1.7.2/Ninja 1.11.1.4 tools and checks
out the clean fixed official revision. It records compiler, build options and
actual binary/model/supervisor/notices hashes in `manifest.json`, then prints the
configuration fragment. To use already installed pinned tools/source directly,
see `scripts/native/build-vmaf.mjs` (`VMAF_MESON`, `VMAF_NINJA`, `VMAF_SOURCE_DIR`).
Scalar CPU build: release/static libvmaf, no assembly/AVX512, built-in models,
float model, CUDA/NVTX, tests or docs. This fixes the recipe, not a universal
compiler-independent executable hash. Each installation pins its own actual
manifest and binary hashes. Runtime needs ordinary Linux libc, libm, libstdc++
and libgcc; it does not invoke compiler/Python/ffmpeg tools.

Copy only `manifest.json`, `vmaf`, `vmaf-limit`, both JSON models and `NOTICES.txt`
to a private administrator-controlled installation directory. Retain the official
[BSD-2-Clause-Patent license](https://github.com/Netflix/vmaf/blob/17a67b238ce0539bdeafdc95961abac64fa16ea8/LICENSE)
and LIBSVM notice, plus the Web repository LGPL-2.1-or-later license/source notice for the separate resource supervisor. Its own repository revision and exact C source hash are also recorded and checked. The build creates `NOTICES.txt` from the fixed source. Configure
`voidplayer.config.json`, then restart:

```json
{"nativeVmaf":{"directory":"/absolute/component-directory","manifestSha256":"THE_PRINTED_SHA256"}}
```

Relative directories resolve against the configuration file. This is a fragment
of the trusted configuration, not a new HTTP installation endpoint. Component
capability validation checks platform, clean-source identity recorded by the
builder, build recipe, executable files, all hashes and both model hashes.
It never promotes unverified model bytes merely because a filename matches.

## Exact eligibility and raw planes

A C plan pins source ID/version, container cache namespace/build, stream/configuration,
AU/window and actual source PTS. Both caches must already have trusted server
producer evidence. This endpoint never builds an index or tries approximate PTS,
filenames or durations to authenticate corresponding content.

First scope:

- Trusted FLV/Enhanced FLV H.264/HEVC, or the [strict non-fragmented MP4
  matrix](trusted-mp4-quality.md): avc1 H.2648 and hvc1 HEVC8/10. MP4/MP4 and
  both MP4/FLV directions use the same packet-identity WASM decoder.
- 2–32 selected pictures on each side, all-sample/no holes. Ordered by the frozen
  reference source PTS; distorted order must agree. Both clocks must have the
  caller's exact positive integer `cadenceUs`, no duplicates, negative PTS or VFR.
  Every indexed picture in each selected presentation interval must be included.
  MP4 sample durations must also equal this cadence. Track/sample ordinal,
  description, original DTS/CTS/duration ticks and timebase, offset/size and
  table SHA256 remain explicit; inexact microseconds reject without rounding or
  POC clock repair. Actual source tables/NAL boundaries use the strict MP4
  adapter, never synthetic FLV tags. Fragmented/protected/external-reference
  inputs, track/configuration changes, remapping edits, recovery and CRA/open
  GOP remain unsupported.
- Every individual decoded dependency window still has the existing closed
  start/32-AU, opaque-token/all-output/drain and single-picture/field rules.
  These checks do **not** certify reference-graph completeness. Concealment
  detection remains unavailable, including known H.264 missing-reference cases.
- Equal full-frame 64..1920 by 64..1080 geometry, even dimensions, exact SPS square
  SAR, no crop or rotation; limited BT.709 primaries/transfer/matrix, explicit
  left chroma, planar YUV420 8/10-bit. Missing tags reject, without relabelling.
- Copy visible Y/U/V rows tightly, native code values, 10-bit little endian.
  Recipe identifies `visible-y-u-v-tight-little-endian-v1`; no browser pixels,
  padding, colorspace conversion, arbitrary ROI, GPU or HDR processing.

Preflight reads only fixed source/cache facts and exact geometry. Its
`rawColorVerification: required-at-execution` is deliberate: preflight success
is not a promise that decode/output color checks or the native model will pass.
Execution rechecks each frame, verifies all bindings after raw preparation, then
checks source/cache bindings again after native completion before committing a
VMAF score. Source/version identity is a stat witness, not content authentication.

MP4 on either side uses library result v2, native result v2 and sequence
association v2. Every MP4 presentation point carries the fixed track/timebase,
table digest and full original sample witness; the selected point must exactly
match the accompanying source-plane provenance. Mixed pairs retain FLV clocks
on the FLV side. All-FLV input normalization, result/association v1 and existing
idempotent receipts keep their original fields. Shared evidence and the original
viewer validate the same versions; viewing does not read another actor's private
job, build an index or score pixels again. Historical imports cannot grant trust.

The existing executor owns admission throughout index loading, all repeated
closed-window inputs/outputs/drain, raw temporary files, native execution and
final source/cache verification. Index reads include the final verification;
source byte accounting is the sum of actual container reads, including MP4
metadata and payloads without invented FLV overhead. The runner/supervisor,
official component and two fixed v0 models are unchanged. Future CAMBI does not
inherit MP4 admission. Negative-source-PTS/VFR E2E and reference integrity are
not certified; this is not a performance acceptance.

## HTTP and GUI

The admin quality page's committed-C-plan button copies only the plan identity
into the native VMAF form. The user chooses model, cadence, budgets and optional
SSIM. First version requires the joint PSNR + VMAF recipe; standalone VMAF or
arbitrary joint metric sets are not claimed. This preserves independently useful
companion facts and existing original-frame evidence without replacing B ranges.

`GET /api/quality/vmaf/capability` reports deployment and its last checked timestamp. While shared admission is busy it labels verification deferred and retains the last checked deployment fact, rather than presenting queue contention as feature removal. Every execution still verifies the component again. Mutations require
same-origin `X-VoidPlayer-Action: quality-job`, identity cookie and a matching
captured `X-VoidPlayer-Actor` when provided. A mismatch rejects before side effects.
Example body for `POST /api/quality/vmaf/preflight` or `/jobs`:

```json
{
  "schema":"voidplayer-native-vmaf-job", "version":1,
  "client":{"id":"native-agent","kind":"agent"},
  "plan":{"id":"COMMITTED_C_ID","attemptId":"COMMITTED_ATTEMPT","digest":"COMMITTED_SHA256"},
  "model":"vmaf_v0_6_1", "cadenceUs":250000,
  "metrics":{"psnr":true,"ssim":true},
  "budget":{"maxRawBytes":134217728,"maxElapsedMs":120000,"nativeCpuSeconds":30,"nativeMemoryBytes":536870912}
}
```

Replace placeholders with actual fixed plan facts. Submit also requires
`Idempotency-Key`; replay checks the original receipt before source/plan lookup.
A dropped response must use exactly the frozen body/key. GUI persists unknown
outcomes, disables editing and can restore/retry after reload. Definite 4xx
nonacceptance restores editing; network/5xx uncertainty never becomes a fresh key
silently. Actor/view epochs fence late responses and separate local receipts.

| Method/path under `/api/quality/vmaf` | Meaning |
| --- | --- |
| `GET /jobs?after=ROW&limit=8` | Bounded owned history |
| `GET /jobs/{id}` | Durable attempt, phase, prepared frame count, independent metric states |
| `GET /jobs/{id}/result` | Immutable bounded summary, raw hashes, native recipe/scores/pool/resources |
| `GET /jobs/{id}/frames?after=INDEX&limit=4` | Presentation-ordered PSNR/SSIM facts and score/reference |
| `POST /jobs/{id}/cancel {}` | Request real stop, then terminal state only after physical exit |
| `POST /jobs/{id}/candidates` | Freeze explicit full-frame temporal-score policy and publish candidates |
| `GET /jobs/{id}/candidates` | Original frozen policy, selected indices/IDs and publication progress |

Candidate body: `{space,side,maxScore,limit,minFrameDistance,text,severity}`.
Select lowest score first, stable presentation-index ties; max 8 candidates,
explicit frame spacing/text/severity. IDs and annotation operation IDs freeze
before mutation; annotation/evidence/receipt/event commit atomically per candidate.
A batch exposes partial publication progress rather than pretending the whole
batch is one cross-database transaction. Retrying the frozen policy replays
receipts, including after its private result has been reclaimed. Changing the
policy conflicts.

`create-quality-candidate` / `attach-quality-result` are existing shared commands,
with private per-frame references `vmaf-UUID-fINDEX`. The VMAF resolver checks
ownership before private result lookup. The attachment adds `sequenceVmaf` with
model/binary/supervisor/manifest/source hashes, recipe, raw sequence hashes,
C plan/digest, all selected AU/PTS/window identities, cadence, selected score and
pool. Publishing explicitly shares those temporal source facts. Ordinary edits
preserve them, forged replacements reject, imports/copies remain historical.
Other viewers consume the attachment, never fetch an owner's private job. The
original pair viewer still verifies raw picture/ROI identity; it neither reruns
VMAF nor verifies the complete temporal score from a single displayed pair.
No VMAF heatmap, localized defect box or subjective assessment is fabricated.

Closing a page/observer does not cancel a job. Polling errors do not rewrite its
state as failed; prepared-frame count is not a made-up native progress percentage.
A completed PSNR/SSIM preparation survives native failure, cancellation or restart.
Only a separately completed native result carries a VMAF association. Restart
marks unfinished work interrupted and never automatically retries or recomputes.

## Ownership and budgets

One existing shared instance admission covers component verification, raw Worker,
native supervisor/CLI, final source verification and cleanup; no outer coordinator
holds a slot while waiting for another admitted quality job. Workers are terminated
and source IO/DB/file lifetimes drain before release. Cancellation does not simply
reject a Promise and leave an executable or late Worker alive.

Hard native CPU/address-space/file/core limits are set in the Linux supervisor.
The service durably records supervisor PID/start ticks/boot ID before its stdin
start gate allows `fork`/`exec`. Supervisor/native parent-death signals, process
ownership checks and bounded TERM→KILL escalation cover crashes and restart.
Zombie processes have already physically exited and own no live descriptors;
PID reuse never authorizes killing an unrelated process. Uncertain exit poisons
admission and retains temporary evidence for recovery instead of freeing capacity.

Maximums: 32 frames, raw temporary files **128 MiB combined**, 120 seconds whole
execution deadline, native CPU 60 seconds, native address space 512 MiB, one
thread, stdout/stderr 64 KiB each, result file/JSON 4 MiB. WASM Worker heap is
bounded separately (256 MiB); it does not retain every decoded frame's pixels.
Existing per-pair and C total source/input/packet/output budgets include all
repeated pre/post-target/drain work. Raw decode also respects the smaller C total
time budget; final verification IO is separately recorded and charged against the
cumulative 64 MiB/1M index bounds. No full-source hash pass is hidden in scoring.

The deadline requests cancellation; terminal settlement still waits for actual
physical stop/file cleanup. OS-stalled filesystem IO cannot be promised to finish
at an exact millisecond, and no permit is released while it remains owned.
Private raw files are removed after exit, or at recovery after old ownership is
stopped. These limits concern this executor's files and processes; they are not an
OS disk quota or an adversarial same-host sandbox.

Queue: 4 total, 2 per actor, 60-second queue wait. Persistent history is explicitly
bounded (16 rows and 64 MiB logical reservation, 8 MiB reserved per accepted job),
with receipts retained; fullness rejects new work instead of deleting receipts or
automatically rerunning an old key. SQLite DB/WAL physical bytes are not advertised
as an OS disk quota. No computation sharing, auto retry, remote worker or resume.

## Verification and limits of evidence

Registered source/unit, Linux native Node/Bun, real Chromium/WebKit 8/10-bit and
compiled release tests retain original gates; no workflow/branch protection is
changed. The explicit test prerequisite `scripts/native/run-vmaf-tests.mjs` builds
the fixed public component only when absent, verifies existing components and
fails on corruption. It is test installation, not runtime fallback.

- The explicit generation tool `scripts/native/make-vmaf-samples.mjs` uses FFmpeg to independently decode this package’s synthetic B-frame FLV clips into raw YUV. Encoded inputs, compressed raw planes, exact hashes and generator/FFmpeg recipe are committed in `test/helpers/native-vmaf-samples.json`; native and compiled test jobs need no runtime FFmpeg. Every
  raw hash, official frame score and official pool matches a direct fixed CLI
  invocation with the same full clip/model/recipe. H.264 and HEVC at both 8 and 10 bits, same, distorted, NEG,
  nonzero source clocks and temporal flush are represented.
- Missing component, altered model/binary/supervisor/manifest, wrong cadence,
  stride/holes/duplicate/negative/VFR clocks, raw budget, actual untagged source,
  source mutation before/after preparation reject; unit injection and real HTTP
  checks are distinguished by their test files.
- Real supervisor stop/cancel/deadline/crash and SIGKILL service restart preserve
  completed companions, stop physical ownership and retain original receipts.
  Shared admission/queue limits and actual native address-space failure are tested.
- GUI clicks originate native submissions; lost-response reload retries use one
  key/attempt. Explicit shared candidates and another actor's original-frame
  viewer work without private job access. Actor-delayed responses are fenced;
  a separate live player retains its tracks and advances while observed playing.
- Installed compiled Bun uses real bundled Workers and the native component under
  an empty PATH; the independent Node harness uses the committed FFmpeg raw oracle and invokes the fixed official VMAF CLI directly.

MP4 regression entry points (run from the repository root):

| Entry | Evidence |
| --- | --- |
| `node --test test/unit/native-vmaf.test.ts test/media/quality-mp4-index.test.ts` | Exact integer tick conversion, strict table/edit/configuration constraints, duplicate/missing/noncontinuous clocks, frozen source/build substitutions. Clock mutations are algorithm tests, not negative-PTS/VFR end-to-end certification. |
| `node scripts/native/run-vmaf-tests.mjs node --test test/media/native-vmaf-http.test.ts test/media/native-vmaf-lifecycle.test.ts` | Three MP4 codec/depth rows × MP4/MP4 and both mixed directions; official NEG frame/pool and original raw hashes, independent companion SSE, v1/v2 evidence, budgets, actual process exit, final source/cache/table rejection, restart and receipt-first unknown-commit replay after private result reclamation. The same files run under pinned Bun. |
| `node scripts/native/run-vmaf-tests.mjs node scripts/check-mp4-vmaf-browser.mjs chromium h264 8` | Real GUI discovery, probe/index preparation, C plan, VMAF/PSNR/SSIM/grid, lost-response reload replay, closed observer, shared candidates and another actor's original-frame hashes/block selection; independent playback and delayed-actor isolation. Repeat for `hevc 8`, `hevc 10` and `webkit`: six registered cases, each covering all three container combinations. |
| `node scripts/native/run-vmaf-tests.mjs node scripts/check-native-vmaf-release.mjs /absolute/package.tar.gz` | Empty PATH/unrelated cwd compiled Linux x64: nine MP4/mixed cases plus two legacy FLV cases, fixed official CLI oracle, installed native component and shared v1/v2 candidates. |

`scripts/native/make-vmaf-mp4-samples.mjs` explicitly generates the committed
MP4 fixtures from the existing fixed synthetic FLV clips. Generation compares
every compressed AU and exact DTS/PTS, then independently decodes MP4 with
FFmpeg and compares all raw bytes. Runtime tests consume these fixed fixtures;
equal remuxed bytes/scores do not certify a user-declared content relation.
Real same-size source replacement tests also change the file-version witness;
they do not independently isolate a restored stat witness from table validation.

A local **128×96, 8-frame** compiled sample measured native CPU 17.393/20.314 ms,
native wall 20.588/22.533 ms and peak native RSS 3,477,504/3,801,088 bytes for 8/10
bit respectively. Raw bytes are 294,912/589,824; full preparation/output work, total execution wall time and small-clip frames/second are
reported separately by the registered HTTP and compiled harnesses. These small-clip values are inspectable regression evidence,
not a throughput or real-time acceptance claim. Existing informational performance
16/16 failures remain negative; #112/#114/#121/#122 are not declared wholly done.
No VFR/negative-PTS certification, reference-integrity certification or concealment
detection, containers beyond this strict MP4/FLV matrix, HDR, arbitrary ROI VMAF, GPU, CAMBI or
distributed computation is included.
