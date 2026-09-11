# Runtime failures and local diagnostic retention

A loaded track may become unusable after a background index, decode, or playback
presentation failure. ReviewSession owns that runtime state for both UI and Agent:

- Capture local diagnostics before releasing the reader, then set the track's
  failure message and session position. Dispose its source once.
- Keep the last visible image with an explicit stopped-image overlay. It is not
  evidence that the failed track is synchronized. Expose failure in getState().
- Exclude failed tracks from clock coverage, active duration, seek, frame-step
  planning and new annotation comparison anchors. Other tracks continue.
- Failed tracks require reload/replacement; play does not repeatedly retry a
  poisoned decoder. Replacing a source creates fresh runtime state.
- If all tracks fail, stop with an explicit session error. Cancellation is not a
  track failure. New-source replacement and workspace-restore transactions keep
  their existing atomic commit behavior, preserving the old session on failure.
- A 15-second stalled playback coverage check isolates the blocking producers;
  it does not automatically condemn other tracks waiting on the same clock.

FLV recovery follows message semantics, not filename or timestamp heuristics.
A well-formed SequenceEnd control packet does not select a codec, add a frame, or
extend duration, even when a legacy muxer ends HEVC with an AVC marker. Actual
coded/configuration codec switches remain unsupported and reported. Incomplete
terminal tags retain the existing validated-prefix recovery; arbitrary interior
corruption is not silently accepted. Without the original source, this does not
claim every unusual timestamp is valid or that every damaged tail is recoverable.

## Browser logs

There is no application-level gzip compression or daily file rotation. The
current session keeps the latest 2,000 events, dropping the oldest and counting
those drops. Event payload strings, depth and collection lengths are truncated;
video bytes and annotation bodies are omitted. Old diagnostics can therefore be
lost during long sessions; capture an important report soon after the incident.

IndexedDB stores at most three session documents. Saving overwrites the current
session by ID and prunes older sessions; historical sessions older than seven
days by updatedAt are excluded. Merely leaving a page open does not create an
unbounded number of archives. Persistence is batched with a 250 ms timer. One
writer saves at a time and coalesces intervening updates to the latest bounded
snapshot, so stalled storage does not create an unbounded Promise queue.

These are logical application bounds, not an exact process-RAM or database-file
byte quota. Object overhead, export snapshots, browser storage implementation,
and the media decoder's buffers are separate. Storage errors remain visible and
do not stop playback. The current log record may remain active for over seven
days; the event-count limit still applies.

Uploading is explicit. Uploaded reports are server files with separate lifetime:
the backend currently offers management/deletion but no automatic age/size
rotation for them. Long browser uptime alone does not upload any reports.

## Bounded log preview and history reads

The settings panel previews 25 events per page, with per-event truncation and a
24,000-character page limit. It initially shows the latest page. Editing the
problem description does not serialize or replace the preview. Copy, download
and explicit upload serialize the full retained report, not the preview; a
clipboard failure offers download instead of selecting an incomplete preview.

IndexedDB schema 2 stores small session summaries alongside report documents.
Opening the history menu reads summaries; selecting history reads only that
report. Retention during saves reads summaries instead of cloning every prior
report body. Existing schema 1 reports are migrated once in the upgrade
transaction. The retention policy itself remains unchanged.

Progressive-index waits are temporary runtime states, not failed tracks; see
[progressive-indexing.md](progressive-indexing.md).
