# Explicit quality recomputation

A submission replay resolves an existing operation. Recomputation is a separate,
explicitly authorized operation creating a new durable job. A new-parameters task
is a third operation. None is an automatic fallback for either of the others.

The first implementation covers owned single PSNR/optional SSIM/grid, bounded
range, native VMAF and native XPSNR jobs in failed, interrupted, cancelled or partial terminal
states. Running/cancelling work and unconfirmed physical exit refuse acceptance.
Completed jobs cannot be recomputed through this API. It never prepares sources,
rebuilds a C plan, changes a model, fills holes, resumes a checkpoint or publishes
candidates. All selected pairs, dependencies, drain and the native sequence run
again from the beginning. Old partial scores are context, not reusable input.

## HTTP and GUI

For each existing job path (`/api/quality/jobs/{id}`, `/api/quality/ranges/{id}`,
`/api/quality/vmaf/jobs/{id}`, `/api/quality/xpsnr/jobs/{id}`):

1. `POST /reexecution-plan` with `{reason}` performs bounded read-only verification.
   It returns eligibility/blocks, the previous reason/partial facts, immutable
   input and executor pins, full cost, chain lineage and a deterministic digest.
   A successful plan does not create a task or reserve future compute admission.
2. Explicitly confirm that exact cost, then `POST /reexecutions` with
   `Idempotency-Key` and `{schema:"voidplayer-quality-reexecution",version:1,
   reason,planDigest,confirm:plan.cost}`. The source/conditions are checked again.
3. Observe the returned new job. `GET /reexecutions` returns the current job,
   predecessor lineage and unique successor. Follow these one-hop links to
   inspect the bounded chain. Observation loss never cancels a durable task.

Both POSTs require the existing cookie identity, captured `X-VoidPlayer-Actor`,
exact service Origin and `X-VoidPlayer-Action: quality-job`. They do not accept
client-provided source proofs, executor paths or replacement inputs. Other actors
receive no private input or lineage. The GUI uses the same API and cost checkbox;
it fences late replies by actor/selected job/view epoch. Closing the panel only
stops observation. Existing submission retry buttons explicitly say they replay
the original submission without recomputing.

Each job still owns at most one physical attempt (`attempt.number=1` for single
jobs). Optional `retryOf` is separate lineage: parent, root, generation (first
successor is 2), reason, confirmation digest and request time. The chain stops at
32 jobs. This does not renumber an old attempt or modify an old job, result,
annotation, evidence ref or publication receipt. New candidates require the
existing explicit policy and cite newly computed results.

## Frozen conditions and costs

New executions retain an owned-Worker witness before decode: exact trusted
source producer/cache build/document/table facts, core JS/WASM/capabilities/
provenance hashes, runtime/version and the recipe. The public server/shared
implementation content digest also pins the producer build. Source deployments
hash only bounded application `.ts` files; standalone builds embed the same
content digest during packaging. Neither process arguments, local paths,
configuration nor credentials are included. Native jobs additionally pin the
fixed manifest, binary, model or XPSNR filter, supervisor, revision and recipe.

A C-derived range must retain its original C execution receipt, plan attempt,
digest and frozen range input. VMAF/XPSNR retains and checks its original C snapshot.
Source stat/version and trusted cache validation remain the existing authority;
this is not a content certificate or an isolated stat-witness certification.
Condition changes block recomputation and require an explicit new intent. Legacy
failed jobs lacking a complete execution witness also block; current assets
cannot prove their historical executor. There is no guessed upgrade/backfill.

Planning uses existing owned Workers and shared quality admission. It holds no
outer permit across durable submit. Original runners continue to release the
single slot only after real IO/Worker/native exit. Shutdown aborts and awaits
read-only validation before closing the original services. Index reads are
bounded at 64 MiB/1,000,000 packets; core assets at 64 MiB, producer source at
8 MiB/1,024 files, scratch at 64 KiB and validation at 30 seconds. The response is
at most 64 KiB and the request 8 KiB. The displayed reservation distinguishes
metadata validation and each execution witness pass from original source reads,
all dependency inputs/outputs, numeric input, raw disk, native memory/CPU and
elapsed budgets. Single execution reads the witness twice (source contract and before core load);
a range repeats those two passes for every selected pair. VMAF/XPSNR reads it three
times: decode source contract, before core load and the final verify Worker.
Read-only reexecution preflight is a separate single witness pass. Stage counts
and per-pass limits are part of the exact confirmed cost. No existing
execution/queue/heap/frame limits are increased.

Single/range/VMAF/XPSNR databases migrate to version 2. Old rows and request/result
fingerprints stay unchanged; older applications refuse this newer database.
Single history reservations include bounded witness/receipt overhead, range
reservations add the same allowance, and native metrics retain their existing reservations.
No receipt is evicted to accept more work when a bounded history is full.

## Unknown response and recovery

The new job and its lineage receipt commit in one transaction in the original
service database. Each original has exactly one successor. Different keys or
bodies conflict, including across windows. An explicitly failed successor may be
recomputed only by naming that successor as the next original.

Before sending, freeze actor, origin, kind, original ID, exact body and key. Empty,
truncated, malformed or over-budget successful responses are unknown outcomes,
not permission to create another computation. Replay the same request/key only.
Receipt lookup precedes revalidation, so an accepted operation can be resolved
later despite changed sources or reclaimed results. Only a definite parsed 4xx
may end a local rejected request; an unknown GUI request is never evicted or
replaced automatically. Browser session storage retains only bounded request
facts, not credentials. Actor changes cannot carry pending writes to a new actor.

After process restart, unfinished original/new jobs become interrupted as usual;
no automatic retry or candidate creation occurs. A crash before the transaction
commit leaves neither successor nor receipt. A crash after commit leaves exactly
one successor and the original receipt, even when its HTTP response never arrived.

The ordinary HTTP example starts from `/llms.txt` and the same operation catalog:
`{mode:"single"|"range"|"vmaf"|"xpsnr",key,identity,reexecution:{jobId,reason}}` defaults to
read-only verification. `--allow-reexecute` additionally requires the original
`actor`, `confirmPlanDigest` and exact `confirmCost`. For uncertain outcomes keep
`reexecution.request` equal to the frozen original body and retain the original
key/actor; `--allow-retry-unknown` permits one exact transport replay, never a new
key. Candidate permission/policy remains independent.

## Verification and remaining boundaries

- `node --test test/unit/quality-reexecution.test.ts`: lineage, exact-cost input,
  client unknown receipts/actor/storage bounds and SQLite atomic rollback/replay.
- `node scripts/native/run-vmaf-tests.mjs node scripts/native/run-xpsnr-tests.mjs node --test test/media/quality-reexecution-http.test.ts`:
  real FLV/MP4/10-bit paths, failures/partial facts, explicit new scores/candidates,
  lost receipt and ordinary HTTP example, frozen-condition negatives, real
  SIGKILL before/after transaction commit and restart without automatic work.
- `node scripts/native/run-vmaf-tests.mjs node scripts/native/run-xpsnr-tests.mjs node scripts/check-quality-reexecution-browser.mjs chromium`
  (also `webkit`): explicit cost confirmation, reload/unknown-key replay, two
  windows, actor/view late-response fences, separate playback and shared viewer.
- Required `release-quality` invokes `check-quality-reexecution-release.mjs`:
  real packaged executable/Worker with empty PATH; single/range/VMAF/XPSNR use
  the packaged cores on the declared release platforms. Platform execution is reported
  from actual PR results, not inferred from registration.

This adds no source/container/model/platform support,
preparation/C-plan rebuilding, distributed retry, selective resume or shared
cross-request computation. Existing negative performance results, negative-PTS/
VFR E2E limits, `referenceIntegrity=not-certified` and
`concealmentDetection=unavailable` remain unchanged.


## Integration with the task center and XPSNR

The task center uses bounded actor-scoped ledger projections, then verifies the
original receipt and lineage before linking predecessor and successor details.
A successor is never counted as a retained range child result. The same GUI
confirmation panel is available in each metric view and in task-center details;
refresh, view closure and actor changes preserve frozen requests without
implicitly computing or cancelling anything.

XPSNR uses the same atomic new-job/receipt protocol with its own optional
`nativeXpsnr` witness: manifest, binary, filter and supervisor SHA-256, fixed
FFmpeg source revision and reference-first temporal recipe. It does not borrow a
VMAF model, substitute PSNR, or change official pooling. Historical XPSNR jobs
without an execution witness require a new explicit intent. Missing components,
changed assets/source/cache/C plan, or uncertain physical exit block recomputation.
Existing result/annotation schemas and legacy submission fingerprints are unchanged.

The integration HTTP suite covers the original four paired kinds, including real SIGKILL before
and after receipt commit, exact same-key replay and task-center links. Each native
successor reads the core/producer witness three times; preflight is a separate
single pass. The GUI suite includes XPSNR recomputation from task-center details,
reopening its filter/target, and the original metric view's chain.

## Single-source CAMBI extension

CAMBI supports the same endpoints under `/api/quality/cambi/jobs/{id}` for **failed/interrupted/cancelled** tasks only; its state machine has no partial state. The source domain remains trusted FLV/Enhanced FLV or the existing strict MP4 subset and fixed analysis WASM pixel API; current input/output/work budgets are defined in [the scoring authority](analysis-wasm-scoring.md). It needs no reference or C plan.

Before raw decode, an owned Worker freezes one exact source/cache/producer proof, bounded core/producer implementation hashes, source geometry, selected AU/configuration/PTS/dependency windows in exact source presentation order, unsampled/unsupported coverage digest and the full fixed CAMBI recipe/component. This contract lives in the job body independently of disposable incomplete results/heatmaps. A cancelled queued job or historical job without it cannot be upgraded. The CAMBI database migrates to v2 atomically with the shared ledger; old bodies/fingerprints remain unchanged, older applications refuse the newer database. Each new job reserves another bounded32KiB for witness/receipt metadata.

Preflight independently re-derives that exact selection and pins current assets under the original shared admission. It uses one separate witness pass and does no decode or scoring. A confirmed execution reads core/producer assets twice in decode and once in final verification; measured bytes/pass counts are recorded. Source index reads across decode and final verification share the original64MiB/1,000,000-packet cumulative budget; raw source reads/dependency packets and aggregate five-scale output/analysis budgets stay separate. Cost reports `selectedPairs:0`, selectedPictures, exact AU/PTS order and selection digest, all original budgets and conservative raw/output reservation. No invented pair, reference/model or score reuse is introduced.

The original service transaction creates the fresh job, frozen expected contract, lineage and unique-successor receipt together. After physical stop, the original actor/body/key replays the receipt before any source/component revalidation, even following drift or result reclamation. Different window keys cannot fork. Closing the GUI/observer never cancels the accepted task; cancelling/running work or uncertain physical exit cannot be reexecuted. Old tasks/annotations/evidence/candidates stay immutable, and new candidates need the existing explicit publication policy. GUI metric and task-center panels consume the same commands and identity fences.

Required targeted tests include `test/media/cambi-reexecution-http.test.ts` on Node/Bun, real owner/transaction SIGKILL recovery, Chromium/WebKit `scripts/check-cambi-reexecution-browser.mjs`, and installed empty-PATH compiled checks in the existing CAMBI release driver. These test exact official frame/pool and five-scale bytes, raw source viewing, drift/legacy rejection, unknown responses, unique successors and real physical release; no private footage or subjective calibration is claimed.
