import {AGENT_OPERATIONS,AGENT_WORKFLOWS,agentOperation} from '../shared/service/agent-operations.ts';

/** Embedded, also in standalone packages without frontend assets. */
export const QUALITY_AGENT_DOCUMENTS:Record<string,string>={
 '/agent/quality/tasks.md':`# Manage existing actor-owned tasks

Use [tasks.query](/api/agent/operations/tasks.query), then [tasks.get](/api/agent/operations/tasks.get). GET /api/tasks reads all bounded preparation, correspondence, single, range, VMAF and XPSNR history for the current self-declared actor. This identity is attribution, not strong authentication. No media/index/pixel read or implicit preparation occurs. Filter by exact media ID/version on the same side, kind/metric/raw state, and inclusive createdFrom/exclusive createdTo epoch milliseconds.

Pages freeze membership and summary facts for60 seconds. Keep filters with nextCursor; refresh without cursor for changes.409 task-cursor-expired after restart, expiry, eviction, changed filters or actor means restart without cursor. Preserve an explicitly selected kind/ID separately. Detail always reads current facts and original verified relationships; unknown phase/progress stays unknown. Stored availability is not fresh source verification. Follow original result/candidate/viewer links. Range scored counts remain distinct from retained child results.

Explicit cancel is POST /api/tasks/{kind}/{id}/cancel with {}, same Origin and captured actor. Use library-preparation action for preparation, quality-job otherwise. It delegates to the owning service. Cancelling retains admission until confirmed physical exit. If the receipt is lost, read the same task; repeating cancel does not create computation or roll back completed results. Closing GUI or HTTP observation never cancels a durable job.

This package has no reexecution, automatic retry/publication, new scheduler or global administration. Use the original explicit submission flows for new intent.
`,
 '/agent/quality.md':`# Choose a quality task

Start with [runtime capabilities](/api/agent) and the bounded
[task catalog](/api/agent/tasks). Then fetch only the selected task's operation
descriptions. Their versioned JSON gives method/path, domain limits, host,
side effects, identity/Origin, replay, cursor and next-operation links.

- [Task center](/agent/quality/tasks.md): filter and observe existing tasks across stores, or explicitly cancel.
- [Single pair](/agent/quality/single.md): one explicit frame/ROI, PSNR with optional SSIM/grid.
- [Bounded range](/agent/quality/range.md): all listed or deterministic stride, explicit coverage and holes.
- [Native XPSNR](/agent/quality/xpsnr.md): reference-first temporal sequence with official per-plane pooling and PSNR/optional SSIM.
- [Native VMAF](/agent/quality/vmaf.md): continuous full-frame sequence plus PSNR/optional SSIM; optional installed Linux component.

All quality tasks start with [sources and explicit preparation](/agent/quality/sources.md)
and an [explicit reference relation and clock plan](/agent/quality/correspondence.md).
Finish with [explicit candidates and shared evidence](/agent/quality/candidates.md).
For uncertain responses read [recovery](/agent/quality/recovery.md).
The [complete compatibility reference](/agent/quality/reference.md) retains the
low-level pair and live-session contracts; no browser is needed for these tasks.

The runnable repository example is examples/http-quality.mjs. Its default is
read-only: it prints required next operations without creating users, preparing,
planning, scoring or publishing. Each kind of write requires an explicit flag.
There is no automatic alignment, subjective judgment or candidate publication.
`,
 '/agent/quality/sources.md':`# Discover facts before admitting quality

1. GET /api/library/discovery-schema, then GET /api/library/discovery?includeUnknown=1&limit=16.
   Follow nextCursor with the identical filters/limit. Snapshot changes require
   restarting the first page. Unknown is neither supported nor a negative match.
2. Explicitly select reference and distorted source ID/version. GET each
   /api/media/{id}/discovery?v={version}. File names/duration/nearby clocks do not certify related content.
3. Metadata stream IDs are parser-local facts. Cache stream video/configuration0
   belongs to the current single-video quality contract. An AU is decode order;
   MP4 sample ordinal, raw DTS/CTS/duration ticks and timebase are preserved.
   None of these is a player cursor or a presentation-order frame number.
4. Select an intranet identity only with permission. POST /api/library/preparations
   with {source:{id,version},operation:"probe",client:{id,name}} for metadata,
   or operation:"quality-index" for a trusted scoring cache. Origin must exactly
   match the service and X-VoidPlayer-Action is library-preparation. Freeze a
   separate Idempotency-Key for each source/operation; observe Location privately.
5. GET /api/media/{id}/psnr-source?v={version} validates existing source/cache
   admission; it never prepares. A cache-miss (409) means selection is disabled
   until explicit preparation. GET psnr-frames pages pin buildId and version.
   Candidate AU eligibility still needs execution-time NAL/output validation.

Trusted FLV/Enhanced FLV and strict self-contained non-fragmented MP4 are
supported. MP4: avc1 H2648 or hvc1 HEVC8/10, one video track/description,
progressive 420 BT.709 SDR, square SAR, no crop/rotate, exact integer-us clocks.
fMP4, encryption, external datarefs, config changes, nontrivial edits, open GOP
CRA and ambiguous/nonintegral clocks are unsupported. Never round or repair.
Metadata readability is not scoring readiness. Probe is not index admission.
Native VMAF has additional sequence/component constraints. CAMBI is unavailable.

[Operations](/api/agent/tasks/library) · [Next: relation and plan](/agent/quality/correspondence.md)
`,
 '/agent/quality/correspondence.md':`# Declare, explain and freeze correspondence

POST /api/quality/reference-relations with schema voidplayer-quality-reference-relation,
version1, client:{id,kind:"agent"}, explicit reference/distorted
{mediaId,mediaVersion,stream:"video",configuration:0}, a declaration and
clock:{mode:"piecewise-exact-source-pts-offset",segments:[{id,referenceStartUs,referenceEndUs,offsetUs}]}.
Segments are half-open [start,end), nonoverlapping in both clock domains.
distorted PTS = reference PTS + offset. This is a caller declaration, not content certification.

POST /api/quality/correspondence-plans pins relation:{id,revision}, both cache
build IDs, inclusive reference decode-order interval, all/stride sampling,
recipe:{roi,budget,ssim?,spatial?}, total budget and planningBudget. Use the
published domain limits in [plan.create](/agent/operations/plan.create.md).
Recipe and total budgets include dependency preroll, all outputs and drain;
planningBudget bounds index bytes/packets/time. No decoder runs during planning.

Observe the durable plan, then page rows: exact raw AU facts distinguish mapped,
unmapped, ambiguous, unsupported and unsampled. No nearest frame fills holes.
A completed planning job may be blocked for execution. Check summary.executionBlock.
The frozen range-input contains explicit one-to-one pairs. POST execute with
{digest:plan.resultDigest} binds one stable range receipt across databases.
Repeat that exact digest after unknown submission; do not invent another key.

[Operations](/api/agent/tasks/quality.correspondence) · [Range](/agent/quality/range.md) · [VMAF](/agent/quality/vmaf.md)
`,
 '/agent/quality/single.md':`# Score one explicit frame pair

After [preparation](/agent/quality/sources.md) and a one-position
[C plan](/agent/quality/correspondence.md), GET its range-input. Require exactly
one pair; do not select a nearby AU. POST /api/quality/jobs with
{schema:"voidplayer-psnr-frame-job",version:1,client:{id,kind:"agent"},request:pair}.
The pair includes exact source/cache/AU/clocks, ROI and budget. Optional SSIM
uses the published uniform 8x8 step4 valid-window variant; optional spatial
grid reports native source-pixel blocks. PSNR uses SSE/count, not averaged dB.

The write needs same-origin quality-job action, cookie/captured actor and a
frozen Idempotency-Key. Observe the durable job; completion has attempt.id and
result.digest. GET /result returns immutable measured facts. A failed result
does not mean a subjective defect and does not authorize another attempt.

[Operations](/api/agent/tasks/quality.single) · [Explicit candidate](/agent/quality/candidates.md)
`,
 '/agent/quality/range.md':`# Execute a bounded range

Use [C plan execute](/agent/quality/correspondence.md) for its stable receipt.
Alternatively POST /api/quality/ranges/plan purely validates an explicit pair
table, interval, sampling and budget; it performs no IO. Direct durable submit
uses /api/quality/ranges and a frozen Idempotency-Key.

Observe detail, then /results?after=0&limit=4 using nextAu. AU cursors are inclusive.
Coverage keeps unmapped/unsampled/unsupported/failed holes separate. Completed
selected samples never imply full temporal coverage. The total budget includes
repeated dependency input, every output and drain. PSNR pools SSE/count by
identical pixel domain; SSIM pools valid windows per plane before Y4:U1:V1.
Parent coordination does not hold a second execution permit around children.
Cancel explicitly; capacity remains held until physical exit. Disconnecting
observation never cancels durable work. Restart interrupts rather than reruns.

[Operations](/api/agent/tasks/quality.range) · [Explicit candidates](/agent/quality/candidates.md)
`,
 '/agent/quality/xpsnr.md':`# Native XPSNR: compare explicitly related variants

First read [capability](/api/quality/xpsnr/capability). Missing trusted optional Linux x64 component means unavailable, never PSNR substitution. The fixed LGPL FFmpeg source and full build recipe/source archive are supplied by scripts/native/build-xpsnr.mjs; a trusted host explicitly pins nativeXpsnr {directory,manifestSha256}. HTTP never accepts executable paths.

Use existing discovery and explicit quality-index preparation, then declare reference/distorted relation and freeze the C plan. Only2..32 fully mapped continuous presentation frames with exact constant integer-microsecond cadence, same full-frame limited BT.709 SDR420 geometry and8/10-bit depth. No stride/holes/ROI/crop/rotate/conversion, negative PTS or VFR; strict FLV/EnhancedFLV and nonfragmented MP4 plus either mixed direction. Reference declaration is not content certification. Closed dependency windows and all drain output are charged.

POST /api/quality/xpsnr/preflight, then explicit POST /api/quality/xpsnr/jobs with same-Origin quality-job action, captured actor and a frozen Idempotency-Key. Body: {schema:"voidplayer-native-xpsnr-job",version:1,client:{id,kind},plan:{id,attemptId,digest},recipe:"ffmpeg-xpsnr-reference-first-temporal-v1",cadenceUs:EXACT_CADENCE,metrics:{psnr:true,ssim:false},budget:{maxRawBytes:134217728,maxElapsedMs:120000,nativeCpuSeconds:30,nativeMemoryBytes:536870912}}. Preflight does not decode; execution verifies color/output identity. Closing observation does not cancel.

Read the durable job and /result, /frames?after=0&limit=4. XPSNR gets REFERENCE as first input. It retains temporal state across consecutive frames and resets at this selected clip boundary. Per-plane frame dB and the official filter's sequence Y/U/V pool plus minimum are emitted at4 decimal places. The pool is square-mean-root weighted distortion with the official low-distortion fallback; do not average rounded frame dB or extrapolate beyond the clip. Positive infinity is an explicit {kind:"positive-infinity",db:null}. PSNR/optional SSIM companions remain independent on native failure.

To compare multiple variants, declare each relationship explicitly against the same reference clip. GET /api/quality/xpsnr/compare?ids=ID1,ID2 accepts2..4 completed own jobs only when reference source/version/cache/selected clocks/raw SHA and implementation/recipe match. Caller order is retained. Different targets or parameters are refused, never silently aligned. No perceptual superiority is established by these objective numbers.

Candidates require explicit side/space/maxScore (finite minimum per-plane frame dB threshold)/limit/minFrameDistance/text/severity. Full-frame temporal scores do not localize spatial defects. Frozen IDs/operation receipts are replayed before private result lookup, including after reclamation. Unknown POST outcomes require the exact original actor/client/body/key or policy, never a new key. Restart interrupts owned work without recomputation. Native/Worker physical exit and raw cleanup precede shared admission release.

[Operations](/api/agent/tasks/quality.xpsnr) · [Task center](/agent/quality/tasks.md) · [Shared evidence](/agent/quality/candidates.md)
`,
 '/agent/quality/vmaf.md':`# Continuous native VMAF

Read /api/quality/vmaf/capability. Missing optional components or unsupported
platforms mean unavailable, never CAMBI-ready or permission to substitute a metric.
Sources can be trusted FLV, strict MP4 or mixed in either direction. The fixed
Linux x64 component and two published v0 models are the only supported executor.
Require 2..32 continuous presentation frames, one exact integer-us cadence,
full-frame limited BT.709 SDR YUV420 8/10bit, same geometry, all samples mapped.
No ROI, stride, holes, conversion, negative PTS, VFR or automatic alignment.

POST preflight with schema voidplayer-native-vmaf-job, version1, client,
plan:{id,attemptId,digest}, model, cadenceUs, metrics:{psnr:true,ssim:boolean}, and budget.
It validates the committed C plan and installed components but does not score.
Its IO may cancel on disconnect. POST jobs with the SAME input and a frozen key
explicitly authorizes persistent computation. Observe job then result and frames.
Frames cursor next is presentation order, not AU; summary contains official
per-frame and pooled scores plus companion PSNR/optional SSIM and raw work.
Budgets include index reads, complete dependency decode/drain, raw disk and
final source revalidation. No browser or GUI acknowledgement participates.

[Operations](/api/agent/tasks/quality.vmaf) · [Explicit candidates](/agent/quality/candidates.md)
`,
 '/agent/quality/candidates.md':`# Publish only an explicit measurement candidate

Read the immutable score before deciding to publish. Supply space, side, text,
severity and an explicit threshold/topN/spacing policy for range or VMAF.
POST the job's candidates operation freezes selection, IDs and operation receipts.
After an unknown or partially committed response repeat exactly that policy.
Receipt lookup precedes private result lookup, including after result reclamation.
For a single pair use create-quality-candidate with caller-chosen operationId,
annotation ID, revision0, candidate:{text,severity}, client and immutable
evidence:{jobId,attemptId,digest,side}. Never reuse an ID with changed contents.

GET the shared annotation and /api/annotations/events/{space}?after=0. Follow
cursor while more; resetRequired means fetch snapshotUrl, not replay mutations.
The committed annotation, evidence, receipt and event are authoritative; GUI
consumption is independent. Existing admin/viewer can read the same facts and
original source planes/ROI without scoring, implicit indexing, private-job access
as another actor or seeking/pausing someone else's playback.

Candidates are not-subjectively-assessed at creation. Explicit relations do not
certify content. referenceIntegrity=not-certified; concealmentDetection=unavailable.
Product functional tests do not erase known performance failures. Negative PTS,
VFR E2E and isolated stat-witness certification remain outside current evidence.

[Operations](/api/agent/tasks/evidence) · [Recovery](/agent/quality/recovery.md)
`,
 '/agent/quality/recovery.md':`# Preserve operation identity across uncertainty

Freeze original actor, client, serialized body, source/build pins and key before
POST. A dropped response is unknown, not failure. Replay only the same operation
identity: Idempotency-Key for durable submit, plan digest for C execute, original
policy for candidates, operationId for annotations. Never switch to a new key
to make an uncertain request succeed. Non-idempotent identity creation needs
manual resolution; do not blindly repeat it. An explicit new computation after a
confirmed failed/interrupted/cancelled/partial job is a separate user decision.

For single, range or VMAF, POST the original job's /reexecution-plan with {reason}.
This only verifies the frozen source/cache/C plan/core/model/recipe and returns
old partial facts, blocks and full-from-start cost. Missing historical witnesses
or changed conditions require a new explicit intent; nothing is rebuilt.
Confirm the exact plan.cost, reason and planDigest in a version1
voidplayer-quality-reexecution POST to the original job's /reexecutions, with a
new stable Idempotency-Key for this distinct, explicitly authorized operation.
Freeze it before sending. A lost acknowledgement replays only that exact body,
actor and key, never a new key. GET /reexecutions follows the durable chain.
One successor and its receipt commit atomically; two windows cannot fork it.
Each job has its own attempt.number=1; retryOf.generation starts at 2. To explicitly
recompute a failed successor, name that successor, not the first ancestor.
Every selected pair/dependency/native sequence is recomputed from the beginning;
old results and candidates are immutable, and new results are never published
automatically. Running/cancelling or unconfirmed physical exit refuses new work.
The example accepts reexecution:{jobId,reason}; default is read-only planning.
--allow-reexecute additionally requires an explicit confirmPlanDigest and exact
confirmCost from that plan; --allow-candidate remains a separate permission.

Capture actor from /api/agent and send X-VoidPlayer-Actor with its cookie. Stop
on actor-changed; do not attach an old pending write to a new actor. Source/cache
changes require explicit reselection and a revised plan, never rounding/nearest
matching. An expired read cursor restarts the same query/snapshot, not mutations.
Observation disconnect does not cancel durable jobs. Stop observing if desired;
only explicit cancel asks for physical shutdown. Restart does not recompute.

Unavailable persistence/components are deployment prerequisites, not transient
permission to poll endlessly or substitute metrics. Read the operation's recovery
and next links, and [error reference](/agent/errors.md). The ordinary HTTP example
has bounded requests, pages and observation and never persists credentials.
`,
};

for(const op of AGENT_OPERATIONS){
 const task=AGENT_WORKFLOWS.find(t=>t.id===op.task)!;
 // Static prose has no deployment availability assertion. JSON describes runtime.
 const contract=agentOperation(op.id,[])!;
 QUALITY_AGENT_DOCUMENTS[`/agent/operations/${op.id}.md`]=`# ${op.id} — operation v1

${op.method} ${op.path}

${op.request.description}

Result: ${op.output}

Host: service. Browser required: false. Side effect: ${op.effect}.
${op.identity?'Retain the identity cookie; capture and send X-VoidPlayer-Actor as an expectation fence. It is not authentication.':'No identity cookie is required for this read or identity selection.'}
${contract.write?`Write: exact service Origin, application/json, X-VoidPlayer-Action: ${contract.write.action}. Replay contract: ${op.replay}.`:''}
${op.cursor??'No cursor for this operation.'}

${contract.recovery.unknownPost}
${contract.recovery.actorChanged} ${contract.recovery.sourceChanged}
${contract.recovery.observerDisconnect}

${op.request.limits?'Published domain limits/contract:\n\n```json\n'+JSON.stringify(op.request.limits,null,2)+'\n```':''}

[Runtime operation description](/api/agent/operations/${op.id}) · [Task guide](${task.guide}) · [Recovery](/agent/quality/recovery.md)

Next: ${op.next.map(id=>`[${id}](/agent/operations/${id}.md)`).join(' · ')}
`;
}
