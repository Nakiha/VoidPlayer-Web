import { AGENT_OPERATIONS } from '../shared/service/agent-operations.ts';
import { AGENT_TASKS } from '../shared/service/agent.ts';

/** Embedded so standalone deployments serve guides without frontend assets. */
export const AGENT_GUIDE = `# VoidPlayer Web

> Review media using ordinary HTTP. Business writes complete on the server;
> an open player, paused frame or GUI acknowledgement is not required.

Resolve these paths against the origin serving this file. HTTP and HTTPS both
serve the APIs. The remote player requires HTTPS for browser decoding.

- [Start here](/agent.md): workflow and deployment boundaries.
- [Runtime capabilities](/api/agent): implemented, enabled and ready are separate.
- [Task catalog](/api/agent/tasks): fetch one task, then one operation at a time.
- [Find media, inspect cached metadata and query indexes](${AGENT_TASKS.library})
- [Identity and ABI URI state](${AGENT_TASKS.state})
- [Write annotations and follow operations](${AGENT_TASKS.annotations})
- [Live browser session](${AGENT_TASKS.liveSession})
- [Errors and recovery](${AGENT_TASKS.errors})

Discovery is read-only. It does not create users, trigger scans or schedule jobs.
`;

const introduction = `# HTTP agent entry

1. GET /api/agent. Check implemented, enabled and readiness for the intended task.
2. Read only the relevant task guide linked by that response.
3. Use explicit source IDs/versions, annotation space/ID and expected revision.
4. For writes, explicitly select an identity and retain the cookie. Follow the
   Origin and action-header requirements in [URI state](${AGENT_TASKS.state}).
5. A successful annotation response means the server committed the change.
   Observe operations using the event cursor; GUI consumption is independent.

The player and an HTTP agent are clients of the same annotation rules. Source
selection and window state are separate: background work must not seek, pause,
focus, open a tab or load a track in someone else's player.

This service uses trusted intranet identity declarations, not authentication.
Use the deployment's access policy (for example a reverse proxy) where needed.
Only configured media roots are exposed. Local file bytes are never uploaded by
an annotation write. Explicit Markdown and JSON URLs need no
JavaScript or User-Agent sniffing and work without frontend assets.

Tasks: ${Object.entries(AGENT_TASKS).map(([key, url]) => `[${key}](${url})`).join(' · ')}
`;

const library = `# Library and original media

GET /api/library/browse lists configured mounts and a bounded directory page.

GET /api/library/browse?recursive=1&limit=100&offset=0
Optional query: search (case-insensitive path substring), root (root ID),
directory (relative path), recursive=1, limit (1–200), offset and revision.
The response contains entries, total, nextOffset, revision, ready and scanning.
Entries contain id, name (relative path), root/rootId, size (bytes), lastModified
(Unix milliseconds), version and state. IDs/versions are opaque. Prefer state=ready.
GET /api/library/scan explains scanning and root errors. Do not trigger another scan
just because a listing is incomplete. Continue using nextOffset and the same revision.

Follow nextOffset until null using unchanged filters and the first page's revision.
On 409 discard accumulated pages and restart offset=0 without revision.
Directory pages additionally expose directories and moreDirectories.

GET /api/media/ID?v=VERSION returns validated file properties and up to 16
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
remain read-only; they never implicitly build an index.

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
    curl -fsS "$BASE/api/media/$ID?v=$VERSION"
    curl -fsS "$BASE/api/media/query-schema"
    curl -fsS --get "$BASE/api/media/$ID/index-query" --data-urlencode "v=$VERSION" --data-urlencode "kind=flv" --data-urlencode "stream=video:0" --data-urlencode "schema=3" --data-urlencode "indexer=flv-demux-v3"
    curl -fsS --get "$BASE/api/media/$ID/index-query" --data-urlencode "v=$VERSION" --data-urlencode "kind=ffmpeg" --data-urlencode "stream=video:0" --data-urlencode "schema=3" --data-urlencode "indexer=$BUILD" --data-urlencode "view=records" --data-urlencode "startTick=$START" --data-urlencode "endTick=$END"

GET /api/media/ID/content?v=VERSION&download=1 returns original bytes, not a transcode.
HEAD returns Content-Length, Content-Type, ETag and Accept-Ranges without a body.
Range: bytes=0-1048575 returns 206 plus Content-Range; single/suffix ranges work,
multipart ranges do not. Stream large files. To resume, retain v and validate
206 and the returned starting offset. Never append a full 200 response to a
partial file. A 409 means the file changed: fetch a fresh entry and restart.
Version/ETag is a file-change identifier, not a content checksum.

See [errors](${AGENT_TASKS.errors}).
`;

const state = `# Identity and ABI URI state

GET /api/health does not create an identity. GET /api/users lists named identities.
POST /api/identity accepts {name}, {id}, or {guest:true}; use matching Origin,
Content-Type: application/json and X-VoidPlayer-Action: identity. Keep the cookie.
Identity attributes writes; it is not authentication.

There is no stored workspace CRUD. The page opens self-contained ABI share links:
/?s=VERSION.CODEC.BASE64URL
POST /api/uri/encode with {state} and X-VoidPlayer-Action: uri returns {abi,token,url}.
GET /api/uri/decode?s=TOKEN returns {abi,state}. State contains ordered source
references, integer-microsecond position and offsets, visibility, viewport,
comparison conditions, layout and an optional mark ID. Readable state query
parameters and query overrides are not supported. Editing a scene clears its
old share query once; further actions do not rewrite the address. Links have no
server-side workspace or link mapping. Unknown ABI/codec and invalid or oversized
states are rejected.
`;

const annotations = `# Headless annotations and operation events

GET /api/annotations/media lists media-version targets, never workspaces.
TARGET = "media-" + hex(SHA-256(UTF8(JSON.stringify([namespace, assetId, version])))).
namespace is empty for this service's sources, or the external library's Origin.
Asset and version are the exact 24-hex values in a version-pinned content reference.
GET /api/annotations/media/TARGET?after=0 returns latest records (including
tombstones), cursor and more. Follow cursor while more=true. This is a coalesced
state feed, not operation history. GET /api/annotations/media/TARGET/ID reads one.

POST /api/annotations/media/TARGET with the identity cookie, matching Origin,
X-VoidPlayer-Action: annotation and Content-Type: application/json:

    {"operationId":"unique-request-id","id":"mark-id","revision":0,"action":"put",
     "client":{"kind":"agent","id":"review-bot"},
     "document":{"media":[MEDIA_SNAPSHOT],"mark":{
       "id":"mark-id","mediaId":"snapshot-id","slot":"A","text":"Observed artifact",
       "severity":3,"origin":"agent","createdAt":"2026-10-23T00:00:00Z",
       "frame":{"ptsUs":0,"sourcePtsUs":0,"durationUs":40000},
       "comparison":[],"region":null}}}

MEDIA_SNAPSHOT is a known description, from an independently probed source: id, name, size, lastModified, codec, decoder
(legacy provenance: webcodecs or ffmpeg-wasm), width, height, durationUs, firstPtsUs,
and source:{kind:"library",id:LIBRARY_ID,url:VERSION_PINNED_MEDIA_URL}.
Do not guess these facts. Accepting an annotation does not decode or verify frame
contents.

mark.mediaId references the snapshot ID, not the library ID. Cross-session library
identity is namespace, source.id and URL query v; always pin v. slot is a legacy display hint
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

GET /api/annotations/events/TARGET returns the latest 50 retained operations.
Add ?after=CURSOR to resume in ascending sequence (100 per page). Events include
version, sequence, operationId, requestId when available, actor, declared client,
media-target/id/revision, action, state=committed, occurredAt and target. They commit
atomically with the record and idempotency receipt. This feed covers confirmed
annotation mutations; jobs, rejected requests and workspace changes are not yet
a general activity history.

Store page.cursor after processing the whole page, drain more=true, then poll.
Deduplicate by sequence. Gaps are normal: media targets share a server clock. The latest
10000 operations across targets are retained; slow consumers never block writers.
If resetRequired=true, clear the activity cache, capture that response's cursor,
replace confirmed annotation state by following snapshotUrl and its pages, then
resume events from the captured cursor. Preserve pending drafts and reconcile
them using expected revisions. A cursor ahead of a restored database also requests
resynchronization. Repeated delivery must be applied idempotently.

The player discovers targets from loaded media versions and synchronizes each
independently. Polling never changes playback, focus or tracks. Settings expose
sync status and retained conflicts. Local-only annotations never call the service.
`;

const liveSession = `# Live view commands

The player's WebMCP tools and window.voidPlayer operate on an attached browser
session. Use them for intentional view actions: seek, play, pause, presenting a
frame or selecting browser-local files. Their schemas live in the running page.
An optional temporary stdio bridge is available from a Node 24+ source checkout
with the built frontend: run node scripts/mcp-page-bridge.ts as the MCP client's
child process. Open only the localhost page printed on stderr, choose Files in
that page, click MCP, review the self-declared client (not authenticated), target
workspace and read/view/annotation scopes, and explicitly connect. It cannot
attach to arbitrary existing tabs. For an already-open normal loopback VoidPlayer
page use node scripts/mcp-page-bridge.ts --existing-origin http://127.0.0.1:5180
with the user's exact service origin. Enter the short-lived one-time pairing
information only in that intended page's MCP panel, review its exact workspace
and self-declared client, then individually select read/view/annotation and
explicitly connect. No File is reselected or uploaded. Pairing is single-use
(90 seconds), grants expire in 15 minutes and stdin EOF disconnects only the
bridge, preserving the original page/server and background tasks. No remote
origin, redirects, persistent authorization or automatic tab attachment exists.
Ordinary service pages do not expose a
network MCP endpoint or enable the bridge automatically. No persistent token,
account, extension, startup service or MCP application configuration is installed.

MCP tools/list describes seven bounded operations: get_bridge_status,
get_bridge_receipt and the five allowed page operations get_review_session,
get_review_marks, pause_review, seek_review and add_review_mark. Pass the exact
granted epoch to each page call, and a stable operationId to every mutation.
Schemas reuse the page Agent validator; File paths, scripts, logs, source loads,
uploads and background job tools are not forwarded. Result/message/queue and
15-second command budgets are explicit in /api/agent localMcp.limits.

The current 2026-07-28 per-request MCP metadata and server/discover lifecycle and
legacy 2025-11-25 initialize then notifications/initialized are supported.
stdout contains only newline JSON-RPC; diagnostics go to stderr. Close stdin
for shutdown. Missing/disconnected page is host-unavailable with a reconnect
instruction; reconnection always requires a fresh user confirmation. Revoke,
reload, close, source/workspace/actor change or lost page channel invalidates the
epoch. A started write can still complete: retain the original operationId and
correlation, inspect get_bridge_receipt, never infer rollback or automatically
replay an unknown outcome (including under a new key). Confirmed same-key calls
return the receipt without executing again. Receipts last only this process.

Only the launcher-owned localhost host uses transient document/grant bearer
capabilities. Origin, Host, username and epoch are not credentials. Same-origin
code and the local OS account remain trusted; this is not isolation from hostile
local processes. Runtime protocol and page tests are in
docs/local-mcp-page-bridge.md; platform certification is reported separately.

Use ordinary HTTP for library retrieval, persisted annotation writes and events.
A page need not be open. Background work must not invoke a view command merely
to obtain a business precondition. Source pixels in a browser/local file handle
are a separate host capability, not implicitly uploaded data.
`;

const errors = `# Recoverable feedback

Responses include X-Request-Id. Identity and annotation errors add a
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
  [AGENT_TASKS.library]: library, [AGENT_TASKS.state]: state,
  [AGENT_TASKS.annotations]: annotations,
  [AGENT_TASKS.liveSession]: liveSession, [AGENT_TASKS.errors]: errors,
  ...Object.fromEntries(AGENT_OPERATIONS.map(operation => [`/agent/operations/${operation.id}.md`,
    `# ${operation.id}\n\n${operation.method} ${operation.path}\n\n${operation.request.description}\n\n${operation.output}\n`])),
};
