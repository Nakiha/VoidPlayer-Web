# SDR software/native color evidence

This branch collects evidence before changing color conversion. It does not
implement a new rendering policy. The production decoder, presenter and WASM
core remain unchanged. Run on the Windows machine/browser exhibiting the issue,
with the same original files; another machine's result does not establish parity.

## Run locally

Requires Node 24+, `npm ci`, the pinned core files in
`public/vendor/voidplayer-core/` (use `scripts/sync-wasm-core.sh` or copy the
matching release's core), and Chrome/Edge. `ffprobe` on PATH is optional but
strongly preferred to collect independent decoded-frame tags. Run from repo root:

```powershell
node scripts/diagnose-sdr-color.mjs --channel msedge --out color-evidence --times-us 0,1000000 "D:\media\uhd5.flv" "D:\media\Third0T200uhd6.flv"
```

Use `--channel chrome` for installed Chrome. Without a channel, Playwright's
bundled Chromium must be installed; its HEVC availability may differ from Edge.
Default is headed. `--headless` is available, but label it as a different device
path from the user's interactive session. Choose steady scenes and extend times
only as needed (maximum eight positions and four files).

The local Vite server binds only 127.0.0.1. The file input gives the real Blob to
the application's FLV reader; the video is not uploaded. Reports remain in the
chosen local directory. `--images` explicitly opts into PNG captures in that
directory; inspect them before forwarding. Reports contain filenames, browser
details and codec metadata and may include error paths; redact private values.

## What is measured

- Git/build/core identifiers, actual browser version, secure context and
  cross-origin isolation; file size/mtime before and after the run.
- Independent FFprobe stream and first decoded-frame tags, when available.
- Same FLV through automatic native attempt and forced WASM packet decoding.
  Native fallback to WASM is **unavailable**, never a successful parity result.
  `webcodecs` and hardware acceleration preferences do not prove GPU execution.
- Requested versus actual source PTS, dimensions, actual frame descriptions,
  source color tags and the production presenter's conversion policy.
- A bounded page of local diagnostic events (capability probes, fallback reasons
  and presentation decisions). The current core ABI exposes source frame tags,
  not the actual swscale coefficient table; these tags alone do not prove the
  effective conversion parameters. That boundary remains a follow-up probe if
  the native/WASM comparison implicates conversion.
- Source-sized presenter capture in sRGB byte values, without diagnostic resize,
  exposure changes, retagging, or a second color-correction shader.
- RGB mean/min/max, exact 0/255 populations, RGB MAE/RMSE, maximum difference,
  differing pixels and signed mean channel differences (WASM minus native).

Comparisons require matching actual source PTS and dimensions within the same
file and exclude detected HDR. Metrics are evidence, not pass/fail color grading;
unknown tags remain unknown. Hardware implementations can have small rounding
differences. Capture excludes OS/ICC/display composition. A failed launch or
decoder/capture failure remains visible in `report.json`.

At most three captures (native direct, native Canvas, WASM) are retained for one requested time; captures
over 16M pixels are rejected. This is an explicit diagnostic, not a per-frame
playback logger. Pauses/seeks are exercised; continuous-playback parity and
full native/WASM GPU resource accounting remain separate validation work.

## Interpreting the evidence

Schema 2 adds isolation within the same decoded frame:

| Field | A → B, signed difference is B minus A | Purpose |
| --- | --- | --- |
| `nativeToWasm` | Native production presenter → WASM production presenter | Existing same-file backend comparison |
| `nativeDirectToCanvas` | Native WebGL upload → native sRGB Canvas 2D | Same VideoSample, no additional seek/decode; isolate the browser presentation entry |
| `nativeCanvasToWasm` | Native sRGB Canvas → WASM production presenter | Determine whether a shared browser presentation entry changes the observed gap |
| `wasmInputToPresenter` | Decoded RGBA bytes → captured production output | Check byte upload/capture independently of YUV conversion |

`nativeDirectToCanvas` is omitted if WebGL was unavailable. Native/WASM
comparisons still require matching actual PTS/dimensions and no detected HDR.
The Canvas probe uses the existing presenter without a WebGL surface; it does
not replace the production path or alter tags. Optional PNGs include a
`native-canvas` image. `pixelsOver2` and `pixelsOver8` count pixels whose maximum
RGB-channel difference exceeds those code-value thresholds; they supplement the
exact-equality count, not perceptual visibility or color-accuracy claims.

If native direct and native Canvas differ while Canvas and WASM agree much more
closely, investigate the browser import/conversion boundary first. If native
direct and Canvas agree, investigate decoded samples and swscale conversion.
If WASM input and captured output differ, inspect upload/capture before blaming
YUV conversion. None of these comparisons alone establishes which image is
correct; that needs a declared conversion target and independent reference.

### First field report (Edge 152, two SDR files)

The supplied summary reports HEVC native/WASM MAE 1.69 and 1.97 at two times,
with signed blue differences about -2.5 and -2.3. It reports native NV12 tagged
BT.709 limited, while WASM source matrix/transfer/primaries are unknown and
source range is explicitly limited. VVC has only a WASM capture. This is
evidence of a backend-dependent difference for those HEVC captures; it does not
prove rounding, chroma interpolation, or a particular matrix error.

- Unknown source tags do not mean swscale uses no matrix: the pinned core
  `c0d3c369` chooses BT.709 for an unspecified matrix when height >=720.
  Thus the reported 1080x1920 HEVC already has an effective BT.709 fallback.
- Limited YUV becoming full-range RGB is expected after range expansion;
  `matrix=rgb, fullRange=true` on RGBA is not itself an erroneous relabel.
- VVC lacking native support prevents a VVC same-codec backend comparison. It
  does **not** eliminate the backend difference from the user's HEVC-native vs
  VVC-WASM viewing comparison.
- ffprobe stream/frame output is not an independent SPS/VUI bit parser, and
  WebCodecs/NV12 alone does not prove hardware execution.
- A near-100% nonidentical-pixel count can arise from one-code-value differences;
  two-frame MAE cannot establish either perceptual invisibility or whole-file
  color correctness. Do not compensate the blue channel with a constant offset.

1. Compare the **same HEVC file** between native and WASM. If it differs, first
   inspect per-frame range/matrix/transfer/primaries, then pixel differences.
2. Compare HEVC and VVC FFprobe/frame metadata. Equal filenames or apparent scenes
   do not establish equal decoded pixels or equal color signalling.
3. If HEVC matches across backends but VVC differs, compare source YUV and VVC
   metadata before changing the renderer. This harness does not auto-score
   different encoded files as a hardware/software parity test.
4. Range-related errors often affect black/white levels; matrix errors affect
   colored areas. These appearances are clues, not proof. Do not apply a
   brightness or saturation patch based only on screenshots.

## Refactoring decision

The current WASM path applies a swscale YUV matrix/range conversion before
delivering RGBA8; native frames use browser conversion. This split is established
by source inspection, but the cause of a particular SDR discrepancy requires
the evidence above. Metadata resolution and conversion provenance should become
one explicit contract regardless of which renderer is chosen.

If evidence implicates the conversion split, prototype retained YUV/bit depth
from WASM and tagged VideoFrame construction through the same presentation path.
Capability-test pixel layouts and validate reference patterns before choosing it.
Opaque hardware resources mean a native Metal design cannot simply be copied into
WebGL. A deterministic custom high-precision renderer is a separate, larger
decision; this diagnostic does not assume it is already required.

References: [existing Web contract](color-pipeline.md),
[native contract](https://github.com/Nakiha/VoidPlayer/blob/881eb5ccd706c33aa1ff35ab3a67ac3a226ccfba/native/docs/COLOR_PIPELINE.md).

## ABI v2 / 统一 SDR 平面取证

报告 schema 3 中，`policy.conversion=unified-yuv-sdr` 表示可控 YUV 路径。
`description.yuv` 是实际布局，`policy.plan` 记录解析后的颜色、字段来源和显示参照 SDR 约定。
`copyMs` 单独记录平面读取耗时，不放入逐帧元数据（避免触发不必要的 UI/日志更新）。
`shaderToCpuReference` 比较最终 shader 像素和独立 CPU 参考；原 `wasmInputToPresenter`
只适用于旧 RGBA 回退，不能把 YUV 字节直接当 RGBA 比较。
`nativeCanvas` 保留同一个 VideoSample 的浏览器托管基准，和可控 YUV 结果分开标识。

新增 `--browser webkit`（不能和 `--channel` 同用），用于 Playwright WebKit 本机回归，
不能把它称为系统 Safari。Chrome 使用 `--channel chrome`，默认 headed。

播放基准支持 `BENCH_CHANNEL=chrome`。`presentationSurfaces` 包含实际 CPU/GPU 执行位置，
以及最近最多 256 帧的 copy/CPU submission p50、p95、max（每 32 帧更新一次）。
submission 不是 GPU 完成时间或物理屏幕扫描时间；数值不能证明硬件零拷贝。
