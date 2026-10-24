import { AGENT_TASKS } from '../shared/service/agent.ts';

/** Embedded so standalone deployments also serve the guides without dist/. */
export const AGENT_GUIDE = `# VoidPlayer Web

> Review media using ordinary HTTP. Business writes complete on the server;
> an open player, paused frame or GUI acknowledgement is not required.

Resolve these paths against the origin serving this file. HTTP and HTTPS both
serve the APIs. The remote player requires HTTPS for browser decoding.

- [Start here](/agent.md): workflow and deployment boundaries.
- [Runtime capabilities](/api/agent): implemented, enabled and ready are separate.
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
Existing compact frame-index routes remain compatible. No new probe/build task
is provided here.

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

## Follow operations

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

const quality = `# One-shot source-frame PSNR; durable jobs planned

There is no server quality-job submission API yet. /api/agent advertises
quality.jobs and compute.workers with implemented=false, enabled=false.
quality.frame-pair describes a separate, transport-scoped operation. It needs no
browser, playback cursor, session or GUI acknowledgement. It is not a durable job.

1. Select an ordinary intranet identity (see /agent/annotations.md). Identity is
   not authentication. Use its cookie for the source lookup and execution.
2. Explicitly build an existing FLV cache with GET
   /api/media/{id}/frame-index?v={version}&build=1. Quality never builds an index.
   A pre-existing client-uploaded cache cannot be blessed by a no-op build: clear
   it explicitly through ordinary cache management and then build it separately.
3. GET /api/media/{id}/psnr-source?v={version} returns binding and server parser
   evidence. Missing, untrusted, stale or over-budget caches fail explicitly.
4. POST /api/quality/psnr-pair with JSON, the identity cookie, same-origin Origin,
   and X-VoidPlayer-Action: quality. Body: {pairing:'caller-specified', reference,
   distorted, roi:{x,y,width,height}, budget?}. Each side is its returned binding
   plus picture:{sourceVersion:'id@version',stream:'video',configuration:0,au,
   picture:0,layer:0,field:'frame'} and integer-microsecond sourcePtsUs. Select AU
   and PTS explicitly from the existing source index; equal PTS never pairs sources.

Only complete, unrecovered, single-configuration FLV/Enhanced FLV, progressive
H264/HEVC closed key pictures, and fully tagged 8/10-bit YUV420 are admitted.
ROI uses the unrotated visible source grid and must be chroma-aligned. The response
contains result (exact code-value SSE/MSE/PSNR and decoder build) plus complete
source/cache/producer evidence. Media versions are stat-derived identities, not
cryptographic content authentication. Sources stay inside registered library roots.

One quality Worker excludes concurrent index builds/uploads and bitstream work.
Busy admission returns 503; there is no queue. Disconnect cancels the request.
Cancellation and timeout terminate the actual Worker before capacity is reused.
Responses are not stored: there is no task ID, resume, retry, persisted history,
SSIM/VMAF/CAMBI, distributed worker or scoring GUI. See docs/source-library-psnr.md
in the repository for budgets, error codes, examples and exact trust boundaries.

Roadmap: #114 frame/ROI metrics, #121 durable jobs/concurrency, #115 annotation
evidence, #122 VMAF, #116 CAMBI, and later #123 compute workers. Jobs will use
explicit source versions independently of GUI playback. Worker media access is
planned around LAN HTTP/Range; NAS/cache are optional.
`;

const liveSession = `# Live view commands

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
};
