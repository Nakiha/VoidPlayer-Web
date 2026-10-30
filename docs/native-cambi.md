# Single-source CAMBI screening

CAMBI uses the existing analysis WASM core and pinned Netflix/vmaf v3.0.0 revision
`17a67b238ce0539bdeafdc95961abac64fa16ea8`. It is no-reference banding screening:
no C plan, reference relation or VMAF prediction model. Higher means more banding,
not a calibrated product pass/fail. See [architecture](analysis-wasm-scoring.md)
and [verification stages](quality-convergence.md). This historical URL is retained.

## Recipe and coverage

Fixed eotf=bt1886, window63, topk0.6, tvi_threshold0.019, max_log_contrast2,
full_ref=false, internal10bit, source geometry/depth, single-thread scalar algorithm.
Five official gray16le heatmaps are returned in memory with unchanged scale math.
They contain upstream scaled c-values, not cropped-region CAMBI recomputation.

Trusted complete FLV/Enhanced FLV H264/HEVC8/10 and strict self-contained
nonfragmented MP4 avc1 H2648/hvc1 HEVC8/10; original limited BT.709 SDR YUV420,
square unrotated uncropped geometry, even dimensions>=64, long edge>=320,
maximum1920x1080. Select a half-open source-PTS interval and explicit AU stride:
at most4096 interval AUs/1024 selected pictures. MP4 samples are then fed in exact
rational presentation order. Negative/VFR/HDR and ambiguous clocks are refused.
Unsampled and unsupported pictures are explicit coverage, never zero scores.
There is no temporal object tracking or whole-file claim for sparse sampling.

## HTTP and GUI

Read `/api/quality/cambi/capability`: artifact hashes are verified there; the pixel
ABI is checked at execution. Missing artifacts mean unavailable, never zero.
Discover a source and obtain the full `/api/media/{id}/psnr-source?v=VERSION`
binding. Missing indexes require separate explicit preparation; submission does
not build one. POST `/api/quality/cambi/jobs` with schema voidplayer-cambi-job,
version1, client, source binding, interval, sampling and explicit budgets.
Retain actor/body/Idempotency-Key after any uncertain outcome.

Complete GOPs<=512AU are streamed once. Each frame's five scales persist before
acknowledging the next frame, bounding memory without temporary raw clips. Raw
budget counts cumulative pixels; heat budgets count all five scales. Legacy
nativeMemoryBytes/nativeCpuSeconds fields bound analysis heap/conservative wall
time. No invented native CPU/RSS. Limits must hold together with time/index/output
budgets; their maxima are not a guaranteed workload.

Read `/jobs/{id}`, `/result`, `/frames?after=0&limit=4`, `/heatmap?index=N&scale=S`
and `/picture?index=N`. Only committed completed results are inspectable/publishable.
Original source/cache/AU/raw identity is revalidated for pictures; this never
rescores or seeks the player. Explicit cancel waits for Worker plus pending sink
IO before freeing capacity. Restart interrupts and removes uncommitted heatmaps.

Publish only an explicit `/jobs/{id}/candidates` policy
`{space,minScore,limit,scale,cellThreshold,text,severity}`. Actual nonzero heatmap
cell bounds become immutable source regions, not arbitrary score-only boxes.
Policy/IDs/operation receipts freeze before annotation writes and replay before
private result lookup. Imported evidence is historical. Unpinned private results
can be released; receipts and storage cost remain. Stopped failed/interrupted/
cancelled jobs can explicitly validate full reexecution; no partial resume,
automatic publication or changed-source retry.

## Evidence and compatibility

Independent official scores and every heatmap scale hash are checked on actual
HTTP/Worker/Node/Bun/browser/standalone paths, including192-frame rational-rate
clips. See stage logs for current platform status rather than inferring it from
small fixtures. Natural official fixtures retain their BSD-2-Clause-Patent
notice in test/helpers/native-cambi-official-NOTICE.txt; algorithm licensing and
source are shipped by the upstream analysis build.

Old nativeVmaf settings are ignored for new runs. Legacy process recovery and
original binary provenance remain readable. No reference-integrity certification,
concealment detection, HDR/VFR certification or regional CAMBI rescoring is claimed.
