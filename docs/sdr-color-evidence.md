# SDR software/native color evidence

This opt-in diagnostic measures the production FLV decoder and presenter without
changing color tags or uploading media. Use the machine/browser exhibiting the
issue and the same original files; another machine's result does not establish
parity. The current rendering policy is defined in [the color contract](color-pipeline.md).

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
  and presentation decisions). Source tags alone do not prove the effective conversion parameters;
  inspect the actual resource layout and resolved presentation plan. RGBA
  fallback does not expose swscale's coefficient table through source tags.
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

### Diagnostic limits

Compare the same file, PTS and decoded dimensions before interpreting a backend
difference. Unknown tags do not mean no conversion occurred, and full-range RGB
after limited-range YUV expansion is expected. FFprobe is not an independent
SPS/VUI bit parser. Missing native VVC support prevents a same-codec native/WASM
comparison; a HEVC/VVC pair must not be auto-scored as backend parity.

A near-100% nonidentical-pixel count can arise from one-code-value differences.
Neither a small two-frame mean error nor a screenshot proves whole-file color
correctness. Do not add per-channel offsets or infer range from filenames.
The former RGBA-only refactoring proposal is superseded by the current
[color contract](color-pipeline.md); old field observations remain in
[Git history](https://github.com/Nakiha/VoidPlayer-Web/blob/1d94ddb81be4800d60a852b4c210a494bfedead4/docs/sdr-color-evidence.md).

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
