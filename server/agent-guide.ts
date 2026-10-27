import { AGENT_TASKS } from '../shared/service/agent.ts';
import {QUALITY_AGENT_DOCUMENTS} from './agent-quality-guide.ts';

/** Embedded so standalone deployments also serve the guides without dist/. */
export const AGENT_GUIDE = `# VoidPlayer Web

> Review media using ordinary HTTP. Business writes complete on the server;
> an open player, paused frame or GUI acknowledgement is not required.

Resolve these paths against the origin serving this file. HTTP and HTTPS both
serve the APIs. The remote player requires HTTPS for browser decoding.

- [Start here](/agent.md): workflow and deployment boundaries.
- [Runtime capabilities](/api/agent): implemented, enabled and ready are separate.
- [Task catalog](/api/agent/tasks): fetch one task, then one operation at a time.
- [Find media, inspect cached metadata and query indexes](${AGENT_TASKS.library})
- [Identity and editable workspaces](${AGENT_TASKS.workspaces})
- [Write annotations and follow operations](${AGENT_TASKS.annotations})
- [Quality scoring availability](${AGENT_TASKS.quality})
- [Live browser session](${AGENT_TASKS.liveSession})
- [Errors and recovery](${AGENT_TASKS.errors})

Discovery is read-only. It does not create users, trigger scans or schedule jobs.
`;

const introduction = `# HTTP agent entry

1. GET /api/agent. Check implemented, enabled and readiness for the intended task.
2. Read only the relevant task guide linked by that response.
3. Use explicit source IDs/versions, annotation space/ID and expected revision.
4. For writes, explicitly select an identity and retain the cookie. Follow the
   Origin and action-header requirements in [workspaces](${AGENT_TASKS.workspaces}).
5. A successful annotation response means the server committed the change.
   Observe operations using the event cursor; GUI consumption is independent.

The player and an HTTP agent are clients of the same annotation rules. Source
selection and window state are separate: background work must not seek, pause,
focus, open a tab or load a track in someone else's player.

This service uses trusted intranet identity declarations, not authentication.
Use the deployment's access policy (for example a reverse proxy) where needed.
Only configured media roots are exposed. Local file bytes are never uploaded by
an annotation or workspace write. Explicit Markdown and JSON URLs need no
JavaScript or User-Agent sniffing and work without frontend assets.

Tasks: ${Object.entries(AGENT_TASKS).map(([key, url]) => `[${key}](${url})`).join(' · ')}
`;

const library = `# Library and original media

## Technical discovery and explicit preparation

GET /api/library/discovery-schema describes the version-1 field dictionary,
support matrix and budgets. GET /api/library/discovery?codec=h264&limit=16
queries prepared metadata or existing bounded cache evidence across registered library rows. Unknown sources
remain visible by default (includeUnknown=1), never silently counted as negatives.
Filters also accept min/max Width/Height, bitDepth, colorTransfer and min/max
DurationUs and recordsReady=1. Without technical conditions, registered rows match
regardless of preparation. recordsReady=1 uses only exact cache identities; other
conditions prefer a prepared probe, with bounded cache fallback when absent.
Predicates are AND within one video evidence stream, not joined across streams,
probe/cache views or cache namespaces. Derived parser defaults cannot satisfy
exact conditions. Conflicting or truncated cached evidence remains unknown.
Each page seeks the existing media-ID primary-key index for at most64 candidate
rows plus one lookahead. Root/path/state predicates apply only to this window;
there is no whole-library COUNT, OFFSET walk or path sort. candidates counts all
visited rows, while page/cumulative counts only in-scope eligible rows. total is
null until exhausted=true. Sparse root/path searches may return empty pages with
nextCursor; continue them to establish coverage. Repeat the SAME query and limit with cursor=nextCursor. Coverage page and
cumulative counters are distinct; whole-scope match/unknown totals are available
only after exhausted=true. Any library/probe/cache snapshot change returns409;
restart from the first page. Availability is the recorded library state, not a
live filesystem check or proof of source content. Reads do not open media bytes,
probe, build, migrate packet caches, decode, score, or control a player.

GET /api/media/ID/discovery?v=VERSION separates file properties, prepared fields,
parser-local stream identifiers, metadata coverage and scoring prerequisites.
Known/unknown/not-probed/derived fields include provenance and missing reasons.
Durations are container metadata in integer microseconds, never CFR or decoded
duration. A parser-local stream clock has no established quality AU mapping;
do not turn matching timestamps into a scoring identity. The existing info and
index-query links remain the source of exact cache namespace/stream/build and
bounded raw-clock packet records. Metadata readability does NOT admit scoring:
MP4/QuickTime, Matroska/WebM and bounded TS probes never grant quality trust.
Strict non-fragmented MP4 has a separate explicit quality preparation matrix. FLV probe observes only a64KiB prefix and at most8 tag headers, with initial
audio/video configurations up to4096 bytes. Pure audio is observable; absent or
late video remains unknown instead of searching to EOF. It does not claim
complete stream inventory or packet coverage. Bounded MP4/QuickTime
trak and Matroska/WebM Tracks inventories include initial subtitle/data/unknown
rows. streamInventoryComplete means only initial container declarations; it never
certifies later configuration changes or all packets. Header budget or parser
disagreement leaves the inventory incomplete; TS remains initial and incomplete.

POST /api/library/preparations explicitly submits one service-owned operation:
{"source":{"id":"ID","version":"VERSION"},"operation":"probe","client":{"id":"agent-1","name":"Selection Agent"}}
Use same-origin Origin, Content-Type:application/json, X-VoidPlayer-Action:library-preparation,
the selected identity cookie, X-VoidPlayer-Actor captured before the action and
Idempotency-Key. An actor/cookie mismatch returns409 actor-changed before work.
The persistent database is required; an ephemeral deployment returns503
preparation-storage-unavailable. A replay checks its receipt before source/result
availability and returns the same job; changing its input conflicts. Never choose
a new key just because a response was lost. GET /api/library/preparations lists
the current actor's history; GET /api/library/preparations/JOB returns the immutable
terminal result or current state. POST /api/library/preparations/JOB/cancel with{}
requests explicit cancellation with the same captured actor and action headers.
Observation disconnect does not cancel. Queued/running/cancelling are not terminal;
capacity is retained until active IO/DB handles close and the physical Worker exits.
Cancellation/deadline settlement can extend through IO drain; it never frees a
permit early. No automatic attempt retry. Queued jobs expire after60 seconds;
preparation queue budgets are8 globally/4 per actor, not a combined bound on all
other subsystem queues. Actual execution shares the existing exclusive quality
admission with scoring/index/bitstream work. History is bounded to1000 rows/64MiB;
GET collection limit=1..32 and before=next is newest-first continuation.

probe reads at most4MiB/512 requests/32 streams/30 seconds in a256MiB owned Worker;
it uses existing container/configuration parsers, no ffprobe executable or decoder.
It can inspect bounded initial configuration bytes but never enumerates the whole
packet table. Unsupported, malformed, oversized and late metadata fail explicitly.
operation:quality-index separately uses the trusted container builder's64MiB
source/128MiB read/packet/index and30-second budgets. No other container gains a
quality index. A commit racing cancellation can leave a valid cache; re-read it.
There is no implicit build from discovery or scoring, no automatic full-library
probe, and no percentage invented while execution progress is unknown.

The management GUI's Technical discovery pane consumes these same commands,
facts and stable pages; explicit readiness checking can open the ordinary quality
selector with the exact source ID/version pinned. This does not pair sources,
select an AU approximately, or move any existing player.

GET /api/library/browse?recursive=1&limit=100&offset=0
Optional query: search (case-insensitive path substring), root (root ID),
directory (relative path), recursive=1, limit (1–200), offset and revision.
The response contains entries, total, nextOffset, revision, ready and scanning.
Entries contain id, name (relative path), root/rootId, size (bytes), lastModified
(Unix milliseconds), version and state. IDs/versions are opaque. Prefer state=ready.
GET /api/library/scan explains scanning and root errors. Do not trigger another scan
just because a listing is incomplete. The legacy /api/library is capped at 5000.

Follow nextOffset until null using unchanged filters and the first page's revision.
On 409 discard accumulated pages and restart offset=0 without revision.
Directory pages additionally expose directories and moreDirectories.

GET /api/media/ID/info?v=VERSION returns validated file properties and up to 16
cached stream identities (nextOffset continues the inventory). It never opens
media bytes, probes codecs, migrates legacy caches or builds an index. The
inventory covers cached streams only, not all streams in the source. Technical
fields carry value/status/source/reason; unknown values are null. Do not infer
color, CFR/VFR, duration or decoded frame counts from absent fields.
GET /api/media/query-schema explains schema version 1, fields, units and limits.

Copy kind/streamKey/schemaVersion/indexerBuild from info into these parameters:
GET /api/media/ID/index-query?v=VERSION&kind=KIND&stream=STREAM&schema=SCHEMA&indexer=BUILD
This overview separates not-indexed, unknown, partial and complete; terminal
build completion alone does not prove complete source coverage. Inspect readiness.
FFmpeg schema-3 record caches expose semantic packets. New FLV and JS-TS commits
also expose bounded technical/coverage headers and raw-clock record pages when
packet storage is ready. Older FLV/TS caches require explicit reindexing for records
(packet-storage-unavailable-explicit-reindex-required); reads never migrate them.
Headers describe selected cached packets, not all streams or decoded pictures.
coverage.pts/dts minTick/maxTick are inclusive observed extrema, not continuous
coverage; count/missing are separate for each raw axis. TS derived effectivePtsUs
never fill absent raw PES PTS/DTS. FLV cached ticks are integer microseconds
(native tags use milliseconds); TS raw PES ticks use 1/90000 seconds. No stable
presentation watermark is inferred from a timestamp maximum or terminal state.
initial-codec-configuration geometry is not a guarantee for every picture;
indexedDurationUs is a derived span with an estimated tail, not container duration.
FLV validated uploads cannot prove complete source coverage. Prefix and recovered
gap indexes stay partial. FLV/TS build progress/failure is not persisted before
commit: cache-miss does not prove that no build is running or that one succeeded.
Existing compact frame-index routes remain compatible. Cached info/index-query
remain read-only; the separate explicit preparation jobs above perform new work.

For a ready record adapter, add view=records&axis=pts&startTick=0&endTick=90000&limit=100&byteBudget=65536
for a bounded half-open interval in ORIGINAL stream ticks. 90000 ticks are one
second only when the returned time base is 1/90000. axis=dts is also supported.
Ticks and ordinals are decimal strings; missing timestamps are null. The exclusive
endTick may be 9223372036854775808 to include the largest signed timestamp. Output stays
in stored PTS order for FFmpeg (untimed last), and in source packet order for
FLV/TS. decodeOrdinal is the original packet order. FLV/TS do not unwrap clocks
or verify continuity; overview.recordSemantics states these limits. Packets are not necessarily decoded pictures or access units.
Container key flags do not prove I-pictures or verified random access; QP and
picture type remain null. FLV normalizedPtsUs is only a raw offset from the first
decode-packet PTS, not elapsed time across wrap/discontinuity; TS normalization
is unavailable. Missing DTS stays null even if ffprobe can derive it.
FLV/TS read at most 256 KiB of packet chunks and inspect at most 2048 records per
page; each chunk is at most 64 records/64 KiB. Read budgets may yield empty pages
with a nextCursor. Continue those pages to finish the range summary.

Follow nextCursor using identical source/version/identity/axis/range. An empty
records page may still have a cursor: each page examines at most 2048 records,
returns at most 256 records and respects byteBudget (8192–262144). The summary
covers RETURNED RECORDS ONLY. Sum pages of the same snapshot for a range summary.
exhausted means the snapshot was examined, not that the entire media is indexed.
On 503 media-query-busy retry after Retry-After; at most 8 cache queries may be in flight
from source validation through response completion/disconnect.
On 409 index-snapshot-changed discard accumulated pages and restart without cursor;
build progress, cache replacement and clearing invalidate cursors. These reads
cannot control any GUI or playhead and reject build=1 instead of starting work.

Example (BASE is the service origin; ID/VERSION come from browse):

    curl -fsS "$BASE/api/library/browse?recursive=1&search=clip&limit=20"
    curl -fsS "$BASE/api/media/$ID/info?v=$VERSION"
    curl -fsS "$BASE/api/media/query-schema"
    curl -fsS --get "$BASE/api/media/$ID/index-query" --data-urlencode "v=$VERSION" --data-urlencode "kind=flv" --data-urlencode "stream=video:0" --data-urlencode "schema=3" --data-urlencode "indexer=flv-demux-v3"
    curl -fsS --get "$BASE/api/media/$ID/index-query" --data-urlencode "v=$VERSION" --data-urlencode "kind=ffmpeg" --data-urlencode "stream=video:0" --data-urlencode "schema=3" --data-urlencode "indexer=$BUILD" --data-urlencode "view=records" --data-urlencode "startTick=$START" --data-urlencode "endTick=$END"

GET /api/library/technical-filter?candidate=ID@VERSION&codec=h264&minWidth=1280&recordsReady=1
screens 1–8 explicitly pinned candidates obtained from browse. Repeat candidate
for multiple sources. Conditions are AND within ONE cache identity/stream; codec
tokens compare case-insensitively without aliases. minWidth/maxWidth and
minHeight/maxHeight are inclusive integers 1–16384. At least one condition is
required; v1 only supports recordsReady=1. byteBudget is 8192–262144, default 65536.
The field dictionary is under query-schema. Discovery advertises the v1 endpoint.

Each returned evidence row is match/not-match/unknown for its exact identity.
Source state is match when a returned witness matches, otherwise unknown;
streamInventoryComplete=false means an unseen matching stream cannot be ruled
out. Partial/legacy/unsupported/missing or conflicting evidence is unknown,
never a known negative. Different identities cannot contribute different fields
to one conjunction. FLV/TS sizes describe initial-codec-configuration; FFmpeg
sizes describe cached-stream-metadata, not every picture. recordsReady describes
the existing overview adapter capability only: packet payloads are not read or
rehashed, and all chunks are not certified. Offline candidates remain unknown.

This is a bounded ONE-SHOT query, not a library-wide scan or consistent pagination.
It examines at most 8 identities plus one lookahead per candidate, twice for
snapshot/revalidation. Each projected TEXT allocation is bounded (metadata
32 KiB, semantic header 8 KiB, storage descriptor 4 KiB); no whole document or
packet payload is loaded. Response bytes respect byteBudget. truncated=true
means identities/evidence were omitted; libraryTotal and nextCursor are null.
cursor/offset are rejected. Separate candidate batches are independent observations,
not one snapshot; even an empty/truncated batch says nothing about full-library
matches. Source versions and cache evidence are rechecked; on 409
technical-evidence-changed discard this batch and restart from fresh browse.
Unrelated database writes can conservatively require a restart. snapshot identifies
the returned evidence and is not a reusable cursor. A disconnect cancels Worker
work; the shared 8-query capacity remains occupied until work actually settles.
These reads never probe, scan, index, migrate, decode, schedule jobs or move a
playhead. Duration, bit depth, color and full-stream probing remain future work.

    curl -fsS --get "$BASE/api/library/technical-filter" --data-urlencode "candidate=$ID@$VERSION" --data-urlencode 'codec=h264' --data-urlencode 'minWidth=1280' --data-urlencode 'recordsReady=1' --data-urlencode 'byteBudget=65536'

Unprobed is not a negative technical match. Similar filenames, sizes or durations never prove that
two sources contain the same content or are aligned reference/distorted pairs.
The existing /metadata endpoint still provides its legacy file/thumbnail shape.

GET /api/media/ID?v=VERSION&download=1 returns original bytes, not a transcode.
HEAD returns Content-Length, Content-Type, ETag and Accept-Ranges without a body.
Range: bytes=0-1048575 returns 206 plus Content-Range; single/suffix ranges work,
multipart ranges do not. Stream large files. To resume, retain v and validate
206 and the returned starting offset. Never append a full 200 response to a
partial file. A 409 means the file changed: fetch a fresh entry and restart.
Version/ETag is a file-change identifier, not a content checksum.

See [errors](${AGENT_TASKS.errors}).
`;

const workspaces = `# Identity and editable workspaces

GET /api/health reads actor:null without creating a user. GET /api/users lists
named users. Explicitly POST /api/identity with {"id":"existing-id"},
{"name":"review-bot"}, or {"guest":true}. Retain its Set-Cookie in a cookie jar.
Names and client labels declare attribution; neither is an authentication credential.

All writes require Content-Type: application/json, Origin equal to this service's
scheme + host + port, and X-VoidPlayer-Action. Use identity for identity selection,
workspace for workspaces/shares and annotation for annotation writes. HTTP clients
send these headers directly; opening the GUI is unnecessary. A reverse proxy must
preserve the intended origin policy; do not bypass a 403. X-VoidPlayer-Actor may
additionally pin the cookie's actor ID to detect a switch.

Example (BASE is the origin without a trailing slash):

    curl -c cookies.txt -H "Origin: $BASE" -H 'X-VoidPlayer-Action: identity' -H 'Content-Type: application/json' --data '{"name":"review-bot"}' "$BASE/api/identity"

GET /api/workspaces?all=1 lists visible workspaces. GET /api/workspaces/ID returns
the record, revision, document, space and ETag. The document contains media snapshots
and marks. POST /api/workspaces accepts {name,document}. PUT /api/workspaces/ID
accepts {name,document} with If-Match: "REVISION". On 409 read the latest revision
and reconcile; do not blindly overwrite. Deletion also uses If-Match.

POST /api/workspaces/share accepts {id?,name,document}; supply If-Match for an
existing workspace. It creates or updates a live, editable workspace with a shared
annotation space. POST /api/shares is a compatibility entry accepting a workspace
document and returning path /?workspace=ID. GET /api/shares/LEGACY_ID resolves old
links into editable workspaces. These are not immutable snapshots.
Sharing never uploads local media. Existing reads may migrate legacy workspace
records/seed annotations; capability discovery itself never does this.

Use record.space for [annotations](${AGENT_TASKS.annotations}); do not infer the
space from a filename or a window's slot. For an independent review, POST
/api/annotations/spaces with {"name":"Review run"} creates an explicit space.
`;

const annotations = `# Headless annotations and operation events

GET /api/annotations/spaces lists spaces. GET /api/annotations/spaces/SPACE?after=0
returns latest records (including tombstones), cursor and more. Follow cursor
while more=true. This is a coalesced state feed, not operation history.
GET /api/annotations/spaces/SPACE/ID returns one record.

POST /api/annotations/spaces/SPACE with the identity cookie, matching Origin,
X-VoidPlayer-Action: annotation and Content-Type: application/json:

    {"operationId":"unique-request-id","id":"mark-id","revision":0,"action":"put",
     "client":{"kind":"agent","id":"review-bot"},
     "document":{"media":[MEDIA_SNAPSHOT],"mark":{
       "id":"mark-id","mediaId":"snapshot-id","slot":"A","text":"Observed artifact",
       "severity":3,"origin":"agent","createdAt":"2026-10-23T00:00:00Z",
       "frame":{"ptsUs":0,"sourcePtsUs":0,"durationUs":40000},
       "comparison":[],"region":null}}}

MEDIA_SNAPSHOT is a known description, e.g. document.media from a workspace or
an independently probed source: id, name, size, lastModified, codec, decoder
(legacy provenance: webcodecs or ffmpeg-wasm), width, height, durationUs, firstPtsUs,
and source:{kind:"library",id:LIBRARY_ID,url:VERSION_PINNED_MEDIA_URL}.
Do not guess these facts. This legacy snapshot format will gain a source-first
metadata contract in #120. Accepting an annotation does not decode or verify frame
contents, and an accepted mark is not proof of a computed score.

mark.mediaId references the snapshot ID, not the library ID. Cross-session library
identity is source.id plus URL query v; always pin v. slot is a legacy display hint
A–H, not a requirement to load that track. ptsUs is source-relative time after
subtracting firstPtsUs; sourcePtsUs is the original timestamp and may be negative.
All times are integer microseconds. region is null or {left,top,width,height} in
normalized source-image coordinates. comparison entries reference their own
mediaId, frame and slot. No playhead, paused state or browser is used by this API.

revision=0 creates. To edit, read the current document, change intended fields and
submit its revision. The primary source version/frame anchor is immutable.
action=delete or restore needs the current revision and no document. Restore is
explicit; an old put cannot resurrect a deletion. IDs use 1–200 ASCII letters,
digits, _ or -. Maximum request size: 512 KiB. Client kind is gui, agent or http
(default); optional client ID is attribution only.

Keep identical payload, actor and operationId when retrying a lost response.
The stored receipt returns the original record without another revision/event.
New content or another actor needs a new operationId. On a version conflict, read,
reconcile and create a new operationId. Success means a committed server write;
GUI visibility may lag and is never part of the success condition.

## Atomically create a measurement candidate

POST the same annotation-space endpoint with:
{"operationId":"stable-candidate-operation","id":"new-candidate-id","revision":0,
 "action":"create-quality-candidate","client":{"kind":"agent","id":"my-agent"},
 "candidate":{"text":"Explicit observation, requires human assessment","severity":2},
 "evidence":{"jobId":"JOB","attemptId":"ATTEMPT","digest":"64-lowercase-hex-sha256","side":"reference"}}
Capture X-VoidPlayer-Actor along with the identity cookie. Mismatch returns409
actor-changed BEFORE any mutation. Do not supply a document, pixels or score.
An owned completed result must record annotationContext: complete-FLV-index-derived
origin, duration and target frame duration. Older results without it return409
annotation-context-unavailable, never guess clocks or silently rescore. The server
derives source/version, actual source PTS, normalized frame clock, exact ROI and
immutable evidence; caller explicitly supplies text/severity. qualityCandidate
assessment is not-subjectively-assessed: no metric implies a human defect judgment.
Annotation, evidence, receipt and operation event commit in one transaction. A
lost-response retry uses identical actor, operationId and body; receipt lookup
precedes result resolution, including after result reclamation or restart. Another
actor gets404 for private jobs and cannot use a receipt belonging to the owner.
This is an explicit sharing action, not permission to read other private job data.
Ordinary edits/replies preserve candidate facts/evidence. Import/copy is historical;
workspace/review v3 preserves candidates, v2 preserves plain evidence, v1 rejects
evidence. An old reader must reject a newer wrapper, never silently drop facts.

The player ROI entry uses loaded library MEDIA only. Its ordinary presented token
is not a quality cache identity. Explicitly choose each cached AU, verify the
version/namespace/build/producer and opaque output in an independent bounded
Worker, then draw ROI on those freshly presented snapshots. No automatic full
indexing, PTS guessing, player seek/pause or screenshot scoring. Closing observation
does not cancel durable execution; use explicit job cancel. HTTP Agent needs no
player or GUI and uses exactly this same annotation command.

## Follow operations

Attach a completed PSNR result to an existing annotation with the same endpoint:
{"operationId":"stable-attach-id","id":"annotation-id","revision":1,
 "action":"attach-quality-result","client":{"kind":"agent"},
 "evidence":{"jobId":"JOB","attemptId":"ATTEMPT","digest":"64-lowercase-hex-sha256","side":"reference"}}
Obtain attemptId/digest from your completed /api/quality/jobs/JOB. This explicit
sharing action publishes both source identities, ROI and immutable numerical and
provenance facts to annotation viewers. It excludes private submission/client/
idempotency data. Another actor cannot attach or inspect your private job.
The selected side must match the annotation's primary library source ID/version,
service origin, actual source PTS, and explicit region (if present), in the
unrotated visible grid. No loaded track, pause, frame cursor, scoring, index
building or new annotation is involved. Revision conflicts require reading and
reconciling the annotation. Retry a lost response with the identical operationId
and body: the receipt is checked before resolving a possibly expired result.
mark.qualityEvidence holds at most four immutable attachments / 128 KiB total.
Ordinary text/reply/region edits retain them; changing the region may make old
facts inapplicable. GET annotation returns these explicitly shared facts without
granting access to the original private job. Imports/copies are historical and
cannot confer service verification. Exports with evidence require workspace or
review version 2; old readers reject instead of silently dropping attachments.

GET /api/annotations/events/SPACE returns the latest 50 retained operations.
Add ?after=CURSOR to resume in ascending sequence (100 per page). Events include
version, sequence, operationId, requestId when available, actor, declared client,
space/id/revision, action, state=committed, occurredAt and target. They commit
atomically with the record and idempotency receipt. This feed covers confirmed
annotation mutations; jobs, rejected requests and workspace changes are not yet
a general activity history.

Store page.cursor after processing the whole page, drain more=true, then poll.
Deduplicate by sequence. Gaps are normal: spaces share a server clock. The latest
10000 operations across spaces are retained; slow consumers never block writers.
If resetRequired=true, clear the activity cache, capture that response's cursor,
replace confirmed annotation state by following snapshotUrl and its pages, then
resume events from the captured cursor. Preserve pending drafts and reconcile
them using expected revisions. A cursor ahead of a restored database also requests
resynchronization. Repeated delivery must be applied idempotently.

The player's workspace settings show recent activity even for unloaded media.
Only an explicit open action navigates to a mark; polling never changes playback,
focus or tracks. Local-only review has no server activity stream.
`;

const quality = `# Source-frame PSNR and durable single-frame jobs v1

/api/agent describes quality.frame-pair and quality.jobs. Both support only
explicit single-frame PSNR with optional SSIM/grid from registered library sources with trusted caches.
The qualityJobs object gives the request schema, endpoints, source constraints
and fixed budgets. compute.workers remains unavailable. Neither operation needs
a browser, playback cursor, session or GUI acknowledgement.
Durable jobs require a configured persistent library database; temporary-index
deployments advertise them disabled and reject submission.

1. Select an ordinary intranet identity (see /agent/annotations.md). Identity is
   not authentication. Use its cookie for the source lookup and execution.
Strict MP4 quality sources use kind:mp4, stream:video:0, schema:1,
indexer:mp4-quality-tables-v1 and producer:server-mp4-scan-v1. They require a
self-contained non-fragmented MP4 with exactly one avc1 H2648 or hvc1 HEVC8/10
video description, explicit BT.709 SDR, progressive 420, square SPS SAR and no
crop/rotation. Audio is ignored for scoring but cannot reference external data.
Original track/sample ordinal, timescale, DTS/CTS/duration ticks and moov SHA256
are preserved. Non-integer microseconds are unsupported: do not round, repair
POC or choose a nearby frame. Only exact identity edits are admitted.
Frame-index GET reads this namespace; POST/build=1 cannot prepare or upload it.
Read-only original-pair inspection uses the same existing sealed cache without
building, scoring, private-job access or player control. Library result version2
and complete-mp4-index-derived-v1 annotation clocks identify MP4 or mixed pairs;
FLV-only version1 receipts/fingerprints retain their original fields. Native VMAF
has separate strict MP4/mixed sequence admission below; future CAMBI remains
FLV-only. See /docs/trusted-mp4-quality.md in the source tree.

2. Explicitly prepare a missing supported FLV or strict MP4 cache with POST
   /api/media/{id}/psnr-index, JSON {version}, the identity cookie, same-origin
   Origin, X-VoidPlayer-Actor and X-VoidPlayer-Action: quality-source-build.
   This separate owned Worker is capped at 64 MiB source, 128 MiB actual reads,
   30 seconds execution and 256 MiB heap; qualityJobs.sourceBuild lists all
   packet/index limits. Cancel/disconnect revokes IO and waits for the actual
   file close and physical Worker exit before admission is released. Slow IO
   cleanup can extend response latency beyond the execution deadline. A commit
   racing cancellation can leave a valid cache: explicitly reread it. Ready
   caches are not rebuilt, and untrusted caches are never silently cleared.
   Source reads, inspection and scoring NEVER construct an index.
   A pre-existing client-uploaded cache cannot be blessed by a no-op build: clear
   it explicitly through ordinary cache management and then build it separately.
3. GET /api/media/{id}/psnr-frames?v={version}&afterAu=0&limit=50 reads
   an existing trusted cache in the bounded source Worker. It returns source
   binding/producer, exact visible SPS geometry, original-pair viewer geometry
   support and explicit AU/source-PTS candidates. Paginate with nextAu and the
   original source.binding.indexBuildId as buildId; rebuilds fail explicitly.
   A container key flag is only a candidate: execution still verifies actual
   closed AU, raw color, pixels and identities. This endpoint never decodes,
   rebuilds, pairs sources or substitutes nearest PTS. Empty entries with nextAu
   require another bounded page, not guessed eligibility.
   GET /api/media/{id}/psnr-source?v={version} returns binding and server parser
   evidence. Missing, untrusted, stale or over-budget caches fail explicitly.
4. POST /api/quality/psnr-pair with JSON, the identity cookie, same-origin Origin,
   and X-VoidPlayer-Action: quality. Body: {pairing:'caller-specified', reference,
   distorted, roi:{x,y,width,height}, spatial?:{blockWidth,blockHeight}, ssim?:{variant:'ffmpeg-uniform-8x8-step4-v1'}, budget?}. Each side is its returned binding
   plus picture:{sourceVersion:'id@version',stream:'video',configuration:0,au,
   picture:0,layer:0,field:'frame'} and integer-microsecond sourcePtsUs. Select AU
   and PTS explicitly from the existing source index; equal PTS never pairs sources.

The legacy matrix is complete, unrecovered, single-configuration FLV/Enhanced FLV, progressive
H264/HEVC and fully tagged 8/10-bit YUV420 are admitted. Preserve the returned
candidate decode window. Preferred packet-identity-gop-v1 uses explicit startAu
and endAu (inclusive, at most32 AU/side), a closed IDR start and packet identity
ABI1. All outputs, including delayed/reordered and drain pictures, are attributed
by opaque input token, never PTS matching. Zero CTS does not imply immediate output.
The legacy forward-one-output-per-au-v1 mode remains compatible: strictly increasing
PTS=DTS, one immediate output per AU, no delayed output. Ambiguous, duplicate,
unknown, missing, field or multi-picture identity and changed parameter sets reject.
Exact decoder output does not certify reference-graph integrity. The ABI validates
output identity/error flags but cannot detect all concealment: a missing reference
AU may still produce scored pixels. dependency.guarantee records
referenceIntegrity=not-certified and concealmentDetection=unavailable. Both GUI
and Agent expose the same limitation. No nearest-frame or cross-source alignment.
ROI uses the unrotated visible source grid and must be chroma-aligned. The response
contains result (exact code-value SSE/MSE/PSNR and decoder build) plus complete
source/cache/producer evidence. Media versions are stat-derived identities, not
cryptographic content authentication. Sources stay inside registered library roots.

Optional ssim is an explicit companion to required PSNR, not a standalone job.
Only variant 'ffmpeg-uniform-8x8-step4-v1' is supported: uniform 8x8 native-plane
windows, stride 4, valid windows after truncation to complete 4-pixel strips;
not Gaussian/Wang SSIM. ROI and every actual grid block must be at least 16x16.
The result.ssim records Float64 implementation/version, bit depth/peak, exact
constants, Y/U/V window counts and coverage in visible-source-luma coordinates.
Aggregate is 4:1:1 plane means; negatives are retained. Grid windows restart per
block; do not reconstruct whole-ROI SSIM by averaging blocks. See
https://github.com/Nakiha/VoidPlayer-Web/blob/main/docs/source-plane-ssim.md.
SSIM shares the exact verified frames, Worker deadline, immutable task/annotation
result and original viewer; it never widens source/geometry eligibility. Omitting
ssim preserves legacy requests. Same-key metric changes conflict. Limits are
fixed, exposed in discovery; missing/unsupported variants explicitly fail.

Optional spatial uses even integer blockWidth/blockHeight in the same unrotated
visible source grid. At most 64 disjoint row-major blocks cover the ROI exactly;
edge blocks are clipped, never padded or omitted. Each block has original-source
ROI and Y/U/V plus aggregate SSE, sample count, MSE and PSNR. The aggregate is
still total SSE / total samples, never average dB. spatial.worst lists at most
eight block indices ranked by descending per-sample MSE with row-major ties;
these are numerical errors, not subjective defects or confidence. Unknown fields
and excessive grids are rejected before durable admission. Omitting spatial keeps
the original scalar result. Grids are included in idempotent request identity and
in immutable result/annotation facts, survive restart/export/import, and can be
selected read-only on the existing exact original-frame viewer. Historical copies
stay historical; no new job read, score, seek or annotation write occurs on selection.

One-shot source discovery and scoring each run in one owned, deadline-bound Worker.
The same quality admission excludes concurrent index builds/uploads and bitstream work.
Busy admission returns 503; there is no queue. Disconnect cancels the request.
Cancellation revokes new IO, drains any synchronous descriptor scope, then
terminates the actual Worker before capacity is reused. The deadline rejects
late success; kernel IO/physical termination latency can exceed it without
releasing the still-owned budget.
One-shot responses are not stored. See docs/source-library-psnr.md for budgets,
error codes, examples and exact trust boundaries.

For a durable single-frame PSNR job, reuse the same explicit pair request:

For quality requests, optional X-VoidPlayer-Actor captures the expected cookie
identity. A mismatch returns 409 actor-changed before private reads, idempotency
lookup, task admission or cancellation; the header never replaces the cookie.
Restore the original actor and replay the same client/key/body. Cookie-only
HTTP Agents remain supported.

POST /api/quality/jobs with the identity cookie, same-origin Origin,
Content-Type: application/json, X-VoidPlayer-Action: quality-job, and a bounded
Idempotency-Key. JSON: {schema:'voidplayer-psnr-frame-job',version:1,
client:{id:'review-agent',kind:'agent'},request:{pairing:'caller-specified',
reference,distorted,roi:{x,y,width,height},spatial?:{blockWidth,blockHeight},budget?}}.

202 means the submission transaction committed. A lost response or disconnected
observer does not cancel computation. Replay the same actor/client/key and
normalized request to recover the original job (200, replayed:true); a different
request with that key is 409 idempotency-conflict. Replaying never starts another
attempt or replaces original attribution.

GET /api/quality/jobs/{jobId} for detail and /result for a versioned result.
GET /api/quality/jobs?after=0&limit=50 returns the current actor's bounded change
snapshots. Save cursor after the page, drain more=true, and deduplicate by ID and
revision. cursor-ahead requires a new snapshot from zero. Polling is observation.
POST /api/quality/jobs/{jobId}/cancel with the same write headers and JSON {} to
cancel explicitly. Completed records are unchanged by a later cancellation.

queued -> preparing -> running -> completed/failed; cancellation first records
cancelling and commits cancelled only after physical Worker exit. The service
owns execution and the shared admission, not the HTTP connection. There is one
execution slot, four queued slots, two outstanding jobs per actor, a five-minute
queue deadline, and the same maximum thirty-second Worker deadline. OS IO drain
and physical exit may take longer while capacity remains occupied. Unknown
decoded frame counts stay null; there is no invented percentage.

Jobs retain original actor/client/request ID, source/cache identity, actual
algorithm/decoder/runtime versions, exact SSE/MSE/PSNR and full provenance.
Startup recovery requires an exclusive database owner and marks unfinished jobs
interrupted, without automatic retry or continuation. Same-key replay returns
that history; an explicit new key creates a new computation. History/result
budgets reject overflow, never silently evict an old receipt. See
docs/source-psnr-jobs.md for the protocol and remaining boundaries.

PSNR with explicit optional SSIM/grid and the scoring/task GUI are available.
For a bounded closed GOP with reordering/delayed output, select the explicit
candidate decode:{mode:'packet-identity-gop-v1',startAu,endAu} (inclusive end).
The whole cached GOP, through the next verified closed IDR or source end, must
fit 32 AUs per side. Every AU is sent; all outputs including final drain are
charged. The core returns a single-use opaque input token, never a PTS lookup.
Actual source clocks are cross-checks. The immutable outputIdentity records the
full output order, tokens, original packet tuple/hash, phase and zero reported
error flags. Unknown/duplicate/missing identity or reported decoder errors fail.
Closed-start, progressive/single-picture, source/cache/color and exact viewer
geometry checks remain. Reference integrity is not certified: absence of reported
errors does not prove absence of concealment. See docs/reordered-frame-quality.md.

Optional live-page capture_presented_quality_frame reads the paused successful
WebCodecs FLV presentation, without pixels, IO, pause, seek or scoring. Its
voidplayer-native-presented-input record is UNBOUND, not a PairTarget. Only
actual same-service version-locked library transport qualifies; local-file
lineage does not. The accepted one-picture input clock is matched exactly in
the same decoder epoch, then committed only after the presenter succeeds.
Do not search a cache by PTS or attach a new generation to an old output.
Read source/psnr-frames at input.au (limit 1 + original buildId), then use the
shared bindNativePresentedFrame rule: exact namespace/build, configurationHex
(max 4096 bytes), packet offset/size/clocks/AU and strict visible geometry.
Original native VideoSample resources only; converted YUV/RGBA, WASM, other
containers, ambiguous clocks/pictures, fields, stale epochs, crop, unknown or
non-square SAR and rotation reject. Native codec/profile support varies by
browser; it does not imply hardware decoding. The GUI explicitly locks both
paused captures before independent original-plane ROI inspection and submission.
Scores use the backend source decoder, never native screen-converted pixels.
HTTP Agents can select explicit cached AUs without any browser. See
docs/paused-native-quality.md. Reference integrity remains not-certified and
concealmentDetection=unavailable.

## Explicit bounded ranges and sampling

quality.ranges is a separate durable coordinator. POST /api/quality/ranges/plan
normalizes a voidplayer-quality-range v1 body without source IO or preparation;
POST /api/quality/ranges accepts it with the quality-job action and Idempotency-Key.
The body has client, an inclusive reference decode-order AU interval, explicit
pairs of existing single-frame requests, correspondence, sampling and a total
budget. correspondence is explicit-au-table or constant-source-pts-offset with
integer offsetUs checked against every listed pair. This is a caller-declared
content relationship, not content authentication or automatic time alignment.
Use sampling:{mode:'all'} or {mode:'stride',every,offset}; stride uses
(au-startAu)%every===offset. Missing mappings remain holes. Each side keeps fixed
source version, stream, configuration and cache build, with one-to-one AU mapping.

At most 256 interval positions and 64 selected positions. Sum per-pair read and
numeric-input reservations under the total limits: 64 MiB source reads, 512 MiB
numeric input views, 4096 packets/outputs and 120 s execution. Every dependency
input and output, repeated pre-roll, post-target and drain is charged. Each child
retains its existing 32-AU/side, 30 s, heap/frame/result bounds; index document
loads are separately exposed in the plan. Lower pair budgets to fit the parent.
The parent never acquires an outer shared permit; only the child runner owns the
common physical compute slot. Source preparation remains a separate explicit task.

GET /api/quality/ranges?after=ROW&limit=10 pages current history snapshots, not
change events. GET /{id} gives plan, progress with active child/attempt, coverage
and publication. GET /{id}/results?after=AU&limit=4 returns complete immutable
results with an inclusive AU cursor and nextAu. POST /{id}/cancel takes {}.
Observing or disconnecting never cancels. Uncertain Worker exit keeps cancelling,
no endedAt and occupied admission. Unfinished parents/children become interrupted
on exclusive-owner startup; same keys replay history without retry or resume.
The independent parent history is at most 100 rows / 16 MiB logical reservations;
at most four unfinished parents and two per actor. Five-minute queue expiry is
checked when a parent starts. Completed scored work does not invent failed-work
counts or represent whole-process RSS.

Coverage separates scored, unmapped, unsampled, unsupported and selected holes.
Completed sampling does not mean coverage.complete. PSNR pools SSE/count before
dB, separately for identical pixel domains; it never averages dB. SSIM pools each
plane by valid window counts then Y4:U1:V1, using the existing uniform 8x8 stride4
variant, not Gaussian SSIM. No temporal extrapolation is made.

POST /{id}/candidates explicitly supplies space, side, metric:'psnr', maxDb,
limit (1..8), minAuDistance, text and severity (1..5). Select finite PSNR <= maxDb,
ascending score then reference AU, greedily enforcing AU spacing. Freeze selection
and IDs before original atomic annotation candidate commands. Repeat the exact
policy after an unknown commit outcome: receipt lookup precedes result lookup,
even if private results were reclaimed. Another policy conflicts. These are
not-subjectively-assessed measurement candidates, never automatic human judgments.
The admin range view is passive; explicit original-frame/ROI viewer links do not
control playback, score or build indexes. No geometry/container expansion follows.
See docs/bounded-quality-ranges.md for the full protocol.

quality.correspondence adds immutable actor-owned reference declarations:
POST /api/quality/reference-relations with schema voidplayer-quality-reference-relation,
version 1, client, explicit reference/distorted {mediaId,mediaVersion,stream:"video",configuration:0},
declaration and clock {mode:"piecewise-exact-source-pts-offset",segments:[{id,referenceStartUs,referenceEndUs,offsetUs}]}.
Distorted PTS = reference PTS + offset in integer microseconds. Segments are half-open,
nonoverlapping in both domains. This is a caller declaration, never content certification.
POST /api/quality/correspondence-plans pins relation {id,revision:1}, both cache build IDs,
reference AU interval, all/stride sampling, recipe {roi,spatial?,ssim?,budget}, total range
budget and separate planningBudget {maxIndexBytes,maxIndexPackets,maxElapsedMs}.
Both creates use quality-job and Idempotency-Key. Planning runs in a service-owned,
physically stopped Worker; observing or closing a browser does not cancel it.
GET /api/quality/correspondence-plans/{id} under that prefix returns frozen identities, attempt, counts, work,
budget reservation and submission receipt. GET /api/quality/correspondence-plans/{id}/rows?after=AU&limit=32
uses an inclusive cursor over raw AU facts, including unsampled and unsupported rows.
Ambiguity, absent exact PTS, clock gaps and decode-window limits are explicit; no nearest
frame is substituted. GET /api/quality/correspondence-plans/{id}/range-input exposes the bounded frozen B request.
POST /api/quality/correspondence-plans/{id}/execute with {digest:plan.resultDigest} explicitly submits the original
range using a durable stable key. Its receipt precedes private plan lookup on replay;
unknown commit outcomes must reuse the same plan/digest. Restart interrupts unfinished
planning without automatic recomputation or scoring. Candidate publication remains the
existing separate explicit range policy. See docs/reference-clock-plans.md.

quality.vmaf is a separate optional native sequence executor, not a single-frame range aggregate.
GET /api/quality/vmaf/capability reports the verified deployment and exact source/model/recipe bounds.
Linux x64 only; install the pinned official component using scripts/native/prepare-vmaf.mjs and
pin nativeVmaf {directory,manifestSha256} in the trusted service configuration. HTTP cannot choose
an executable or model path. Missing/invalid components remain component-unavailable.
POST /api/quality/vmaf/preflight accepts the exact job body below but does not decode, so actual
raw color eligibility is still checked at execution. All mutations require quality-job, captured
X-VoidPlayer-Actor and same-origin identity cookie; actor changes reject before any side effects.
POST /api/quality/vmaf/jobs uses Idempotency-Key and a normalized body:
{schema:"voidplayer-native-vmaf-job",version:1,client:{id:"agent",kind:"agent"},
 plan:{id:COMMITTED_C_PLAN_ID,attemptId:COMMITTED_ATTEMPT,digest:COMMITTED_SHA256},
 model:"vmaf_v0_6_1",cadenceUs:EXACT_INTEGER_CFR_MICROSECONDS,metrics:{psnr:true,ssim:false},
 budget:{maxRawBytes:134217728,maxElapsedMs:120000,nativeCpuSeconds:30,nativeMemoryBytes:536870912}}
The existing C plan must contain 2..32 all-sample, hole-free continuous presentation frames,
full-frame limited BT.709 SDR square-pixel uncropped unrotated 8/10-bit YUV420.
Sources may be trusted FLV/Enhanced FLV or strict non-fragmented MP4
(avc1 H2648/hvc1 HEVC8/10), including both mixed directions. MP4 duration ticks
and source DTS/CTS must exactly represent the declared integer microsecond cadence.
Track/sample/description/offset/size and table witnesses stay pinned. Explicit NEG
model vmaf_v0_6_1neg is also available; v0.6.1 is a fixed baseline, not the latest model.
No negative PTS, VFR, arbitrary ROI, conversion, HDR, other containers, MP4 edits,
fragmentation/encryption/external references or open GOP/CRA. Native frame scores
and official pooling use one continuous clip with reset/start and final flush, not per-frame runs.
GET /api/quality/vmaf/jobs?after=ROW&limit=8, /jobs/{id}, /jobs/{id}/result,
/jobs/{id}/frames?after=INDEX&limit=4 and POST /jobs/{id}/cancel {} observe/control the same service.
Closing an observer never cancels. PSNR/SSIM completed facts survive native failure; metric states
are independent. Restart marks unfinished work interrupted, never retries automatically. Native
CPU/address-space/file limits and physical process/Worker exit precede shared admission release.
POST /jobs/{id}/candidates with {space,side,maxScore,limit,minFrameDistance,text,severity} explicitly
freezes a top-N temporal score policy and publishes existing atomic measurement-candidate commands.
Attached sequenceVmaf facts include full immutable model/component/recipe/plan/raw hashes and pool;
MP4 on either side uses library/native result and sequence association version2,
with original sample/ticks/timebase/table witnesses for every MP4 point. All-FLV
version1 records and idempotent receipts retain their original fields. Unknown
server failures return 500 so clients retain and replay the frozen request/key;
full-frame temporal scores are not heatmaps/localized defect certification. Imported facts are
historical. Reference integrity is not certified and concealment detection is unavailable.
See docs/native-vmaf.md for installation, contract, notices and independent reference tests.

There is no automatic alignment, CAMBI executor, shared computation,
automatic index construction, retry/resume or distributed worker.
These capabilities do not mean #114 or #121 is complete.

Roadmap: #114 frame/ROI metrics, #121 durable jobs/concurrency, #115 annotation
evidence, #122 VMAF, #116 CAMBI, and later #123 compute workers. The current
single-instance jobs use explicit source versions independently of GUI playback;
future remote Worker media access is planned around LAN HTTP/Range.
`;

const liveSession = `# Live view commands

Optional capture_presented_quality_frame returns the successful paused native
FLV input as an UNBOUND voidplayer-native-presented-input record. It performs
no IO, pixel readback, pause, seek, index construction or scoring. Join the
actual library transport and exact AU/configuration/packet witness to a trusted
current cache as described in /agent/quality.md before independent ROI work.
Unsupported native profiles, WASM, converted resources and other containers
reject; HTTP Agents retain the independent explicit-AU scoring path.

The player's WebMCP tools and window.voidPlayer operate on an attached browser
session. Use them for intentional view actions: seek, play, pause, presenting a
frame or selecting browser-local files. Their schemas live in the running page.
There is no server HTTP MCP endpoint or local MCP bridge yet (#117).

Use ordinary HTTP for library retrieval, persisted annotation writes and events.
A page need not be open. Background work must not invoke a view command merely
to obtain a business precondition. Source pixels in a browser/local file handle
are a separate host capability, not implicitly uploaded data.
`;

const errors = `# Recoverable feedback

Responses include X-Request-Id. Discovery, identity and annotation errors add a
stable code, requestId and links.help; older APIs may still return only error.
Keep the original diagnostic as well as status and code.

- 400 invalid-annotation-command / invalid-annotation-document / invalid-event-cursor:
  correct input; timestamps and cursors must be safe integers.
- 403 origin-required: check Origin and the documented action header.
- 409 identity-required: explicitly select an identity and keep its cookie.
- 409 actor-changed: re-read /api/health; do not replay under a different actor.
- 409 annotation-revision-conflict: read/reconcile the record; use a new operationId.
- 409 annotation-anchor-conflict: create a different mark for a different source/frame.
- 409 operation-id-reused: retries retain identical input; new work needs a new ID.
- 404 annotation-space-not-found / annotation-not-found: rediscover the target.
- 413 annotation-too-large: reduce the document; do not embed media bytes.
- 503 storage-unavailable: this deployment has no persistent review store.
- 409 on library pagination: restart offset=0 without the old revision.
- 409 on media bytes: refresh the entry and restart with its new version.
- 416 on media: inspect HEAD and Content-Range before retrying.

A timeout after POST may mean it committed. Retry identical operationId/payload,
not a new ID. Event resetRequired is not permission to replay old mutations.
TLS errors require the deployment's trusted certificate setup. Never work around
these errors by clearing caches, changing settings, triggering scans or uploading
logs. Names/client labels remain attribution, not access credentials.
`;

export const AGENT_DOCUMENTS: Readonly<Record<string, string>> = {
  '/llms.txt': AGENT_GUIDE, '/agent.md': introduction,
  [AGENT_TASKS.library]: library, [AGENT_TASKS.workspaces]: workspaces,
  [AGENT_TASKS.annotations]: annotations, [AGENT_TASKS.quality]: quality,
  [AGENT_TASKS.liveSession]: liveSession, [AGENT_TASKS.errors]: errors,
  '/agent/quality/reference.md':quality,
  ...QUALITY_AGENT_DOCUMENTS,
};
