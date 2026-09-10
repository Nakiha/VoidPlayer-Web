# 统一 SDR 色彩管线：Mac 实现与验证状态

> 历史阶段记录：以下结论对应 CPU / memory-VideoFrame 实验，已由 [原生 WebGPU + raw YUV 修复记录](webgpu-color-pipeline-status.md) 续接。默认路径与当前验收以新记录为准。

状态：**实验分支，颜色验证有进展，性能验收未通过，不应直接合并主线。**

## 代码来源

- Web 分支：`codex/unified-color-pipeline`，从 `origin/codex/sdr-color-evidence` 的 `ce5c9c7` 建立独立 worktree。
- Flutter/native 参考：本机 `VoidPlayer`，`881eb5ccd706c33aa1ff35ab3a67ac3a226ccfba`；已 fetch 核对。
- core：`1ba3ef85088797ed37133e19580bbd05805bde9f`，已推送到 core 仓库同名分支，Web pin 已更新。
- Emscripten 6.0.9，FFmpeg `bf1b838f2ab88b4f8fd83443325c782ea0e0f7fa`。single/mt 从 core worktree 构建，复用固定版本的本地 FFmpeg/dav1d 构建目录。
- 原工作目录的四个未提交修改保持原样。没有合并、部署或改动本机常驻服务。

## 已实现

原精度 YUV ABI v2、packet/container 共用读取、WebCodecs 可读平面适配、独立颜色解析/CPU 参考、共同 WebGL shader、截图与旋转/裁剪/缩放一致性、显式托管/旧 RGBA 回退。

正常 WebCodecs 复制后释放原生 sample，复用每源一个有上限的缓冲。统计不进入逐帧元数据；转换计划只在状态变化时写本地日志。
实际契约见 [color-pipeline.md](color-pipeline.md)。没有搬运 native 历史 `−1/255` 偏移或添加通道补偿。

## 同帧证据

机器：Apple M5，macOS 27.0 (26A5421a)。Chrome 151.0.7922.174，Playwright WebKit 26.6，headed。
取证对象为本机 `fixtures/flv/enhanced-hevc.flv`，1920×1080，实际源 PTS 2s/3s（相对 0s/1s）。
采集 sRGB 源尺寸字节，DPR 1；不是显示器最终扫描输出，也不证明实际硬件执行。

| 浏览器/版本 | 相对 0s MAE | 相对 1s MAE | 说明 |
| --- | ---: | ---: | --- |
| Chrome，改前 | 2.1141 | 2.1195 | swscale RGBA 与浏览器导入不同 |
| Chrome，共同 YUV | 0 | 0 | 两条路径 resolved plan 相同，两个时刻逐像素相同 |
| WebKit，共同 YUV | 0.4100 | 0.3998 | resolved plan 不同，最大单通道差 25，不能声称一致 |

WebKit 原生资源为 full range / sRGB transfer，而 WASM 为源 limited / BT.709；本轮遵守资源标签，不把源标签强贴到已经变化的资源。
两侧 shader 与各自 CPU 参考符合最多 1 个码值的预算。WebKit 的剩余差异需进一步隔离资源数值/平台转换，不能按文件补偿。
未找到交接中的 `uhd5.flv` / `Third0T200uhd6.flv` 原片；用户 Windows/Edge 152 的最终取证仍未完成。

## 验证

- `npm test`：372/372 通过。包含 single/mt 对独立 FFmpeg raw decode 的一致性，HEVC/VVC、FFV1 8/10 位、奇数尺寸 16 位/SAR，seek/reset 与 heap growth。
- `npm run build`：通过。
- `npm run test:presentation:browser`：Chromium/WebKit 各 57 组 YUV 参考用例通过，包含 viewport 最终像素、CPU 回退、context loss 后新帧、旋转、高位深；旧 PQ/HLG 回归通过。
- `npm run test:browser`：WebKit 轨道、尺寸调度、恢复和 UI 回归通过。

## 连续播放：未通过

同机同样片，headed，单次 4 秒（短片到尾），没有改门槛。speed 为媒体时间/墙钟时间，原门槛 0.9。
这是可复跑的短测，不是统计稳定的性能 SLA。详细报告记录实际构建 sourceDigest、WASM SHA256、队列峰值及 copy/submission 耗时。

| 场景 | WebKit 改前 → 改后 speed | Chrome 改前 → 改后 speed |
| --- | --- | --- |
| HEVC 4K 单轨 | 0.986 → 0.971 | 0.995 → 0.886 |
| VVC 1080p 单轨 | 0.985 → 0.985 | 0.979 → 0.978 |
| VVC + HEVC 4K 双轨 | 0.984 → 0.509 | 0.975 → 0.399 |
| MPEG-2 TS + H.264 双轨 | 0.996 → 0.998 | 0.997 → 0.943 |

共同平面路径的 4K 双轨明显慢于原生托管快路径；Chrome 的 4K 单轨也低于实时门槛。当前分支不能作为“性能无回归”的最终修复。
已经验证纹理复用、查询缓存、紧凑 UV 上传、按源像素按需转换、原生资源提前关闭与 CPU 缓冲复用；这些没有消除双轨退化。
下一步需要继续隔离浏览器复制/解码/GPU 调度的总吞吐，或设计明确的颜色一致性与托管快速路径策略，不能静默降成软解或宣称仍是同一确定性路径。
没有 8K、系统 Safari、Windows/Edge 的最终运行证据。

## 本地复跑与产物

全部报告留在 worktree 的 `artifacts/color/`（gitignored），没有自动上传诊断日志、图像或片源：

- `before/report.json`、`after/report.json`：Chrome 同帧前后。
- `webkit/report.json`：WebKit 同帧与 resolved plan 差异。
- `bench-{webkit,chrome}-{before,after}.json`：短播放基准。

```sh
node scripts/diagnose-sdr-color.mjs --channel chrome --out artifacts/color/after fixtures/flv/enhanced-hevc.flv
node scripts/diagnose-sdr-color.mjs --browser webkit --out artifacts/color/webkit fixtures/flv/enhanced-hevc.flv
npm run serve -- --port 5190 --folder fixtures/video --no-logs
BASE_URL=http://127.0.0.1:5190 BENCH_REPEATS=1 BENCH_DURATION_MS=4000 node scripts/bench-playback.mjs webkit
BASE_URL=http://127.0.0.1:5190 BENCH_CHANNEL=chrome BENCH_REPEATS=1 BENCH_DURATION_MS=4000 node scripts/bench-playback.mjs chromium
```

## WebGPU 后续实验（2026-09-10）

见 [webgpu-color-experiment.md](webgpu-color-experiment.md)：已实测原生外部纹理、GPU 复制及严格 YUV 对照。保留原生 GPU 资源显著提高探针吞吐，但颜色一致性和 WebKit 格式覆盖未通过，仍未接入默认播放器。
