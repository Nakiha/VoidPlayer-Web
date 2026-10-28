# Unified actor task center

The task center is a read model of preparation, correspondence, single-pair,
range, native VMAF/XPSNR and single-source CAMBI records. The read model does not
schedule work; explicit recomputation controls delegate to the original scoring
services.
It uses the current self-declared service actor, not strong authentication.

`GET /api/tasks` accepts one each of mediaId, mediaVersion (requires mediaId),
kind, metric, raw state, createdFrom (inclusive epoch milliseconds), createdTo
(exclusive), limit (1..50) and cursor. Source filtering matches ID and version
on the same side. Metric filters identify requested scoring metrics or named
preparation/planning operations; they do not assert that a metric completed.
Per-metric outcomes remain independent. The query reads all actor-owned metadata within each original
store's hard history cap, not the first page of each legacy API. SQL projects
metadata without loading full inputs, results, index documents or pixels into JS.

Each first page captures a frozen read set, sorted by descending creation time,
then kind and ID. Subsequent pages retain its membership and facts even when
jobs change. Refresh without cursor to observe changes. Snapshots expire after
60 seconds, survive neither process restart nor bounded cache eviction, and
are limited to two per actor/eight overall and 8 MiB combined metadata. Invalid,
expired, changed-filter or cross-actor cursors return 409 task-cursor-expired;
restart without cursor with the same filters and independently selected target.
No persistent task or result is deleted by snapshot eviction.

`GET /api/tasks/{kind}/{id}` reads current facts and recorded same-actor links.
Raw service state and phase are retained; absent phases and unknown progress
remain absent. A committed result flag describes stored availability, not a
fresh source/pixel verification. Range score counts and retained child results
are separate. Follow original result/viewer routes for normal validation.

`POST /api/tasks/{kind}/{id}/cancel` requires an empty JSON object, captured
actor, same Origin and the original action header (library-preparation for
preparation; quality-job otherwise). It delegates to the original service;
cancelling does not claim physical exit or roll back results. Observation
requests never cancel durable work. No result, candidate or old receipt is
rewritten. Broad #121 resource management and performance remain incomplete.

The admin Task center pane uses the same protocol. It stores only actor-scoped
filters and an explicitly selected kind/ID locally, never a cursor or credential.
Time controls use local time and send exact epoch milliseconds. A refresh or
reopen makes a fresh snapshot, retains the target and never seeks or loads a
player source. Expired pages restart the original query. Actor/view/target
fences apply after each await, including publication and annotation reads;
switching actor clears old private DOM. Only an explicit cancel button writes.
Candidate receipt links use original range/VMAF/XPSNR/CAMBI publication records, and viewer
links require the annotation evidence ref to match the frozen selected ref.
Single-pair annotations retain their original sharing workflow; this package
adds no global reverse annotation search.

Detail follows only same-actor relationships. Native plan pins require matching
attempt/digest, range child links verify the frozen original child input/client/
key/request association, and correspondence-to-range links verify the original
frozen execution receipt and normalized range input. Listing never loads these
full frozen requests; detail performs bounded verification of the selected links.
Retired child results do not erase a range's scored count. Stored availability
is not certification of source contents, current index, pixels or metric scores.

## Reproduce

- `node --test test/unit/task-center.test.ts`: strict query rules, old matching
  records beyond legacy first pages, all seven SQL projections, immutable pages,
  same-side version filters, half-open time, signed/scoped/expired/evicted cursors,
  same-actor pins, result retirement and hard-history overflow.
- `node --test test/media/task-center-http.test.ts`: real mixed MP4/FLV prepare,
  C plan, single/range, snapshot/actor/restart/candidate receipts and real Worker
  cancel with its physical terminate held. No frontend is needed.
- `node scripts/native/run-vmaf-tests.mjs node --test test/media/task-center-vmaf.test.ts`:
  actual fixed native mixed sequence, all five histories and existing candidate
  evidence; not a new algorithm comparison or performance benchmark.
- After the normal build, run `node scripts/native/run-vmaf-tests.mjs node scripts/check-task-center-browser.mjs chromium`
  and the same command with `webkit`. Real HTTP jobs continue while admin is
  closed; explicit GUI cancel, filters/reload, snapshot recovery, late responses,
  actor isolation, independent original-frame viewer and other playback are checked.
- Bun equivalents and the two browsers are registered in the existing manifest.
  Existing compiled release checks also exercise task history/links under empty
  PATH; Linux additionally checks native plan/result associations.

The API reads a bounded complete metadata history, not an event stream or durable
snapshot service. This does not add automatic retry, selective resume, batch
submission/publication, configurable concurrency, new algorithms/components or
strong authentication. It does not depend on unmerged reexecution or CAMBI work.
Reference integrity remains not-certified; concealment detection is unavailable.
Negative-PTS/VFR/stat-witness and historical performance limits remain unchanged.

## Verified candidate evidence

- Node: six unit plus three real HTTP tests passed. Bun: the same nine passed.
  The HTTP cases exercise all five original cancel delegates, wrong action/Origin/
  actor rejection, original results and candidate receipts, and real Worker exit.
- Chromium and WebKit:21 named checks each passed, including deliberately
  ignored abort in two scoped late-response controls, expired snapshot recovery,
  combined filters, actor DOM cleanup, original-frame viewing and continuing A.
- Fast suite75/75, operation/query contracts12/12, build/shared/boundaries and
  manifest490 checks passed. These are author development results, not PR CI.
- Linux x64 empty-PATH compiled checks passed: real discovery/preparation,
  H2648/HEVC8/10 MP4 PSNR/SSIM/grid, and11 official native FLV/MP4/mixed VMAF
  paths. New task-query/result/plan association assertions ran against the
  compiled executable. Windows/macOS compiled task assertions are registered
  in the existing release checks but have not been executed locally.
- An intermediate WebKit author run reached all feature assertions but recorded
  a page access-control error while the test globally bypassed abort for task
  detail fetches. The test now scopes this bypass to the two explicit negative
  controls and drains their real response bodies before ending each control;
  both browsers21/21 passed with the zero-page-error assertion unchanged.
  This does not establish a cause for any older browser/CI failure.

Normal independent review and final PR checks remain required. No new playback
performance measurements were made, and historical negative results remain.

The first PR check attempt stopped before the media/browser/compiled matrices:
the new queued-native test's cross-callback variable required an explicit scope
under the strict whole-project TypeScript checks, and the cache contract still
expected46 cases after the two new browsers were added. The variable is now a
block-local const. The contract still requires all prior46 cases, both exact new
IDs/commands, unique48, unchanged preparation, budgets and fail-closed aggregation.
TypeScript, the two Worker negative-compilation contracts, release/manifest
contracts (75 tests combined), and the real native HTTP case passed after this
test-only correction. No product, workflow, timeout or gate was changed.


Explicit recomputation of stopped failed/interrupted/cancelled/partial scoring
jobs is described in [the shared reexecution contract](explicit-quality-reexecution.md).
Task-center details use the same confirmation/receipt panel as metric views and
show verified original/successor links. This is a new complete computation with
explicit cost confirmation; no automatic retry, partial resume or replacement of
old scores/candidates occurs. Preparation and C plans are not reexecuted here.

CAMBI is projected from its original bounded `cambi_jobs` store using only scalar metadata: one `source` role, metric `cambi`, exact phase/prepared/scored/target facts and committed result availability. Provisional stored scores remain unavailable as immutable results. It has no fabricated reference/C-plan edge. Explicit task-center cancellation delegates to the original CAMBI service; candidate receipt links require the entire frozen ref (including frame, scale and region) to match a server-verified same-origin annotation attachment before opening its independent five-scale viewer. No heatmap bytes are loaded by task queries.

CAMBI delegates to the same explicit confirmation/receipt panel, limited to physically stopped failed/interrupted/cancelled tasks with a persisted single-source contract. Source/cache/producer/core, AU selection/order and native component/recipe must match. Missing historical witness requires new intent; no partial status or automatic preparation/publication is added.