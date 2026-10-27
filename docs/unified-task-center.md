# Unified actor task center

The task center is a read model of preparation, correspondence, single-pair,
range and native VMAF records. It does not schedule work or add reexecution.
It uses the current self-declared service actor, not strong authentication.

`GET /api/tasks` accepts one each of mediaId, mediaVersion (requires mediaId),
kind, metric, raw state, createdFrom (inclusive epoch milliseconds), createdTo
(exclusive), limit (1..50) and cursor. Source filtering matches ID and version
on the same side. The query reads all actor-owned metadata within each original
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

Implementation checkpoint: backend/query work in progress; GUI, real workflows
and compiled verification are not yet complete.
