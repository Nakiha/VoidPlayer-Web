# MP4 size declarations and synchronous Range reads

The shared 256 KiB transport window is not an AVIO request-size limit. The
worker-side Blob adapter assembles larger reads from bounded transfers, up to
an explicit 64 MiB per-read allocation ceiling. Each response must have the
requested length; cancellation, HTTP failures and source version changes reject
the logical read rather than returning partially assembled bytes. Offsets remain
safe JavaScript integers and are never coerced to 32 bits.

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
