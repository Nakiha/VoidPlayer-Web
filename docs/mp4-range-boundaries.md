# MP4 size declarations and synchronous Range reads

The shared 256 KiB transport window is not an AVIO request-size limit. The
worker-side Blob adapter assembles larger reads from bounded transfers, up to
an explicit 64 MiB per-read allocation ceiling. Each response must have the
requested length; cancellation, HTTP failures and source version changes reject
the logical read rather than returning partially assembled bytes. Offsets remain
safe JavaScript integers and are never coerced to 32 bits.

Sequential playback of both File/Blob and URL inputs opts into the same
asynchronous compressed-byte read-ahead. A File can reside on a mounted network
drive; its source type does not establish low latency. Initially, when less
than 2 MiB remains ahead of consumption, the reader starts at most one 2 MiB
request, overlapping latency with decoding. A demand for
that range joins the existing request; cached reads remain available while it
is pending. The compressed cache starts at 8 MiB, independently of the
decoded-frame queue and the 256 KiB synchronous bridge transfer window. No
recursive fetch runs without consumption. Metadata/probing/index readers stay
on their existing demand/scan policies. Seek and decoder replacement disable
read-ahead and abort the old speculative request; close also discards cached
bytes. Late responses cannot refill the cache, and speculative response/version
failures reject the eventual consumer with the original input error.
Blob reads cannot be physically aborted: a cancelled speculative read keeps its
in-flight slot until it settles, discards its result, and cannot cause repeated
seek/resume operations to stack background file reads. Short or failed Blob
reads reject the consumer as input errors. With shared memory, synchronous
FFmpeg container decoding uses this same asynchronous reader and bridge for
both source types (`blob-range` / `http-range`). Non-isolated browsers retain
the existing local FileReaderSync compatibility path; it cannot overlap async
IO with a synchronous decoder without shared memory.
The bridge also retains at most 128 KiB of already-cached startup metadata
outside the LRU, preserving cache-only metadata/audio observation after a full
container scan. Observation never starts IO. Progressive TS startup playback
uses its own reader; the concurrent full index scanner retains its existing
read policy until it finishes.

Sequential playback adapts from observed byte consumption and actual input
starvation. It samples forward byte progress over at least 250 ms, excludes
blocked input time once at least 100 ms of non-IO observation is available
(otherwise retaining the wall-clock rate), smooths the
rate, and retains twelve successful refill durations. Refill time includes
callback scheduling, so slow callbacks alone never grow memory. Growth requires
at least two waits of 4 ms or more, totaling at least 20 ms, after a 500 ms
warmup and with at least one second between growth decisions. The current read
must have encountered a new wait; old warmup waits cannot trigger delayed
growth after recovery. Presentation
`waitingMs`, codec type, thread count and File/URL labels are not inputs.

The target low watermark covers 1.5 times the refill P95 plus 50 ms, multiplied
by measured byte consumption, with a 2 MiB minimum. Repeated starvation also
raises the watermark by at least half the prior batch. If observed consumption
uses at least 70 percent of the request service rate, the batch doubles up to
8 MiB to amortize per-request latency. The cache grows in 8/16/32 MiB tiers to
hold the watermark, a complete next batch, 1 MiB of history and the current
block. Unread forward blocks take priority over consumed history during
eviction. These are per-reader limits; the one in-flight body, logical read
output, metadata prefix and decoder/GPU allocations are separate.

After fifteen seconds without input starvation, targets may shrink, at most
once every five seconds. A smaller batch must have ample headroom even if its
completion takes as long as the observed larger request. Pauses reset rate
sampling; they do not count as evidence of a slower input. Seek/decoder
replacement disables read-ahead, restores the 8 MiB baseline, trims history,
and cancels the old speculative operation with the same physical-settlement
rule for Blob IO. Probe, metadata and index readers remain at their original
budgets. `readAheadSnapshot()` reports these measurements and limits without
IO or cache promotion. Insufficient sustained bandwidth cannot be repaired by
unbounded buffering: growth stops at 32 MiB plus one in-flight batch.

AVIO reads starting at or beyond the known physical EOF return an empty buffer.
Requests crossing EOF are clipped before calculating their length. This matters
when a demuxer seeks using an overstated atom size: the old adapter could produce
a negative length and misreport it as a Range buffer overflow. Large moov size
alone does not establish the size of any individual AVIO read.

Only a top-level mdat may declare an end beyond the physical file. Other boxes,
including moov and its nested tables, retain strict bounds. Recovery validates
all selected video sample offsets against the declared mdat range, requires
nonoverlapping forward offsets, and keeps only the contiguous decode-order
prefix whose packets fit in physical media bytes. A partially present packet
and the entire missing suffix are excluded. Invalid offsets, holes, or an empty
prefix fail as an input error without retrying a full-file FFmpeg index scan.
Sample offsets are never clamped and missing packets are never invented.

The packet engine uses the moov metadata for timestamps (including CTTS and edit
lists), reads retained compressed packets directly at their validated offsets,
and computes duration from the retained presentation timeline. Native preflight
routes truncated MP4 to this bounded packet timeline, retaining WebCodecs when
the codec configuration is supported. Decoder capability failures may still use
WASM packet decoding; truncation itself does not require FFmpeg demuxing. This
is not a promise to repair arbitrary corrupt files or incomplete moov tables.
A visible index warning reports retained versus declared video packet counts;
it does not claim audio completeness. HEVC streams with missing composition
timing retain their existing bitstream inspection path.

Regression tests use a 9 MiB moov and a 64-bit mdat declaring 14.26 GB, plus real
suffix truncation midway through a packet, co64 chunk offsets, and reordered
B pictures. They verify configuration parsing, real packet decoding and repeated
seeks, real FFmpeg Range open/seek, and rejection of invalid metadata and unsafe
recovery. Threaded bridge tests cover a 9 MiB logical read above 4 GiB, EOF,
cancellation, short responses and version changes. The browser Range suite
checks native decoding, reduced duration, warnings, seek, stepping and the app's
playback benchmark on complete and truncated MP4 in Chromium and WebKit.
