# Trusted non-fragmented MP4 quality sources

This work extends the existing explicit discovery/preparation, source-plane
PSNR/SSIM/grid, correspondence/range, shared evidence and read-only original-pair
workflow. The first matrix is self-contained non-fragmented MP4, one video track,
one avc1 H.264 8-bit or hvc1 HEVC 8/10-bit description, progressive 4:2:0 SDR,
proven square pixels and no crop/rotation. Audio may be present and is not scored.
No new scheduler, decoder core demuxer or numeric metric is introduced.

The quality index has its own versioned schema. Decode-order sample ordinal,
track ID, sample description, original DTS/CTS/duration ticks and timescale,
physical offset/size and raw moov digest remain explicit. Every API microsecond
clock must be exactly representable: division with a remainder is unsupported,
never rounded or repaired from POC. Sync tables nominate candidates; actual NAL
validation establishes the supported closed IDR boundary. Complete bounded GOP
inputs and drain outputs use the existing opaque packet-token decoder protocol.

Fragmentation, encryption, external data references, multiple video tracks,
configuration switches, edit remapping, corrupt/truncated/recovered tables,
open-GOP/CRA and ambiguous clocks are rejected. Unsupported inputs do not gain
trust from a filename, playback success, uploaded cache or client producer claim.
Server producer identity, stat witness, table/configuration witness and document
digest/commit must be checked and committed together. MP4 payloads are not FLV
tags and must not pay invented tag-byte IO. Old FLV fingerprints, receipts and
attachments retain their original meaning.

Reference relationships remain caller declarations, not content certification.
Reference integrity is not-certified and concealment detection is unavailable.
Performance has not passed. Native VMAF and future CAMBI remain explicitly
FLV-only; widening the PSNR source union must not widen those executors.

## Implementation checkpoint

The strict sample-table reader, exact-clock rejection and server-only producer
commit are implemented, with a dedicated MP4 cache identity and document/table
seals in the existing transaction. Generic packet adaptation preserves the old
FLV entry wrappers; MP4 reads metadata and actual sample payloads, never FLV tags.
Version 2 library results retain MP4 raw sample clock witnesses; version 1 FLV
requests, results and receipts keep their old fields. Read-only inspection has
been connected to the generic adapter. Native VMAF remains explicitly FLV-only.

Real H.2648, HEVC8 and HEVC10 sample identity tests match ffprobe and reject
malformed offsets, external references, false keys, truncation and inexact clocks.
The first HTTP matrix passes explicit discovery/preparation, frozen C plan,
B range, native-plane ROI SSE, independent FFmpeg SSIM and shared candidates.
Existing FLV unit/range HTTP regressions pass. GUI/viewer acceptance, mixed
MP4/FLV tests, full tamper/lifecycle matrices and compiled-package coverage are
still in progress. This checkpoint is not a complete MP4 feature candidate.
