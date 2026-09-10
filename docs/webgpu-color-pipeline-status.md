# WebGPU 色彩与性能修复：2026-09-10

当前分支为 `codex/unified-color-pipeline`。这是 Mac 上已验证的实现，尚未合并主线；Windows/Edge、系统 Safari 和 HDR/EDR 不在本次验证结论内。

## 实现与根因

WebCodecs 保留原生 VideoFrame，经 external texture 在 GPU 上转换；WASM 保留 ABI v2 原精度 YUV，上传 storage buffer 后在 WGSL 中转换。两者共用 GPUDevice、视口几何和 RGB 采样规则。播放不对原生用户帧执行 copyTo 或 GPU readback，也不把 WASM 包装为浏览器 memory VideoFrame，因此不受 WebKit 的 I422/I444/高位深构造限制。

相同公开标签不保证相同浏览器资源转换。Chrome/macOS 的原生 CoreVideo BT.709 使用 Apple 1.961 gamma，而普通内存帧的 BT.709 使用 sRGB-like 约定。Chromium 的 [color_space.cc](https://chromium.googlesource.com/chromium/src/+/main/ui/gfx/color_space.cc) 明确区分 BT709_APPLE；[VideoToolbox 转换器](https://chromium.googlesource.com/chromium/src/+/main/media/gpu/mac/video_toolbox_frame_converter.cc) 从 ImageBuffer 取得实际色彩空间。WGSL Apple profile 使用该命名传递函数，以及 D65 下 SMPTE-C/BT470BG 到 BT.709 的基色矩阵；矩阵前保留带符号的扩展 RGB，避免饱和色边缘提前裁剪。

本机 WebKit 原生 8-bit 资源另有 limited→full 重量化及色度中心约定。CV profile 对 WASM 8-bit 平面复现这一级资源转换，保留实测最多 3 码值的剩余量化误差。高位深平面不套用 8-bit 重量化。安装版的行为不能由 WebKit main 当前源码代替；不得将这个 profile 宣称为所有 WebKit 版本的固定规则。

启动时解码内嵌的、独立 FFmpeg 校验过的中性渐变，验证有限的 Apple / sRGB / CV 资源 profile；不采样用户媒体、不拟合曲线、不按 UA、片名或 codec 打补丁。探针失败或 WebGPU 不可用时保留原路径。中性探针只证明所采集的资源约定，不证明所有 codec/profile 都一致；下述同帧测试补充了 H264 与 HEVC 的实际证据。

## 同帧结果

Apple M5，macOS 27.0，Chrome 151.0.7922.174、Playwright WebKit 26.6，有窗口。三份本地 FLV：320×180 H264、1920×1080 HEVC、3840×2160 HEVC，各取实际 PTS 2s/3s。比较 sRGB GPU 读回 RGB，包含完整源尺寸及 640×360 视口，非物理显示器扫描输出。

| 浏览器 | 源尺寸 MAE（0–255） | 源尺寸最大绝对差 | 视口最大绝对差 |
| --- | --- | --- | --- |
| Chrome | 0–0.000065 | 1 | 1 |
| WebKit | 0.0727–0.2594 | 3 | 3 |

Chrome 原始 YUV 码值两路完全相同。WebKit 原生已做资源转换，不能拿资源码值与源标签混为一谈。旧 memory-VideoFrame 实验中 Chrome 的 MAE 5.7–6.0 已消除；WebKit 剩余误差明确保留，未添加逐通道偏移。

两浏览器各 60 个合成布局/矩阵/range/位深组合均可执行。该计数验证资源可执行及端点，不等于 60 组全部通过原生解码色彩一致性认证；独立旧 SDR shader 参考采用不同观看约定，不能当作 Apple profile 的像素真值。

本地取证：`artifacts/color/webgpu-final-{chrome,webkit}-color/report.json`；最终带显式误差门限的复跑 `webgpu-accepted-{chrome,webkit}-color/report.json` 同样通过（各 6 对帧，包含视口）。原始像素和媒体不提交、不上传。

## 性能与调度

真实应用 `benchmark_review`，四场景各连续三轮，默认 8 秒或片尾，不放宽原验收阈值。WebKit 长序列中即使页面 visible/focused，rAF 仍会降至 3–5 Hz；暂停后的独立 rAF 探针也复现，GPU 提交耗时约 1–5 ms。单独跑双轨通过不能替代完整序列验收。

会话播放循环现在在可见页面用 20 ms timer 与 rAF 竞争，先到者执行且取消另一个；暂停不保留 timer，隐藏页面不加 watchdog。它保证播放推进与画布提交，不能保证物理屏幕 60 Hz。没有改变解码选择或基准速度门限。

最终有窗口基准，两浏览器分别 **12/12 通过**，正常 URL 自动 profile，四场景各三轮：

| 场景 | Chrome 速度范围 | WebKit 速度范围 |
| --- | --- | --- |
| HEVC 4K 单轨 | 0.9852–0.9871 | 0.9839–0.9865 |
| VVC WASM 单轨 | 0.9890–0.9901 | 0.9899–0.9920 |
| VVC + HEVC 4K | 0.9883–0.9885 | 0.9896–0.9912 |
| MPEG2 TS + H264 | 0.9981–0.9985 | 0.9978–0.9999 |

速度为媒体推进时间 / 墙钟时间；默认 8 秒，短片到片尾提前结束。速度、帧间隔、双轨 skew、暂停边界均沿用原门限。此前 strict CPU 平面读取双轨速度 Chrome 0.399、WebKit 0.509；新路径在本机恢复接近实时播放。这里不宣称每个源帧均显示或硬件解码已独立证实。

本地完整报告：`artifacts/color/webgpu-final-chrome-bench.json`、`artifacts/color/webgpu-final-webkit-bench.json`。基准构建 sourceDigest 为 `a47f7dbb28768096874ad4e32706e98d0785c0185c9fc45f91123e34efba03cb`；之后只补充 bfcache pagehide 生命周期保护、注释和测试/文档，无播放热路径变更。

## 验证与复跑

- `npm test`：374 项通过，含真实 single/mt WASM。
- `npm run build`。
- `npm run test:webgpu:browser`：两浏览器自动探针、帧 clone 所有权、按需同步截图、四旋转、暂停缩放、10 个高位深/对齐/布局用例、RGBA 回退/重新进入和释放。
- `npm run test:presentation:browser`：两浏览器原路径、PQ/HLG 以及各 57 个 YUV 参考用例。
- `npm run test:browser`：应用轨道、加载、尺寸、恢复回归。
- `BASE_URL=http://127.0.0.1:5190 BENCH_CHANNEL=chrome node scripts/bench-playback.mjs chromium`，然后相同 BASE_URL 跑 `webkit`；各三轮，顺序运行，避免并发性能干扰。
- `PROBE_MAX_COLOR_ERROR=1 PROBE_GPU_MODE=hybrid PROBE_SKIP_THROUGHPUT=1 PROBE_OUT=artifacts/color/check-chrome node scripts/diagnose-webgpu-color.mjs <H264.flv> <HEVC.flv> <4K-HEVC.flv>`；WebKit 增加 `PROBE_BROWSER=webkit` 并使用 `PROBE_GPU_MODE=webkit-planes PROBE_MAX_COLOR_ERROR=3`。

正常 URL 自动验证后启用；`?colorPipeline=legacy` 用于旧路径对照。显式 `webgpu-apple709` / `webgpu-cv-full-range` 仅用于诊断，不应代替未知平台的验证。GPU 丢失、资源超限、导入失败、RGBA/HDR 回到已有 presenter 路径；回退槽位在清空后重新尝试。暂停时 GPU 丢失仍需要重新 seek，不承诺恢复失效设备的帧。

历史：[CPU 统一路径记录](unified-color-pipeline-status.md)、[memory VideoFrame 实验](webgpu-color-experiment.md)。core pin 仍为 `1ba3ef85088797ed37133e19580bbd05805bde9f`，本轮未改变 core。
