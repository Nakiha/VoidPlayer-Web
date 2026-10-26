# Native single-source CAMBI screening (#116)

This work uses the optional Linux x64 component installed for [native VMAF](native-vmaf.md), pinned to Netflix/vmaf v3.0.0, revision `17a67b238ce0539bdeafdc95961abac64fa16ea8`. The CAMBI command executes `--no_prediction --feature cambi`; no VMAF model is loaded and full-reference mode is disabled. The public request identifies one source; the CLI receives that same raw file in both API slots because the upstream feature API requires two paths.

CAMBI is an uncalibrated banding indication: higher means more detected banding, zero is a completed numeric result, and neither is a product quality pass/fail. Each frame is independent, so deterministic stride sampling is allowed and unsampled pictures remain explicit. No temporal tracking or reference integrity certification is claimed; decoder concealment detection is unavailable.

## Verified component boundary

The installed scalar v3.0.0 binary was executed on a synthetic 640×360 8-bit YUV420 input. It produced one CAMBI score and five upstream heatmaps with exact dimensions 640×360, 320×180, 160×90, 80×45 and 40×23. Each file contains row-major native uint16, little endian on the only supported x64 platform; successive frame planes are concatenated. Upstream rounds each downscaled dimension upward and writes at `frame * width * height * 2`. Its values are scaled internal c-values, not independent cropped-region CAMBI scores.

Source audit and actual execution found that both dimensions below 320 are unsupported; the CLI with threads may exit zero with no frames. Admission therefore requires a long edge ≥320, and zero exit is never sufficient: exact scores, file set and all five lengths must match. Capability checks run a real one-frame feature/heatmap self-test under the shared admission slot.

The scope remains trusted complete FLV/Enhanced FLV H.264/HEVC, original planar 8/10-bit limited BT.709 SDR, exact square uncropped/unrotated geometry. No HDR, extra containers, conversion, GPU, browser WASM CAMBI, or distributed execution.

## Budget model

All five scale byte counts are computed before native execution, multiplied by the selected frame count and checked against the aggregate heatmap budget. Raw sequence bytes are bounded separately. The fixed audited binary writes exactly five known heatmap files and one result file: temporary reservation charges **six per-file caps plus raw bytes**, so `RLIMIT_FSIZE` is not represented as a total directory quota. Exact file set, regular-file status and final lengths are checked after physical exit. This is a trusted-component bound, not a sandbox for arbitrary executables. Paths and feature options never come from HTTP. Scores and image bytes remain separate; frame/scale heatmap reads are on demand.

Implementation status: native capability and shared admission/Worker/native process reuse are being integrated; this checkpoint is not a released feature or completed acceptance matrix.
