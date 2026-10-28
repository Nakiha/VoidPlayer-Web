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
Performance has not passed. Native VMAF has a separate [strict MP4/mixed sequence
contract](native-vmaf.md), with continuous exact cadence, full-frame limited
BT.709 SDR and v2 sample/table associations. [CAMBI](native-cambi.md) has separate strict single-source MP4 admission for the same codec/depth subset, positive constant presentation cadence and full-frame SDR; result/attachment v2 preserves sample/table/producer identity and five actual heatmap scales. Widening a source union never confers admission to another metric.

## Implementation and verification

The server parser commits MP4 documents and server producer evidence together in
the existing index transaction. The `mp4/video:0/1/mp4-quality-tables-v1` namespace
is read-only over frame-index HTTP: neither upload nor `build=1` can grant trust.
Explicit A preparation owns all IO and the existing physical execution permit.
C facts retain track/timescale/sample ordinal and raw DTS/CTS/duration ticks;
B consumes the resulting explicit pair table with its existing budgets/receipts.
Version 2 library results carry MP4 sample witnesses and the MP4-derived annotation
clock basis. FLV-only results remain version 1 with unchanged fingerprint fields.

A single exact identity edit is supported when its media start is zero, rate is
one and its movie duration equals the complete media duration as an exact rational.
Time-remapping and empty edits remain unsupported. All tracks must reference this
file; optional audio is not decoded or scored. ISO MP4 brands and identity movie/track matrices are required. Video chunks must have increasing
physical byte ranges. This first matrix requires explicit BT.709 nclx and SPS SAR.

Reproducible formal entries:

- `node --test test/media/quality-mp4-index.test.ts`: ffprobe raw table comparison
  for H2648/HEVC8/HEVC10; fragmentation, multi-video, encryption, configuration
  mapping, fake sync declarations, invalid offsets, duplicate PTS, fractional
  microseconds, truncation, identity/remapping edits and external audio references.
- `node --test test/media/quality-mp4-http.test.ts`: explicit A preparation → C
  mapping → B range → shared candidate; MP4/MP4 and both MP4/FLV directions;
  native-plane ROI and each grid cell SSE, independent FFmpeg uniform SSIM;
  exact metadata/payload byte charges, packet/output/read limits; server-only
  cache/producer seals, same-size replacement, actor fencing, import downgrade,
  committed-annotation lost response and receipt replay after restart/private
  result reclamation. Native VMAF v2 attachments additionally preserve the full
  temporal MP4 sample/table witnesses under the separate sequence contract.
- `node --test test/media/quality-mp4-lifecycle.test.ts`: actual descriptor close
  before delayed physical Worker termination releases admission; cancel/deadline/
  service close; read/index/packet budgets; dropped HTTP response, SIGKILL and
  interrupted receipt replay without automatic rebuild.
- `node scripts/check-mp4-quality-browser.mjs {chromium|webkit} {h264|hevc} {8|10}`:
  h264/8 and hevc/8,10 on both engines, explicit discovery/preparation, GUI ROI,
  C/B task, shared candidate, read-only original native planes/grid, independent
  playback of A. Outputs are local evidence JSON and screenshots.
- `node scripts/check-quality-release.mjs <package.tar.gz>`: the existing compiled
  acceptance now includes committed MP4/native fixtures for the same three codec
  combinations, with no decoder executable available to the packaged service.

The source index, HTTP, lifecycle and six browser entries pass locally, together
with the legacy FLV discovery/correspondence browser regressions, 73 fast checks
and the build/shared/boundary/manifest checks. Linux x64 compiled acceptance
passes the three MP4 combinations and the existing FLV/receipt matrix. Windows
x64 and macOS ARM64 compiled execution is delegated to the existing required PR
matrix; local Linux results do not certify those platforms. PR CI and independent
review remain required before merging.
No negative-source-PTS or VFR E2E certification is claimed. Broader MP4/container/geometry support
and performance remain unfinished.
