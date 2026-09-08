# Progressive FLV indexing and playback

First presentation, indexed range, scan completion and decoder EOF are separate
states. A source's first decode-order key packet establishes a stable timestamp
origin. Earlier PTS discovered later remain preroll; publishing an index must not
move the session clock. Duration while building is the indexed range, not an
estimate of the full file's duration.

## Producer and consumer

- Startup reads and decodes one packet for prompt presentation.
- The scanner resumes from that checkpoint. Every 500 ms it publishes the last
  validated tag boundary, even while a subsequent network read is blocked.
  Unchanged byte positions are not heartbeats. The source's progress contains
  scanned bytes, total bytes and packet count; it is available through getState.
- Published packet arrays are immutable. Newly found presentation timestamps
  are sorted and merged with the previous order; the full prefix is not sorted
  from scratch. Temporary indexes never go to the server cache.
- Scanner and decoder have independent bounded Range readers, pinned to the
  same observed file version. A stalled scan request cannot serialize a decoder
  cache miss. Each reader retains the existing 8 MiB cache limit.
- Before streaming, the startup-only drained decoder cursor is invalidated
  once. Subsequent publications append metadata without reset, seek or packet
  replay. Native decoder reordering and configuration-boundary drains continue
  to follow the existing packet timeline contract.
- At a temporary packet frontier, the decoder waits for a publication instead
  of flushing or returning EOF. Final completion removes that wait and allows
  the ordinary final decoder drain. Failures and disposal wake waiting readers.
- Metadata publication never waits for the worker extraction queue: extraction
  may itself be waiting for publication. Only startup of the background job is
  ordered after existing worker operations.
- frameAt and forward stepping wait for the requested prefix. framesFrom and
  framesAfter consume the growing timeline. Explicit ensureIndexed(Infinity)
  remains available for callers that actually require a finished index.

Full indexes are still built on the client and optionally uploaded to the
existing server cache. This change does not add server-generated indexes or
remove scanning cost. The final duration is only known after scanning finishes.

## Multi-track clock and visible states

Buffered indexed content still participates in normal synchronized playback.
Only an exhausted producer explicitly waiting for index data leaves the clock
coverage calculation. Its last image is labeled unsynchronized. Other tracks
continue; when more frames arrive it catches up sequentially and rejoins clock
coverage once it covers the current position. Merely being `building` is not a
reason to skip synchronization.

`syncState` (`index-wait` or `catching-up`) belongs to the runtime track. Stale
images cannot become new annotation/comparison anchors. Seek can establish a
fresh synchronized position. Decode failures remain subject to track isolation;
actual scan advances renew idle RPC deadlines, while stalled IO does not.

The source activity panel shows an actual byte-scan progress bar and per-track
packet counts independently of the completed first-presentation milestone. The
track inspector and growing timeline show the indexed duration. Fault snapshots
include scan progress, index waiting and synchronization state.

## Regression evidence

Tests block the next FLV range and observe an immutable partial index before
releasing it. A real FFmpeg packet decoder plays over one second from an indexed
prefix while a sparse tail is still blocked. Separate tests cover no-reset
incremental decoding, open-GOP PTS against ffprobe, cache reuse, forward stepping,
multi-track index waits/catch-up and failure propagation.

## Joining another track at the current observation time

Incoming-source preparation is independent of the transport operation queue.
Only the incoming source is sought and drawn; existing canvases, offsets,
annotations and playback readers are retained. A pending source is not yet a
loaded track and cannot contribute to shared-clock coverage or annotations.

- Paused: request the display frame covering the current session timestamp,
  decoding from its random-access anchor as needed. Exact seeking means the
  display frame at that time, not a forced equality with a VFR frame's PTS.
- Playing: the old session continues during open, index wait and initial seek.
  Once ready, join the new source. If the clock moved during decode, mark it
  catching-up until it covers the current clock; it must not rewind other tracks.
  Rebuilding loop membership retains every surviving FrameQueue/iterator.
- Unindexed target: request that prefix before clamping a timestamp to duration.
  A startup duration of 40 ms is not evidence that a later target is out of range.
  Report requested time, currently indexed duration and byte-scan progress while
  waiting. A finished full index is unnecessary when the prefix covers the target.
- Short source: seek its last display frame and hold it, preserving the existing
  session time. Replacing the longest source can legitimately shrink the whole
  session extent; only then clamp the global cursor to the new end.
- Replacement: retain the old source until the incoming frame has decoded and
  been presented. Failure/cancellation releases the incoming decoder and any
  late frame; the old source and observation point remain intact.
- Cancel load: explicit UI actions and `cancel_review_load` only cancel the
  incoming source. They do not pause surviving tracks. Transport pause leaves
  preparation running and establishes the position at which the new source joins.
- An explicit seek, step, source removal, alignment/workspace operation or a
  newer load supersedes pending preparation. Its cancelled status is visible;
  there is no late commit to an obsolete observation target. Disposal cancels it.

Load preparation does not set global busy. `mediaLoad.state` owns its lifecycle,
while `busy` still represents serialized transport/workspace operations. New
source alignment defaults to zero, including replacement, as before.
