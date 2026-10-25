# Bounded source-pixel PSNR block evidence

The existing one-shot pair and durable single-frame PSNR request can include
`spatial: {blockWidth: 16, blockHeight: 16}`. The GUI task form exposes the same
optional parameters. This does not expand source, codec, closed-AU, color, bit
depth, correspondence or geometry support, and does not build an index.

Both dimensions are even safe integers from 2 to 16384, in the unrotated visible
luma source grid. The grid starts at the **measured ROI origin**, not the frame
origin or the CSS viewport. It partitions that ROI without overlap; right/bottom
edges use their actual clipped even extent. At most 64 blocks are admitted,
before job persistence or Worker creation. Invalid or excessive grids fail with
`invalid-input` / `budget-exceeded`; they never silently fall back to a scalar
measurement. Omitting the field preserves existing requests and scalar results.

## Numerical contract

The optional `metric.spatial` has schema `voidplayer-psnr-block-grid`, version 1,
partition `roi-anchored-disjoint-even-grid`, and ranking
`aggregate-mse-desc-row-major-ties`. It contains nominal block dimensions,
columns/rows, at most 64 row-major blocks, and at most eight `worst` block indices.
Each block records its absolute visible-source ROI, index, Y/U/V statistics and
aggregate statistics: exact integer SSE, actual sample count, MSE and PSNR.

Every original plane sample is read once. The existing kernel also accumulates
its squared error into the corresponding block. No extra decode, RGB conversion,
range normalization, padding or image capture is introduced. Chroma blocks use
half the luma coordinates/dimensions, so no chroma sample straddles a boundary.
The original sample/input budgets and deadline/physical-exit ownership remain.
Grid storage is bounded by 64×3 SSE accumulators plus the bounded result facts;
the existing 128 KiB result and combined annotation evidence budgets still apply.

Block sums exactly reproduce each full-ROI plane's SSE/sample count. The full
aggregate is still total SSE / total samples, not an average of block dB or MSE.
Worst blocks sort by descending aggregate **MSE**, so small edge blocks are not
penalized/rewarded merely by area. Exact ties sort by row-major index. Equal
pixels retain the existing JSON-safe positive-infinity representation. Scores
describe source YUV code-value error, not subjective defects or confidence.

## Persistence, sharing and display

Grid parameters participate in the canonical idempotency fingerprint. Retrying
the same actor/client/key/body replays the same result; changing/removing a grid
under the same key conflicts. No automatic retry or shared computation is added.
Lightweight job history still carries no block arrays. Details are read from the
existing immutable result endpoint with the same job/attempt/digest and provenance.

Explicit attachment to an existing annotation shares the same immutable block
facts. No private actor/client/request/key metadata is added to the shared value.
Ordinary edits preserve the grid, generic writes cannot strip or replace it, and
historical copies/imports retain all numbers but cannot inherit server verification.
The optional versioned grid extends the existing result value; workspace/review
v2 already preserves the complete evidence value, so no export format bump or
silent field deletion is needed. Older request servers reject the unknown request
field. Older consumers may lack grid rendering; that does not convert block facts
into a new verified measurement. Unknown grid versions are rejected by this build.

Task results and shared evidence show the same worst-region and complete bounded
tables. On the existing exact original-pair viewer, selecting a block uses
`QualityPairViewSession.selectBlock(index | null)`, shared by GUI and the viewer
Agent API `window.voidPlayerQualityPair.selectBlock`. Selection only changes an
overlay on the two already admitted immutable snapshots. It does not fetch a job,
read more media, decode/score, seek, mutate a mark or move the original window.
The original ROI remains visible; the selected block has a separate outline.
Selecting a block does not replace the annotation's original measured ROI or
attach a whole-ROI score as if it were the selected block's score.
Reopen, cancellation, failure and close clear selection with the existing frame
resource lifetime. The same strict exact SPS SAR, crop/rotation and presented
source/cache/AU/PTS checks continue to gate display; spatial evidence never makes
unsupported geometry displayable. The RGB presentation is not a source-error map.

Imported blocks are structurally checked before display: exact expected coverage,
order, count, per-plane/sample statistics, finite/infinite semantics, sums and
ranking. This is consistency validation, not proof of the content of an imported
file. Service verification still comes only from the existing committed job and
explicit shared attachment path.

## Verification and remaining scope

Tests retain the original scalar cases and add nonzero ROI/crop/stride/view-offset
8/10-bit known answers, partial edge blocks, MSE-vs-SSE ranking, ties/infinity,
64-block admission, malformed facts and canonical idempotency. Real decoded 8/10-bit
raw planes are checked block-by-block against FFmpeg's crop+PSNR reference using
the existing 0.00501 printed-stat tolerance. Real HTTP Node/Bun and compiled
packages independently sum the committed native sample planes, then verify
durable history, attachment, export/import downgrade and restart preservation.
The existing full-CI real browser cases now start a grid measurement via GUI,
compare HTTP Agent facts, attach explicitly and select blocks on the original
viewer in Chromium/WebKit × H.2648/HEVC10, including exact partial-edge projection,
unchanged frame commits, no private job request and unchanged original playback.

This is bounded single-pair PSNR spatial evidence, not SSIM, a per-pixel heatmap,
automatic defect annotation, normal dependent-frame/sequence scoring, arbitrary
container support, automatic pairing/alignment or distributed execution. Those
roadmap criteria remain open. Existing playback performance failures and historical
CI failures with unknown roots are not resolved by this feature.
