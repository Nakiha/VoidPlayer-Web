# Bounded range scoring and sampling

`quality.ranges` is a durable coordinator for explicitly listed frame pairs from
existing trusted FLV/EnhancedFLV caches. It uses the same source validation,
PSNR, optional SSIM/grid, immutable evidence and physical Worker lifecycle as
single-frame jobs. It does not require a player, presenter or GUI confirmation.

The caller declares the content relationship. A table joins exact reference AU
identities to exact distorted AU identities; it does not authenticate equivalent
content. `constant-source-pts-offset` additionally checks every listed pair's
integer source clock difference against `offsetUs`. Neither mode discovers an
alignment. Source versions, streams, configurations and cache builds stay fixed
across the table, with one-to-one AU mapping.

## Plan and submit

`POST /api/quality/ranges/plan` normalizes and structurally validates this body
without source IO, index preparation or execution. `POST /api/quality/ranges`
accepts the same body with `Idempotency-Key`. Both require the identity cookie,
same-origin JSON and `X-VoidPlayer-Action: quality-job`. Optional captured actor
header mismatch returns 409 before lookup or effects.

```json
{
  "schema": "voidplayer-quality-range",
  "version": 1,
  "client": {"id": "review-agent", "kind": "agent"},
  "interval": {"startAu": 0, "endAu": 15},
  "correspondence": {"mode": "explicit-au-table"},
  "sampling": {"mode": "stride", "every": 4, "offset": 0},
  "pairs": ["replace with complete caller-specified FramePairRequest objects"],
  "budget": {
    "maxReadBytes": 67108864,
    "maxPackets": 4096,
    "maxOutputFrames": 4096,
    "maxInputBytes": 536870912,
    "maxElapsedMs": 120000
  }
}
```

The `pairs` placeholder must be replaced by actual single-frame request objects
documented in [source-library-psnr.md](source-library-psnr.md). Lower each pair's
`budget.maxReadBytes` and `budget.maxInputBytes` so their sum fits the parent
budget. Include explicit `decode` windows for dependent/reordered targets as in
[reordered-frame-quality.md](reordered-frame-quality.md). Table order is
normalized by reference AU. `all` selects every integer position in the inclusive
reference **decode-order AU interval**; `stride` selects positions satisfying
`(au-startAu)%every === offset`. It does not select by presentation time or infer
unlisted mappings. The interval is at most 256 positions, with at most 64
selected positions and at least one mapped selected pair.

The plan exposes selected, unmapped and unsampled positions, exact dependency
packet/output reservations, read and numeric input reservations, separately
listed repeated index document loads, maximum result bytes and fixed live memory
limits. Each selected window pays for **all** inputs and outputs: repeated
pre-roll, post-target pictures and drain. Child packet/output budgets are
tightened to those complete windows. Parent maximums are 64 MiB source reads,
512 MiB numeric input views, 4096 packets/outputs and 120 seconds execution.
Each child retains its 32 AU per side, 30 second deadline, 256 MiB heap, 32 MiB
retained frames and 128 KiB result limits. Up to two 32 MiB index documents per
selected pair are separately reserved (at most 4 GiB of cumulative loads; one
child live). Reservations bound admitted work; they are not process RSS claims.

## Ownership, history and recovery

Submission freezes an actor/client/key/request fingerprint in an independent
`<indexDatabase>.quality-ranges.sqlite` history. Same key and normalized request
returns the original parent, attribution and children; conflicts return 409.
Read-only observers and their disconnects never cancel execution. An explicit
`POST /api/quality/ranges/{id}/cancel` with `{}` requests cancellation.

One parent coordinates one existing persistent child job at a time. It calls the
in-process job service, never single-frame HTTP endpoints. The parent does not
acquire `library.qualityAdmission`; the child runner alone acquires the common
instance slot shared with library preparations, source builds and other quality
work. Cancellation, shutdown or deadline waits for actual source IO drain and
physical Worker exit before terminal commit and permit release. An uncertain
stop leaves the parent cancelling with no end time, keeps ownership/compute
admission and rejects new submissions. It is not a successful cleanup.

The parent queue has at most four unfinished records, with at most two per actor;
queue waiting expires after five minutes when selected for execution. History
retains at most 100 parents and 16 MiB of logical reservations (plan bytes plus
64 KiB parent metadata/publication allowance per row). Child history retains its
own independent limits. Full history never silently deletes old receipts.
Logical reservation is not physical SQLite/WAL disk usage. A process-level
exclusive owner lock precedes startup recovery. Unfinished parents/children become
interrupted, preserving identities and any committed scores. There is no
automatic resume, retry, publication or replacement attempt after restart.

Child completion is committed before the parent's next observation. Startup
therefore reconciles every persisted sample with its child before rebuilding the
interrupted parent's summary: completed scores retain their original attempt and
digest, remain paged results and leave no scored-position hole. Recovery validates
actor/client/request attribution, the original explicit source/cache/ROI request,
child and total budgets, result digest/provenance and numeric/SSIM consistency.
It performs no source IO or decoding. Parent recovery is transactional; inconsistent
stored facts reject startup and roll back parent changes rather than inventing
coverage. A fully scored recovered parent still remains interrupted.

## Coverage, results and numeric aggregation

`GET /api/quality/ranges?after=ROW&limit=10` pages current parent records by
insertion row cursor. It is a history snapshot, not a change event stream.
`GET /{id}` returns the plan, progress, coverage and frozen publication. Progress
links the active child/attempt and its phase. Failed/interrupted work has no
invented actual work counters. Reported completed measurement work covers scored
pairs only; remaining selected positions remain explicit.

`GET /{id}/results?after=AU&limit=4` returns up to four complete immutable child
result envelopes. `after` is an inclusive reference AU; `nextAu` is the next
cursor or null. The output carries coverage and summary. Identity ownership is
checked on every private read. Individual child results also remain inspectable
through their original persistent job URLs.

Coverage distinguishes scored, unmapped, unsampled, unsupported and holes. Holes
are selected positions without a committed score, including failed, interrupted,
cancelled or unexecuted positions. Unsupported entries retain the original reason;
other failures remain in `job.samples`. `completed` means all selected positions
were scored. `coverage.complete` additionally requires `all` and no unmapped
positions. A completed sample plan never implies whole-interval quality.

PSNR sums exact integer SSE and sample counts before computing MSE/dB; it never
averages dB or extrapolates across time. Different implementation, bit depth,
peak, color or ROI domains remain separate. SSIM uses the fixed FFmpeg uniform
8×8/stride-4 variant from [source-plane-ssim.md](source-plane-ssim.md), not Gaussian
SSIM. Pool each plane by its valid window count, then combine Y4:U1:V1; retain
window counts and contributing pair counts.

## Explicit candidate publication and passive GUI

`POST /{id}/candidates` requires a terminal parent and this explicit policy:

```json
{"space":"default","side":"reference","metric":"psnr","maxDb":35,"limit":3,"minAuDistance":4,"text":"Review this measured pair","severity":3}
```

Select finite PSNR at or below the threshold, ascending dB then reference AU for
ties, greedily enforcing minimum reference AU distance, up to eight candidates.
Perfect positive-infinity pairs do not satisfy the finite threshold. Text and
severity are caller choices. Selection, candidate IDs and operation IDs are
persistently frozen **before** the first annotation command. Each command uses
the existing atomic shared candidate operation and its annotation/evidence/receipt/
event transaction. After an unknown commit outcome, repeat the same policy to
replay the original receipts/IDs. Receipt lookup precedes private result lookup,
including after result reclamation. A different frozen policy returns 409.

Candidates are `not-subjectively-assessed`: a metric threshold does not establish
a human defect judgment. There is no automatic publication on completion/restart.
The admin panel passively displays plans, coverage, paged scores and published
candidates. Explicit links open the existing independent read-only original-frame
pair/ROI viewer; selecting a score or opening a viewer does not move, replace or
pause any player track. The viewer validates original source/cache/AU identity
and geometry without scoring or constructing an index.
Switching jobs, identity or observation invalidates in-flight result/publication
responses; the old view is cleared immediately and every asynchronous continuation
rechecks its captured view before changing the display.

Existing source/geometry/color/container admission is unchanged. Pixel identity
remains `referenceIntegrity=not-certified` and `concealmentDetection=unavailable`.
Correctness checks do not certify performance. This B range executor does not compute VMAF/CAMBI; the separate optional [native VMAF executor](native-vmaf.md) consumes continuous committed C plans;
their future sequence contract must specify exact pairs, coverage/holes, fixed
model/recipe, complete input/output/pre-roll budgets and per-metric progress, with
no spatial candidate without actual spatial evidence.

Fresh checks: `test/unit/quality-ranges.test.ts`,
`test/media/quality-ranges-http.test.ts`, the range cases in
`test/media/quality-job-lifecycle.test.ts` and the four Chromium/WebKit 8/10-bit
cases in `scripts/check-quality-ranges-browser.mjs`. All are registered in the
existing required manifest suites; CI gates and workflows are unchanged.
