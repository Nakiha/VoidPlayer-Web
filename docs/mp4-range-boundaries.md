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
including moov and its nested tables, retain strict bounds. Before the native
or packet path accepts this recovery, every video sample must fit inside actual
mdat bytes. Sample offsets are not clamped and missing samples are not invented.
A visible index warning records the recovery; it confirms the selected video
track's sample coverage, not audio completeness or the integrity of all codecs.

Regression tests use a 9 MiB moov and a 64-bit mdat declaring 14.26 GB over a small
complete video. They verify configuration parsing, real packet decoding, real
FFmpeg Range open/seek, and rejection of missing samples and invalid metadata
boxes. Threaded bridge tests independently cover a 9 MiB logical read at an
offset above 4 GiB, EOF, cancellation, short responses and version changes.
The browser Range suite checks native decoding, seek, stepping and the app's
playback benchmark on the recovered MP4 in both Chromium and WebKit.
