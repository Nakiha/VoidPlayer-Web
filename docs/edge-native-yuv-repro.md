# Edge native HEVC YUV conversion: local issue draft

Status: reproduced locally; not submitted. This reproduction contains generated color patches only, no user media or application code.

## Reproduction

Prerequisites: Node, project npm dependencies (Playwright), ffmpeg on PATH, and Edge/Chrome on Windows.

```powershell
# Optional when using downloaded Chrome for Testing:
$env:CHROME_EXECUTABLE_PATH = (Resolve-Path artifacts/browsers/chrome-win64/chrome.exe).Path
npm run repro:color:native -- chrome msedge
```

The command creates `artifacts/color/native-yuv-repro/index.html`, an independently runnable HTML file with embedded Annex B streams and independently decoded I420 references. Serve that directory on localhost, open the page, and click Run. It needs no player, demuxer, WASM, Vite, calibration, or network service beyond static localhost hosting. The runner saves JSON measurements and CDP `CreateExternalTexture` events alongside it. Exit 0 means all supported cases were measured, **not** that color parity passed; the existing Windows acceptance test retains its failure thresholds.

Four single-frame 192×144 fixtures cover H264/HEVC and BT709/SMPTE170M matrices. Primaries and transfer are BT709, range limited. Both stream metadata and decoder configuration specify these tags. Twelve patches include neutral and colored interiors; comparisons exclude 8 pixels around each patch boundary to avoid chroma reconstruction differences. Each measurement covers 36,864 RGB channel samples.

For each supported decoder preference:

1. Decode one Annex B key frame using WebCodecs.
2. Copy its YUV bytes and compare them with independent FFmpeg decoding.
3. Construct a memory-backed VideoFrame from those exact bytes and the original frame's exposed colorSpace, retaining the copied plane layout. The copied visible rectangle determines the new coded size, avoiding decoder padding.
4. Render original and reconstructed frames using the same minimal WebGPU external-texture shader into RGBA8, then read pixels. Also record Canvas2D and native-clone controls.
5. Compare against explicit standard limited-range BT709 and BT601 matrix equations. No coefficients are fitted.

## Observed on 2026-09-10

Windows build 26200; NVIDIA RTX 5080; driver 32.0.16.1664. Chrome for Testing 153.0.8010.36 versus Edge 152.0.4191.66. HDR was previously disabled by the user. Hardware preference is requested via WebCodecs; it is not an independently verified decoder implementation name.

| Hardware-preferred fixture | Browser | Native vs memory WebGPU max | Native vs BT709 max | Native vs BT601 max |
| --- | --- | ---: | ---: | ---: |
| H264 BT709 control | Chrome / Edge | 0 / 0 | 1 / 1 | 23 / 23 |
| HEVC BT709 | Chrome | 0 | 1 | 23 |
| HEVC BT709 | Edge | **23** | **23** | **1** |
| HEVC SMPTE170M | Chrome | 0 | 21 | 0 |
| HEVC SMPTE170M | Edge | **21** | 21 | 0 |

All 12 supported cases have native YUV bytes exactly equal to FFmpeg reference (41,472 samples each), and native Canvas clone comparisons are exactly equal. All native Canvas vs WebGPU interior comparisons are also exactly equal. HEVC software-preferred configurations are unsupported on both browsers and reported as such. H264 software-preferred controls have WebGPU native/memory difference 0.

For HEVC BT709, both original and reconstructed exposed tags are BT709/BT709/BT709/limited. Edge nevertheless produces different RGB from identical YUV bytes; the reconstructed frame follows BT709 within 1 code value, whereas the original follows BT601 within 1.

For HEVC SMPTE170M, Edge additionally reports native matrix BT709 despite the input/config matrix SMPTE170M; Chrome reports SMPTE170M. The reconstruction deliberately preserves Edge's reported BT709, so this second case tests metadata consistency rather than expecting reconstructed RGB to match the stream's intended matrix.

Canvas rendering of memory-backed NV12 exhibits separate differences (up to 7 in BT709 controls on both browsers). This is recorded, not used as the reference. The principal backing comparison uses identical WebGPU rendering.

## Source investigation and remaining uncertainty

At Chromium tag 153.0.8010.36, `PaintCanvasVideoRenderer::CopyVideoFrameToSharedImage` copies a SharedImage without passing a separate VideoFrame color space to the raster copy command. `CopySharedImageHelper` creates an SkImage from the source representation; the Ganesh `CreateSkImage` path chooses its YUV matrix from the **SharedImage representation's** color space and initializes the fallback to BT601. The copy subsequently reinterprets RGB color space to disable an additional RGB color conversion.

Sources:

- [Video frame copy](https://github.com/chromium/chromium/blob/153.0.8010.36/media/renderers/paint_canvas_video_renderer.cc)
- [Shared image copy](https://github.com/chromium/chromium/blob/153.0.8010.36/gpu/command_buffer/service/copy_shared_image_helper.cc)
- [Ganesh YUV image creation](https://github.com/chromium/chromium/blob/153.0.8010.36/gpu/command_buffer/service/shared_image/shared_image_representation.cc)

Runtime trace reports zero_copy=false and different OPAQUE versus OWNED_MEMORY storage for these paired external textures. It exposes VideoFrame color metadata, but **does not expose the underlying SharedImage color space**. Therefore a missing/different SharedImage matrix is a plausible cause, not a proven execution trace. The inspected upstream version also differs from installed Edge; this does not establish the exact Edge source or driver fault.

Suggested browser-side investigation: log VideoFrame and SharedImage color spaces together at decoder output/wrapping, then log the resolved SkYUVColorSpace at image creation. Check whether Edge's HEVC backing loses or overrides matrix metadata before raster copying. An application-side brand-specific BT601 compensation is not justified by this evidence.

## GPU entrance experiments

The reproduction also tests three alternative entrances, all ending in an RGBA8 WebGPU texture: `copyExternalImageToTexture(VideoFrame)`, `createImageBitmap(VideoFrame)` followed by that copy, and Canvas2D drawing followed by that copy. CPU pixel readback is used only to measure the final output; none of these alternatives feeds readback data into rendering. This does not prove their browser internals are zero-copy or entirely GPU-resident.

On the same HEVC BT709 fixture, all three outputs match the original external-texture output exactly in patch interiors. Chrome's maximum error against BT709 is 1; Edge's is 23 and against BT601 is 1. Therefore none is an effective color workaround here. No performance claim or production routing change was made for these unsuccessful candidates.

This is consistent with the [WebGPU color-space contract](https://gpuweb.github.io/gpuweb/#color-spaces): both import and external-image copy are browser color-conversion boundaries; changing the entrance does not grant direct access to native YUV planes.
