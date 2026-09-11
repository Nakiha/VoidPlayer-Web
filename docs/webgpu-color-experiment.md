# WebGPU SDR experiment — tested 2026-09-10

> 历史阶段记录：以下结论对应 CPU / memory-VideoFrame 实验，已由 [原生 WebGPU + raw YUV 修复记录](webgpu-color-pipeline-status.md) 续接。默认路径与当前验收以新记录为准。

**Not ready for default playback.** Keeping native frames on the GPU improves probe
throughput, but common browser import does not deliver native/WASM color parity,
and WebKit lacks required memory-frame formats.

Base Web commit: 3391207; core: 1ba3ef85088797ed37133e19580bbd05805bde9f.
Machine: Apple M5. Headed Chrome 151.0.7922.174 and Playwright WebKit 26.6.
This is not system Safari, Windows/Edge, or physical-display validation.

## Implementation

- Native packet media retains its VideoFrame without application plane readback.
- WASM original YUV becomes a VideoFrame with resource color tags (explicit inferred
  defaults only when missing). No bit-depth truncation or per-file correction.
- `external`: importExternalTexture(sRGB), common WGSL, sRGB canvas.
- `copy`: copyExternalImageToTexture(sRGB), then a regular texture shader.
- `strict`: throughput control using existing YUV preparation and WebGL presenter.
- WebGPU canvases share one GPUDevice. Each retains one frame clone for capture;
  replacement/disposal close resources. Only explicit capture maps a readback buffer.
- `nativeColorMode: 'browser'` is an opt-in dependency on packet media. The default
  application path remains unchanged. The new renderer is diagnostic-only.

Viewport transforms, application rotation/SAR, session capture, ordinary mediabunny
native input, and device recovery are not integrated. Unsupported layouts report errors.

## Color isolation

Source-sized sRGB captures, same source PTS/dimensions. MAE is average absolute RGB
byte difference. The 4K fixture is a video-packet remux of
mhw_hevc_fullrange_bt709_3s.mp4 to FLV without re-encoding.

| Browser | Fixture | external MAE at 0s / 1s | max channel difference |
| --- | --- | --- | --- |
| Chrome | enhanced-hevc.flv | 5.7018 / 6.0083 | 92 / 90 |
| Chrome | standard-h264.flv | 2.4350 / 2.8100 | 170 / 179 |
| Chrome | webgpu-hevc-4k.flv | 6.2706 / 5.3057 | 87 / 105 |
| WebKit | enhanced-hevc.flv | 0.6642 / 0.6662 | 26 / 26 |
| WebKit | standard-h264.flv | 8.6278 / 8.5149 | 45 / 42 |
| WebKit | webgpu-hevc-4k.flv | 0.7513 / 0.6957 | 26 / 25 |

- Chrome: all original YUV code samples match WASM at both times for all three
  fixtures (3,110,400 samples/frame for 1080p; 12,441,600 for 4K). Native resource ->
  copyTo -> reconstruct with retained color plan -> WebGPU matches WASM WebGPU
  exactly, while direct native import differs. This localizes the divergence to
  resource/import behavior in this environment, not differing decoded source codes.
- WebKit: native copied YUV already differs from WASM (max code delta 16–19 here),
  along with resource tags. Range/transfer conversion can legitimately change codes;
  this alone does not establish a decoder defect. Further numeric isolation is needed.
- A diagnostic BT.709 inverse-OETF -> sRGB transform on the quantized strict RGB
  reference did not explain Chrome HEVC differences (MAE about 9.6). It is not applied
  to rendering. No gamma/channel compensation is justified by these measurements.
- GPU-copy mode does not fix Chrome HEVC/H.264 differences. WebKit HEVC MAE becomes
  about 0.89/0.86 and H.264 10.67/10.86; that alternative also fails parity.

## Format support

60 synthetic cases: I420/I422/I444 at 8/10/12 bits and NV12 at 8 bits, each with
601/709/2020 matrices and full/limited range. This is a support/measurement probe,
not a declaration that every accepted output is color-accurate.

- Chrome constructs/renders all 60; no GPU validation errors were reported.
- WebKit accepts 12 (8-bit I420/NV12), rejects 48 (I422/I444 and 10/12-bit).
- Some accepted high-depth/subsampled cases differ from the strict reference.
  External-texture chroma sampling and conversion are browser-managed.
- 9/14/16-bit and shifted P010 are explicitly outside the VideoFrame adapter.
  Therefore this cannot replace the current WASM plane renderer's format coverage.

## Throughput, not session playback

Three repetitions; 60 sequential frames per source; 640x360 canvas; GPU completion
awaited every three iterations. Includes source/cache/decoder and render behavior;
it is not cold-decode throughput, requestAnimationFrame pacing, or physical scanout.
Numbers are median frames/second **per source** (dual aggregate divided by two).
Dual runs use the same HEVC clip through native and WASM, NOT the previous
VVC-1080p + native-HEVC-4K session scene. WebGL/WebGPU GPU-drain APIs also differ.
These results identify architectural costs, not a performance SLA.

| Browser | Fixture | Mode | native solo | WASM solo | dual per source |
| --- | --- | --- | ---: | ---: | ---: |
| Chrome | enhanced-hevc.flv | strict | 95.1 | 84.2 | 41.5 |
| Chrome | webgpu-hevc-4k.flv | strict | 26.2 | 23.1 | 12.2 |
| Chrome | enhanced-hevc.flv | external | 2264.2 | 81.7 | 76.0 |
| Chrome | webgpu-hevc-4k.flv | external | 688.1 | 30.5 | 28.4 |
| WebKit | enhanced-hevc.flv | strict | 100.5 | 74.4 | 44.8 |
| WebKit | webgpu-hevc-4k.flv | strict | 26.2 | 22.1 | 12.4 |
| WebKit | enhanced-hevc.flv | external | 1250.0 | 80.0 | 74.2 |
| WebKit | webgpu-hevc-4k.flv | external | 438.0 | 30.4 | 28.8 |

## Reproduce

```sh
ffmpeg -v error -i fixtures/video/mhw_hevc_fullrange_bt709_3s.mp4 -map 0:v:0 -c:v copy -an -f flv artifacts/color/webgpu-hevc-4k.flv
PROBE_OUT=artifacts/color/webgpu-external-chrome-final node scripts/diagnose-webgpu-color.mjs fixtures/flv/enhanced-hevc.flv fixtures/flv/standard-h264.flv artifacts/color/webgpu-hevc-4k.flv
PROBE_BROWSER=webkit PROBE_OUT=artifacts/color/webgpu-external-webkit-final node scripts/diagnose-webgpu-color.mjs fixtures/flv/enhanced-hevc.flv fixtures/flv/standard-h264.flv artifacts/color/webgpu-hevc-4k.flv
PROBE_GPU_MODE=strict PROBE_OUT=artifacts/color/webgpu-strict-chrome node scripts/diagnose-webgpu-color.mjs fixtures/flv/enhanced-hevc.flv artifacts/color/webgpu-hevc-4k.flv
```

Use PROBE_GPU_MODE=copy for the GPU-copy alternative and PROBE_SKIP_THROUGHPUT=1 for
color isolation only. WebKit capability failures produce exit code 1, with the report
still written. Zero exit means collection succeeded, not pixel parity: inspect
summary.identicalPairs and each pair. Reports identify browser/build and newer reports
include OS/probe-script digest. Earlier exploratory reports lack the script digest.
The final color table uses webgpu-raw-{chrome,webkit}; throughput uses the final
external and strict reports named above. Reports, media and logs remain gitignored/local.

## Validation and next gate

- npm test: 372/372 passed.
- npm run build: passed.
- New probe modules pass Node syntax checks.
- npm run test:presentation:browser: Chromium/WebKit passed, including 57 YUV
  reference cases per browser and existing native/RGBA/PQ/HLG regressions.
- Chrome/WebKit probes run, but color parity fails and WebKit rejects 48 format cases.
- Existing default-player presentation and playback regression results follow below.

Next experiment should retain native GPU resources and upload WASM planes directly,
with explicit range/matrix/transfer/chroma math. It must test the actual browser import
boundary against that math, rather than assume matching tags mean matching output.
This addresses VideoFrame constructor coverage but does not by itself guarantee parity
with opaque native conversion. No default-player migration is justified yet.

Existing default WebGL/YUV player, headed WebKit, one 4-second run per scene:

| Scene | speed | Passed |
| --- | ---: | --- |
| hevc-4k-solo | 0.97 | True |
| vvc-wasm-solo | 0.985 | True |
| vvc+hevc-4k | 0.507 | False |
| mpeg2ts+h264 | 0.998 | True |

This still exercises the prior default path, not the new WebGPU renderer. Its known
4K dual-track failure remains; no claim of a complete playback fix is made.
