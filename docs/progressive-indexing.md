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
