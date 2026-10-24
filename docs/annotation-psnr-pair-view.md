# Explicit original-frame pair and ROI viewer

An explicitly shared PSNR attachment now offers **View original frame pair and
ROI in a new window**. The existing page Agent's `get_annotation_pair_view` returns
the same reference URL for explicit navigation. The URL contains only the shared
space, annotation ID and evidence ID. It does not contain a private job token or
result payload. Opening the facts dialog or discovering the URL performs no media
inspection. Ordinary activity/admin annotation links keep their existing behavior.

`quality.html` is a separate, read-only window. It has two independent immutable
source-plane snapshots, including when both roles are different AUs in the same
file. It has no playback clock, seek/step, workspace import, annotation synchronizer,
mark editing, job manager or result computation. It neither seeks nor restores the
opener. The original annotation and its IDs/region/drawings remain unchanged.

## Admission before pixels become visible

The session facade reads the current shared annotation and selects the exact
attachment ID. Only a `server-verified` attachment from this service's own origin
can request original frames. Historical exports/copies retain facts but cannot
inherit this inspection authority. No owner-only job or job-result endpoint is
called. The source endpoints require the normal intranet identity; this feature
does not introduce authentication or make a stat witness content authentication.

A one-shot owned browser Worker checks both current `/psnr-source` proofs against
the attachment's complete source binding and producer evidence. This includes media
ID/version/size, index namespace/schema/indexer/build, epoch, packet commit and
cached-document digest. It reads an existing index with GET and **without** a build
parameter, verifies the document digest, and reads only bounded version-pinned byte
ranges. Missing, cleared, rebuilt, untrusted or changed caches explicitly fail.
It does not repair, scan, build or upload an index.

The existing closed-AU validation and raw-plane decoder are shared with measurement
through `withFlvFramePair`. Inspection takes the raw-frame path and never calls
`measurePsnr`. It verifies the source tag/configuration, unique source PTS, AU and
packet-picture evidence, then decodes exactly two isolated closed pictures. The
actual decoder build, full frame description (including color and plane layout),
packet and source provenance must equal the original measurement. Both source/cache
proofs are read again before the Worker publishes. The main session rereads the
shared attachment before presentation so deletion/downgrade/replacement during an
open cannot publish a late result.

A successful presenter commit yields a **snapshot presentation token** containing
its actual source PTS, SourcePictureKey, source/cache binding and exact SPS geometry
(including the integer SAR numerator and denominator), alongside decoded geometry. This is
separate from the ordinary playback token: a snapshot has no normalized media or
session timeline. It must pass exact binding and geometry checks before either
image or ROI is revealed. The normal playback token's missing index-build evidence
is not silently filled in from an attachment.

## Geometry and display limits

The metric's ROI is in the **unrotated visible luma pixel grid**. V1 admits only an
identity geometry: zero crop origin, visible/coded/output dimensions equal, and
square pixels proven by explicit SPS SAR and exact `sarNum === sarDen`, with matching decoded
dimensions. Rounded `displayWidth` equality alone is insufficient: a real 32px
1000:1001 SAR rounds back to 32px and is still rejected before decoder admission.
The opt-in parser witness also distinguishes missing/unspecified aspect ratios
from explicit 1:1; missing evidence is rejected. Default playback parser results
remain unchanged. The exact witness is retained and rechecked through presentation. Crop and SAR
are rejected before decode/presentation instead of approximating their transforms.
The isolated FLV raw picture is deliberately displayed unrotated; container display
orientation is not applied. Any nonzero presentation rotation is rejected. This
viewer does not assert that ordinary playback presentation has the same geometry.

Both snapshots use the existing presenter and viewport-sized surface (bilinear
minification / nearest magnification). The transient SVG ROI uses that surface's
same fit rectangle and CSS pixel geometry; DPR only changes backing resolution.
Resize re-presents the retained snapshot and rechecks its token. ROI is neither a
Mark.region nor a drawing. Cancel, a new open, failure or close hides both images
and removes ROI, including after an old response arrives.

Displayed RGB passes through the existing color presentation policy. It is not a
new measurement or a claim that displayed RGB equals source YUV code values. No
heatmap, SSIM/VMAF, sequence pairing or automatic correspondence is provided.

## Ownership, limits and verification

Cache digest verification requires WebCrypto in HTTPS or localhost secure contexts;
other hosts receive an explicit unsupported error before source probing.

The view's 30-second cancellation/deadline signal covers annotation checks, source
checks, cache transfer and decoding. The original pair budgets remain: 16 MiB exact
media reads, 8 MiB per packet, 250,000 cached packets, 32 MiB per cached document,
32 MiB per output frame, 256 MiB WASM heap, 4096×2304 coded pixels and exactly two
outputs. Source proof responses are capped at 16 KiB; index envelopes at 32 MiB +
1 KiB. Main-thread retained snapshots share a 64 MiB application-byte budget.
These are per viewer, not a global browser/process memory claim.

The client terminates its Worker on every terminal path, and admission is not
released before termination acknowledgment. A superseding open waits for that
owner's exit; it cannot use a late response or free still-owned execution capacity.
Close waits for pending ownership cleanup. Ordinary browser termination is
synchronous; async hosts retain the existing physical-exit fence.

Registered Chromium/WebKit cases use real completed H.264 8-bit and HEVC 10-bit
jobs attached through HTTP/GUI. They click an actual attachment link from a guest
window, compare the Agent URL, and verify original source PTS (2s/3s, not normalized
0), same source/different AU, namespace/build, ROI, DPR 2 and responsive resize.
Actual FFprobe-confirmed H.2648 and HEVC10 1000:1001 SAR fixtures complete real
scoring/attachment with rounded 32px display width, then fail explicit inspection
without presenting pixels or ROI. They preserve the original playing window and private-job 404/no-implicit-request
assertions, check cancellation memory release, and explicitly clear/rebuild/change
sources to prove fail-closed behavior without implicit index creation. The browser
cancellation case blocks the first annotation GET; it does not claim cancellation
inside actual decode. Source units use controlled dependencies for geometry/AU/PTS/
namespace/build/decoder/color mismatches, attachment removal/downgrade and late/
superseding/close ownership races. Existing real stalled-Worker cancellation tests
cover the generic client's physical termination fence. Real media tests separately
exercise exact-SAR rejection while normal source-plane scoring remains accepted. Existing numerical and real-plane
regressions remain required. This advances #115; it does not complete the issue.
