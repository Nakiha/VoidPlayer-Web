# Optional source-plane SSIM companion

The existing explicit single-frame PSNR measurement can also return SSIM. In the
GUI, select **Also measure SSIM** before submitting. HTTP/Agent callers add:

```json
{"ssim":{"variant":"ffmpeg-uniform-8x8-step4-v1"}}
```

This field is optional on the existing one-shot and durable request contracts.
PSNR is still required and returned in `result.metric`; SSIM is a separate
`result.ssim` value. There is no SSIM-only job. Omission preserves the old request
fingerprint and scalar/grid PSNR behavior. Adding or removing SSIM under a used
idempotency key conflicts. Unknown variants/fields fail, never fall back to PSNR.
Discovery advertises the exact variant, required PSNR and SSIM work limits.

## Exact mathematical variant

`ffmpeg-uniform-8x8-step4-v1` evaluates the mathematical approximation in
[FFmpeg n7.1.5 vf_ssim.c](https://github.com/FFmpeg/FFmpeg/blob/n7.1.5/libavfilter/vf_ssim.c),
using JavaScript Float64 arithmetic (`cpu-f64-ffmpeg-uniform-v1`). It is **not**
the original Gaussian-window Wang SSIM, multiscale SSIM, RGB/luma-only SSIM or a
perceptual confidence estimate. FFmpeg's C/SIMD implementation accumulates some
values in Float32, so results are numerically comparable, not bit-identical.

For each native Y/U/V plane, windows are uniform 8×8 with stride 4, anchored at
the plane's ROI origin. Let `X=sum(x)`, `Y=sum(y)`, `Q=sum(x²+y²)`, and
`P=sum(x*y)` over a window of 64 samples. With peak `L=255` or `1023`:

```text
C1 = floor(0.01² × L² × 64 + 0.5)
C2 = floor(0.03² × L² × 64 × 63 + 0.5)
V = 64Q − X² − Y²
C = 64P − XY
SSIM = ((2XY+C1)(2C+C2)) / ((X²+Y²+C1)(V+C2))
```

These are the filter's integer-rounded constants, not interchangeable with the
constants of other SSIM variants. At 8 bit C1=416 and C2=235963. For constant
black versus code value 1, SSIM is 13/141, not a conventional Gaussian SSIM value.
Per-plane scores are the arithmetic mean of valid windows. Aggregate is
`(4*Y_mean + U_mean + V_mean)/6`, including for non-square ROI and truncated
coverage. It is not weighted by the number of windows. Equality yields 1;
anti-correlated pixels can yield negative scores. No score clamping or dB
conversion is applied.

Native planar YUV420 8/10-bit code values, actual color and chroma location are
required and must agree. Limited range still uses peak 255/1023. No color/range
normalization, upsampling, display capture, rounding to 8 bit or alignment occurs.
The same two verified decoded frames feed both metrics; there is no second decode.

## ROI, coverage and grid

ROI is in the unrotated visible source-luma grid, with even integer coordinates
and dimensions. SSIM ROI **and every actual clipped grid block** must be at
least 16×16, so each chroma plane has at least one 8×8 window. An invalid edge
block rejects the explicit request before durable admission. PSNR-only grids
retain their previous 2-pixel minimum and partial-edge behavior.

For a plane of ROI size `w×h`, tile counts are `floor(w/4)`, `floor(h/4)`;
window count is `(floor(w/4)-1)*(floor(h/4)-1)`. Only complete windows count.
Right/bottom samples beyond complete 4-pixel strips are omitted, without padding.
Each plane records its window count and actual coverage in **absolute visible
source-luma coordinates**, including U/V. Example: luma ROI (2,4,24,20) has luma
coverage (2,4,24,20) but U/V coverage (2,4,24,16). The unscored chroma tail is not
presented as measured.

Optional SSIM grid uses exactly the requested PSNR partition/indices. Windows
restart at each block origin and cannot cross a block boundary. Grid scores are
independent of the whole-ROI score: averaging block scores cannot reconstruct it.
SSIM worst indices sort by aggregate score ascending, row-major on ties, at most
8; PSNR worst ranking remains separately based on descending per-sample MSE.
Task facts, annotation evidence and the original-pair viewer show distinct SSIM
scores/coverage and the same source-grid block selection. Selecting a block never
measures again, changes a frame or moves a playback cursor.

## Trust, execution and persistence

All existing library, producer, version, namespace/build, configuration/AU, actual
PTS, source/color and Worker fences apply unchanged. Registered FLV/Enhanced FLV,
closed progressive H264/HEVC pictures or explicitly bounded forward-dependent
windows, with fully tagged 8/10-bit YUV420 remain the supported set. Forward
window/identity/output limits are defined in [forward-frame quality](forward-frame-quality.md). Stat identity is not content authentication. No auto indexing,
nearest PTS, reordered/delayed-output frames, sequence scoring, uploads or distributed compute.
Measurement geometry and original-viewer geometry remain distinct; the viewer
still rejects non-unit exact SAR, crop and unsupported rotation. Adding SSIM does
not make an otherwise unsupported original-pair inspection valid.

SSIM is inside the existing killable task Worker and 30-second total deadline.
SSIM-specific hard admission caps: 33,554,432 paired sample visits (two source reads per visit), 2,097,152 windows and
262,144 bytes tile scratch, in addition to existing input/sample/heap/read limits.
The two-row tile algorithm uses O(plane width) scratch; grid work includes the
whole ROI plus all disjoint blocks. `work` reports actual planned sample visits,
window evaluations and maximum live tile scratch. These are fixed service caps,
not caller-increasable budgets. Physical Worker exit still precedes capacity
release. Closing an observer does not cancel a durable job.

The immutable result digest covers both metrics. Explicit attachment publishes
both with existing provenance, without revealing a private client's submission
or idempotency key. Ordinary text/reply/region edits preserve both. Workspace v2
plain/gzip exports retain all SSIM facts; imported/copied facts are historical,
not newly service-verified. Old workspace v1 cannot silently discard attachments.
Structural validation checks variant/constants/window geometry, per-plane
coverage/counts, aggregate weighting, work plan and grid/ranking; it does not
prove an imported score authentic.

## Verification

- Independent test-only brute 8×8 BigInt sufficient-statistics/rational oracle;
  8/10-bit full/offset ROI, cropped/padded storage, negative/equal/constant cases.
- `test/helpers/ssim-ffmpeg-reference.json` records FFmpeg 7.1.5 Debian build
  configuration/version, synthetic input hashes, filter semantics and 12 fixed
  reference outputs. Live FFmpeg runs log their own version (CI is not claimed
  pinned). A preselected absolute tolerance 0.00001 covers printed/Float32
  differences; the independent mathematical oracle uses 1e-12.
- Real registered media → explicit trusted cache → HTTP job → independent raw
  native-plane score → immutable annotation → plain/gzip historical export →
  restart; H2648, HEVC8 and HEVC10. Existing PSNR assertions remain.
- Chromium/WebKit × H2648/HEVC10 starts through a real GUI click, preserving the
  actor mismatch/lost-response/idempotency, service-owned execution, real Worker
  cancel/exit, queue, color/cache/version and playback isolation assertions.
  SSIM facts are observed by Agent and shared exact original-pair/block viewer.
- Three native package checks exercise SSIM durable results/evidence/restart on
  the actual compiled Bun Worker with empty PATH, independent of FFmpeg tools.

This feature adds no throughput claim. Previous non-realtime performance results
remain negative; SSIM performance has not been accepted as realtime.
