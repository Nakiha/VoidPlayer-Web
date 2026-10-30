# VMAF continuous sequence scoring

The path retains its historical name for links. New jobs run in the existing
analysis WASM core, on the same service APIs as GUI and Agent. No native executable,
avfilter, third core or temporary raw clip is required. See
[analysis architecture](analysis-wasm-scoring.md) and [stage evidence](quality-convergence.md).

## Fixed numerical recipe

Netflix/vmaf v3.0.0 revision `17a67b238ce0539bdeafdc95961abac64fa16ea8`;
scalar single-thread libvmaf, subsample 1, no resize/color conversion/phone/HDR
transform. One context spans the continuous clip and final flush. Frame scores
and official min/max/mean/harmonic_mean are retained without recomputing the pool.

| Model | JSON SHA256 |
| --- | --- |
| `vmaf_v0_6_1` | `5950d61fa1f861bd45d8149d80539ed9f3376cfc2495b8f0fa8e9f57cb131ee3` |
| `vmaf_v0_6_1neg` | `1fcda193aaa2a3136471b7516b3c5dc344546c05fcde2d58609f8c60a2387392` |

v0.6.1 is a fixed baseline, **not the newest model**. Its viewing calibration is
not automatically valid for every input or crop. Higher is better; these fixed
models clip to 0..100. Identical inputs need not yield exactly100 each frame.
NEG is an explicit choice; no silent model substitution.

## Source, time and region

Use an actor-owned committed correspondence plan: 2..1024 continuous presentation
frames, exact rational cadence, same dimensions and limited BT.709 SDR YUV420
8/10-bit. Trusted complete FLV/Enhanced FLV and strict self-contained
nonfragmented MP4 avc1 H2648/hvc1 HEVC8/10 are admitted, including mixed containers.
Full-frame or a fixed even ROI>=64x64, up to4096x2304. The same crop is independently
scored by VMAF and companion PSNR/optional SSIM. It is not a heatmap decomposition.
No holes, stride, guessed correspondence, VFR, negative PTS, conversion or HDR.
Original ticks/timebase and packet-output tokens bind frames; microseconds are a
projection, never a nearest-frame identity. Complete closed GOPs<=512AU are drained.

## API and lifecycle

Read `/api/quality/vmaf/capability`, then explicitly prepare source indexes and
commit the relation/plan. POST `/api/quality/vmaf/preflight` with the job input
validates pinned sources/core/plan without decoding or creating a job. POST
`/api/quality/vmaf/jobs` freezes actor/client/body/Idempotency-Key. The schema
`voidplayer-native-vmaf-job` remains for wire compatibility. Supply model,
plan{id,attemptId,digest}, cadenceUs and exact cadence{ticks,timescale} when needed,
metrics{psnr:true,ssim:boolean}, and explicit budgets from runtime capability.

Observe the original job, `/result`, `/frames?after=0&limit=4`; explicitly cancel
with `/cancel`. Disconnection does not cancel. Worker exit and pending IO precede
admission release. Restart interrupts; it never recomputes. Completed companions
can remain partial if scoring fails, but no VMAF value is invented. Source/core
changes before final commit invalidate the score.

`maxRawBytes` counts streamed cumulative input pixels. `nativeMemoryBytes` and
`nativeCpuSeconds` are compatibility fields bounding analysis heap and conservative
wall time; results report actual WASM heap/wall time, not native CPU/RSS. Limits
are simultaneous budgets, not a promise that all maxima can run together.

Candidates require explicit space/side/maxScore/limit/minFrameDistance/text/severity.
Frozen publication receipts are replayed before private result lookup. Source
pictures and shared evidence can be inspected independently of playback. Releasing
an unpinned private result preserves inputs, immutable receipts and their storage
cost. Explicit reexecution validates the entire frozen execution contract and
requires full recomputation intent; old native results retain old provenance.

## Verification and maintenance

Real Node/Bun HTTP, Worker lifecycle, both browser engines and standalone packages
are registered in the existing test manifest. Independent official CLI oracles
cover full-frame/ROI, rational rates, 8/10-bit and long GOP clips; see the stage log
for exact passing and outstanding checks. Small clips are **not a throughput or real-time acceptance**.
No reference-integrity certification or decoder concealment detection is claimed.
Legacy `scripts/native` builders remain independent oracle/archaeology tools,
not deployment instructions. Old nativeVmaf settings are accepted but ignored.
Builds and licenses live in VoidPlayer-FFmpeg-Build; this repository consumes pinned artifacts.
