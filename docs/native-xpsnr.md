# XPSNR continuous sequence scoring

This historical URL now documents the analysis WASM executor. XPSNR is compiled
into the existing analysis core, alongside VMAF/CAMBI. No separate core, avfilter,
framesync, native executable or raw clip file participates. See
[architecture](analysis-wasm-scoring.md) and [acceptance evidence](quality-convergence.md).

## Algorithm and measurement

The standalone scalar algorithm is derived from LGPL-2.1-or-later FFmpeg revision
`8998a1a670c81a04d144c36f9e2d3aa680c10720`, original filter SHA256
`4b59b32eb4a501ac74f6d767a916ef1a29833e1895b150cfa96b8e4ffb91f3d7`.
The analysis manifest additionally pins adapter, ABI, glue, WASM and provenance.
Reference is first input; two previous reference frames remain in one clip context.
Exact rational frame rate controls the temporal recipe. State resets at the clip
boundary and official final pooling completes before result commit.

Frame Y/U/V dB and official sequence Y/U/V pool plus minimum retain full double
precision. Pooling uses weighted-distortion accumulators and the official
low-distortion fallback, never rounded frame dB averages. Positive infinity is
`{kind:"positive-infinity",db:null}`. Full-precision statistics JSON and SHA are
stored. Historical four-decimal native statistics remain historical.

Choose 2..1024 fully mapped continuous presentation frames in an explicit committed
C plan. Full-frame or fixed even ROI>=64x64, limited BT.709 SDR YUV420 8/10-bit,
same geometry, up to4096x2304. Original ticks/timebase and opaque packet-output
identity control pairing. Closed GOPs<=512AU are decoded once and fully drained.
Trusted complete FLV/Enhanced FLV and strict nonfragmented MP4 H2648/HEVC8/10 are
supported; no stride, holes, guessed alignment, VFR, negative PTS, HDR or conversion.
PSNR/optional SSIM companions measure the same pixels and region independently.

## Public workflow

Start with `/agent/quality/xpsnr.md` or `/api/agent/tasks/quality.xpsnr`.
Read `/api/quality/xpsnr/capability`, explicitly prepare indexes and freeze the
reference relationship/C plan. POST `/api/quality/xpsnr/preflight`, then explicit
`/jobs` with retained actor/client/body/Idempotency-Key. Existing schema
`voidplayer-native-xpsnr-job` and recipe `ffmpeg-xpsnr-reference-first-temporal-v1`
remain compatible. Supply cadenceUs plus exact cadence{ticks,timescale}, metrics
and budgets; compatibility nativeMemoryBytes/nativeCpuSeconds fields now bound
analysis heap/conservative wall time, without claiming native CPU/RSS observation.

Observe `/jobs/{id}`, `/result`, `/frames?after=0&limit=4`. Cancel explicitly;
observer close does not cancel. Physical Worker/IO completion precedes admission
release. Restart interrupts without automatic retry. Source/core identity is
rechecked before commit; companions may survive a scorer failure as partial.

`/compare?ids=ID1,ID2` accepts2..4 owned completed variants only when reference
source/version/cache, exact clocks, raw hash, crop and implementation/recipe match.
Caller order remains; no approximate alignment or perceptual superiority claim.
Candidates require explicit side/space/maxScore/limit/minFrameDistance/text/severity.
These are temporal measurements of the chosen region, not localized defect maps.
Frozen IDs and policy receipts survive result release. Shared original-frame
inspection is independent of playback. Explicit reexecution validates source,
producer/core/recipe and full cost; drift needs new intent.

Official CLI is used only to generate independent raw-plane test oracles. Real
Node/Bun HTTP, crop/rate/long-clip matrices, lifecycle, GUI comparison and standalone
checks are mandatory registered tests. Runtime does not search PATH. Historical
nativeXpsnr configuration is accepted but ignored; original native evidence is
preserved, not relabelled. No reference-integrity/concealment certification.
