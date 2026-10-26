# Explicit reference clocks and correspondence plans

The caller declares a reference relationship between two versioned library video
sources. The declaration is private to its actor and immutable at revision 1.
It records intent, not a certificate of equivalent content. Filenames, duration,
similar PTS, playback offsets and loaded tracks are never content evidence.

`POST /api/quality/reference-relations` uses `quality-job`, captured actor,
same-origin JSON and `Idempotency-Key`:

```json
{"schema":"voidplayer-quality-reference-relation","version":1,"client":{"id":"comparison-agent","kind":"agent"},"reference":{"mediaId":"replace-with-24-hex-id","mediaVersion":"replace-with-24-hex-version","stream":"video","configuration":0},"distorted":{"mediaId":"replace-with-24-hex-id","mediaVersion":"replace-with-24-hex-version","stream":"video","configuration":0},"declaration":"Caller supplied comparison relationship","clock":{"mode":"piecewise-exact-source-pts-offset","segments":[{"id":"cut-1","referenceStartUs":0,"referenceEndUs":1000000,"offsetUs":20000}]}}
```

All clocks are safe integer microseconds. The exact direction is
`distortedPtsUs = referencePtsUs + offsetUs`. Segments are half-open `[start,end)`;
there are at most 32, with unique IDs and no overlap in either clock domain.
Overlaps name the conflicting segment IDs; endpoints and transformed endpoints
must remain exact safe integers. Gaps are allowed. A revised declaration is a
new immutable relation, so an existing plan can never silently change meaning.

## Persistent bounded planning

`POST /api/quality/correspondence-plans` uses the same action and idempotency
header, with this contract (replace identities/builds with actual returned facts):

```json
{"schema":"voidplayer-quality-correspondence-plan","version":1,"client":{"id":"comparison-agent","kind":"agent"},"relation":{"id":"relation-uuid","revision":1},"referenceBuildId":"existing-reference-cache-build","distortedBuildId":"existing-distorted-cache-build","interval":{"startAu":0,"endAu":15},"sampling":{"mode":"stride","every":4,"offset":0},"recipe":{"roi":{"x":0,"y":0,"width":32,"height":32},"budget":{"maxReadBytes":65536,"maxInputBytes":65536}},"budget":{"maxReadBytes":67108864,"maxPackets":4096,"maxOutputFrames":4096,"maxInputBytes":536870912,"maxElapsedMs":120000},"planningBudget":{"maxIndexBytes":67108864,"maxIndexPackets":500000,"maxElapsedMs":30000}}
```

The service persists the complete request and relation snapshot before starting
work, returning 202. It only reads existing server-produced, complete unrecovered
FLV/EnhancedFLV caches for H.264/HEVC, preserving current geometry admission.
Missing, untrusted or changed caches fail explicitly; planning never scans media,
builds an index, loads a decoder or scores pixels. Source/cache stat and build
checks surround publication. A key replays the original plan and attempt rather
than rerunning it; a changed normalized request returns 409.

Planning has a separate total budget: at most two 32 MiB / 250,000-packet indexes,
64 MiB / 500,000 packets cumulatively and 30 seconds. Repeated loads are charged
again. Index bytes describe loaded document bytes, not process RSS. The shared
runner enforces a 256 MiB Worker heap and a physical stop before releasing the
single compute slot. No coordinator acquires an outer permit. Planning queues
behind preparations and quality work, with four unfinished records, two per actor
and a five-minute admission wait. History allows at most 100 relations and 100
plans under 64 MiB of logical reservations. Each plan reserves 1 MiB for request, relation snapshot, a result capped at 512 KiB, and its eventual submission intent.
Full history rejects new records without deleting old receipts. Logical limits
do not claim to measure SQLite/WAL or whole-process memory.

The reference universe is 1..256 **decode-order AU positions**, with at most 64
selected by `all` or the existing deterministic `stride` rule. Raw cache records
are inspected before eligibility filtering. Each position retains its actual
reference PTS/DTS, packet extent, configuration and key flag, selected status,
chosen segment, signed offset, expected distorted PTS, exact match count and up
to four ambiguous candidate AU IDs. Source-wide admission issues are also retained,
even when a row already has a clock gap or ambiguity. Match count remains complete even when the
candidate ID preview is capped. Reasons distinguish absent reference AU, clock
gap, duplicate reference PTS, absent exact target PTS, duplicate target PTS,
target AU reuse and unsupported source/decode window/ROI geometry. There is no
nearest-frame substitution or priority between overlapping segments.

Cached decode-window admission is shared with existing frame selection. A mapped
row is an exact clock relation with an admissible cached window, not proof of
decoded color, pixels, content or reference-graph integrity; scoring still verifies
the original source tags, output identities, geometry and color. Unsupported rows
and holes are retained even if no executable pair remains. A blocked plan has
frozen explanations and no scoring job.

`GET /api/quality/reference-relations?after=ROW&limit=10` and
`GET /api/quality/correspondence-plans?after=ROW&limit=10` page actor-owned history.
`GET /correspondence-plans/{id}` returns the immutable request/relation, attempt,
state, result digest, counts, completed planning work, range reservation and
execution receipt. `GET /{id}/rows?after=AU&limit=32` uses an inclusive AU cursor
and returns stable frozen facts without reloading caches.
`GET /{id}/range-input` exposes the executable B request, bounded by B's 128 KiB
request limit. No silent trimming is allowed to make a plan fit.

Mapped pairs, including unsampled mappings, preserve B's coverage semantics.
All selected dependency windows pay repeated pre-roll, post-target and drain
inputs/outputs. The plan invokes the existing range planner; an excessive total
budget or serialized request keeps the explanations and blocks execution.
Statically unsupported mappings are absent from B's explicit pair table and remain
explained in C; B's execution coverage describes only its submitted table and
runtime attempts. Sampling never implies complete interval coverage.

## Explicit scoring and recovery

`POST /api/quality/correspondence-plans/{id}/execute` requires
`{"digest":"exact-returned-resultDigest"}`. Before calling B, C durably freezes
the original actor, request attribution, complete range request and stable
`clock-plan:{planId}` client / `execute` key. A crash after B commits but before C
records its range ID is `submission-unconfirmed`, not proof that no job exists.
Explicit retry uses that same durable B key. Once recorded, the receipt is read
before private plan results; no new plan, Worker or candidate is created.

Startup holds an exclusive owner lock and marks unfinished planning interrupted.
It never automatically replans, executes B, resumes interrupted ranges or
publishes candidates. Completed plans retain their original attempt and digest.
Cancellation uses `POST /{id}/cancel` with `{}`; HTTP observation disconnects do
not cancel. Unconfirmed physical exit retains admission/ownership, leaves no end
time and rejects new work. Shutdown closes planning before range and child services.

Candidate publication is the existing separate B command with explicit threshold,
top N, AU spacing, side, text and severity. Frozen IDs and annotation receipts
survive unknown commits and reclaimed private scores. Candidates remain
`not-subjectively-assessed`. Original-frame review uses the existing independent
read-only viewer and never moves or pauses playback. The GUI edits an unsaved
declaration, explicitly pins caches, creates/inspects a plan, submits scoring and
publishes a policy; closing observation has no execution effect. Async reads and
writes capture actor/view generations before updating private display state.

Library discovery/preparation supplies explicit media/version identities and
existing cache readiness; it does not infer reference relationships. The GUI source picker uses discovery cursors and explicit versioned source IDs;
quality bindings still come from the existing quality source endpoint. Parser-local
stream IDs and clocks never become quality identities. Discovery quality-index
preparations, correspondence planning and range children share one instance
admission slot; no parent holds a permit while calling a child. Shutdown stops
correspondence and discovery coordinators before range, single-frame jobs and
the shared runner. This layer does not duplicate preparation or scoring.

`referenceIntegrity=not-certified` and `concealmentDetection=unavailable` remain.
Functional success does not certify performance. No core/fork or CI-gate changes
are required; VMAF/CAMBI and rate/drift/nearest-time alignment are outside this
contract.

Unconfirmed GUI creates retain the original body/key in actor-scoped session
storage. Their forms stay frozen until the original submission is explicitly
retried or local retries are ended. Reopening observation restores retry controls;
ending local retries does not cancel committed service work.

A confirmed terminal plan offers **New identical plan**. This explicit action
submits its original normalized input with a fresh key and creates a new attempt;
it does not alter the old plan or automatically score it. While a plan create has
an unknown outcome, this action is disabled, including after selection changes,
closing observation or reload. **Retry original submission** replays the frozen
body and original key. The normal form also retains its original key for an
unchanged request. HTTP management uses the shared UUID helper that works without
a secure browser context.

## Verification boundary

The formal tests cover exact half-open end ownership with adjacent segments,
raw duplicate PTS ambiguity, missing exact matches, source/cache changes, reordered
H.264/HEVC AU windows, cumulative budgets, physical-stop cancellation and durable
C-to-B/annotation receipt replay after crashes or private result reclamation.
The positive/negative segment fixtures exercise offset signs. They do not
establish end-to-end negative-source-PTS, negative-zero or VFR coverage; those
input matrices have not been independently validated. Target clock-domain
overlap rejection covers conflicting relations; the defensive target-AU-reuse
branch is not separately triggered by these fixtures. Budget tests do not certify
whole-process RSS, performance or every database failure mode.
