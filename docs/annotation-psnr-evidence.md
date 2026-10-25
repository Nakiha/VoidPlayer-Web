# PSNR facts on an existing shared annotation

This is the bounded #115 connection from a completed single-frame PSNR job to an
existing shared annotation. It does not create marks, score a frame, build an
index, load media, seek or require a paused GUI. Optional [SSIM](source-plane-ssim.md) facts share the same immutable attachment. It does not implement
VMAF, sequences, heatmaps or full task management.

## Explicit sharing command

GUI cards offer **Attach PSNR**: enter an owned completed job ID, choose the
annotation's reference/distorted side, preview the immutable result, then
explicitly share it. The dialog names its original space, annotation revision
and actual source PTS. It publishes both source identities, source planes' ROI,
algorithm/decoder/runtime versions, numerical results and complete provenance.
The **PSNR** button reads the attachment facts without requesting the private job.
The page Agent's `attach_annotation_psnr` and GUI use the same persistent command
adapter. HTTP Agents use the existing annotation endpoint:

```json
{
  "operationId": "stable-attachment-id",
  "id": "existing-annotation-id",
  "revision": 1,
  "action": "attach-quality-result",
  "client": {"kind": "agent"},
  "evidence": {
    "jobId": "completed-job-id",
    "attemptId": "completed-attempt-id",
    "digest": "64-lowercase-hex-sha256-from-job-result-metadata",
    "side": "reference"
  }
}
```

`POST /api/annotations/spaces/SPACE` requires the existing cookie identity,
matching Origin and `X-VoidPlayer-Action: annotation`. Cookie identity remains
trusted intranet attribution, not authentication. The server first checks the
actor-bound idempotency receipt; identical replay returns the original record,
even after subsequent edits, restart or private result retention cleanup. A new
intent checks expected revision and non-deleted state before reading the job.
The job must belong to the current actor, be completed, and have the exact
attempt and result digest. Another actor gets the existing job-not-found 404;
the attachment lookup does not reveal that private job's state or digest.

The selected side must match the primary annotation's library ID, pinned version,
recorded byte size and **actual source PTS**. Its media URL must have the request's
same Origin, the exact `/api/media/ID` path and one pinned version parameter.
Origin checking uses the existing same-Origin write guard; it is not service
authentication or arbitrary-URL/content verification. No remote URL is fetched.
Source identity remains `stat-version-v1` with trusted server producer evidence,
not content authentication. Cross-source correspondence is the original caller's
explicit choice, never inferred from equal timestamps.

If the annotation has an explicit normalized `region`, its boundaries must
exactly equal the measured integer ROI divided by the decoded **unrotated visible
luma width/height**. A null region makes no annotation ROI claim. Drawings, CSS
pixels, viewport rotation, zoom and DPR never infer an ROI. The snapshot retains
both original frame descriptions, source picture keys, index namespaces/builds,
packet checks and producer evidence; no raw pixels are copied.

## Authority, persistence and edits

`mark.qualityEvidence` holds version-1 `voidplayer-annotation-psnr` attachments.
At most four attachments / 128 KiB total fit within the existing annotation
512 KiB limit. The server copies facts from its immutable result, excluding the
private job's submitted actor/client/request/idempotency metadata. The job and
attempt reference and original result-envelope digest remain as historical
references; the digest is not a signature over the exported subset.

Attachment, annotation revision, operation event and idempotency receipt commit
in the same annotation transaction. Failure rolls all of them back. Concurrent
commands cannot overwrite a committed revision. Normal put/delete/restore
operations preserve attachments. Old clients may omit them; explicit changes,
removal or addition to an existing record are rejected. Text, replies, drawings
and region edits cannot rewrite evidence. A later region mismatch is displayed
as historical/inapplicable; it never silently changes the measured ROI.

The explicit attachment shares its bounded facts with all annotation viewers.
Owner-only job/result endpoints stay owner-only. No extra private submission
data is exposed when another actor reads the shared record. Shared facts remain
available after the original result/source/cache disappears. No automatic rerun,
revalidation, retry, media opening or navigation occurs.

The annotation database advances to schema 3, so older services refuse it rather
than silently writing away new fields. Existing records/receipts remain intact.

## Files and copies

Workspace and review exports containing attachments use **version 2**. Current
readers accept v1 and v2; v1 with attachment fields is rejected. Older v1 readers
reject v2 instead of silently losing evidence. Plain/gzip use the same parser.
`annotationWorkspace` creates historical copies. Every external workspace import
and new generic annotation creation downgrades attachment `verification` to
`historical`, even if JSON claimed `server-verified`. Copying facts cannot inherit
the receiving service's verification. The historical source IDs, versions, actual
PTS, ROI, numerical facts and job references remain unchanged. An imported
snapshot stays local until the user explicitly publishes it.

GUI sync retains the original scope/actor/revision while awaiting attachment
responses. Late replies are cached only in their original space; normal sync
protects local drafts and only maps matching currently loaded source versions.
There is no separate offline attachment queue. The open dialog retries the same
operation ID/body after a lost response; a closed dialog's ID is not durable GUI
task state. Agents should persist their operation ID as for other annotation
commands. Conflicts require explicit reconciliation, not automatic revision bumps.

## Acceptance

`test/media/quality-annotation-http.test.ts` exercises real server jobs and raw
8/10-bit H.264/HEVC paths before HTTP attachment, private ownership, exact attempt/
digest, wrong source version/origin/PTS/ROI, edit preservation, count budget,
concurrent revisions, event failure rollback, historical copies and restart/
result-cleanup replay. Node and native Bun are required manifest cases.
The real decoder browser cases are required in the complete CI `ci-cache` suite
with an explicit `core` prerequisite. The separate lightweight identity workflow
has no decoder and runs its existing synthetic Chromium cases.
`scripts/check-quality-annotation-browser.mjs` runs Chromium and WebKit with real
jobs, GUI and Agent commands, two windows, a different playing source, observation
disconnect/reconnect, replies, export/import downgrade and late replies after
track/space replacement. `check-quality-release.mjs` verifies immutable evidence
and replay across restart from the actual three-platform compiled packages.

Annotation activity links and the administration page's “open in player” link
restore the existing annotation through the same deep-link path. This wrapper
selects v1/v2 with `evidenceWorkspaceVersion` without replacing annotation/media
IDs, space, frame or evidence. External import still downgrades evidence; the
shared-space snapshot confirms the service record again. The v1 attachment
rejection remains mandatory.

The browser regression explicitly clicks both links after a real job attachment
from a non-owner window playing another source. It verifies original IDs, pinned
source/version, actual source PTS, immutable ROI/evidence and service-confirmed
verification, no annotation mutation, no implicit private-job lookup, and 404 for
explicit non-owner job/result reads. The original window keeps playing its source.
The previous test covered workspace restore and the evidence dialog but did not
click either deep link. Before the wrapper fix, the new activity-link case fails
with the v2-required toast and no restored track; this failure is retained as the
regression's baseline.

This slice does not complete #115, and it does not change performance gates or
claim a cause/fix for the earlier WebKit reload/sharing failures.

Explicit original-frame pair/ROI viewing and its strict snapshot identity/geometry limits are described in [annotation-psnr-pair-view.md](annotation-psnr-pair-view.md).

Optional bounded source-pixel block measurement and immutable spatial evidence: [PSNR block evidence](psnr-spatial-evidence.md). Scalar requests and existing source/geometry admission remain unchanged.

Optional SSIM companion semantics, coverage, limits and shared evidence: [SSIM](source-plane-ssim.md).
