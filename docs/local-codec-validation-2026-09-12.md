# 本机多编码验证 · 2026-09-12

测试片直接读取自 `/Users/zhuhongwei/Documents/yorune/VoidPlayer/resources/video`。本轮不修改媒体文件或应用解码代码。

## 结果

- 12 个样片 × 2 个浏览器 × 3 种设置，共 **72/72 通过载入及前后定位**；无页面异常。
- 66 个组合进行了 1.5 秒播放检查，首次 **65/66 通过**；1 秒的 H.264 4:2:2 样片只检查解码和定位，共 6 组，未将其记为性能通过。
- 首次 Chromium 4K/120fps HEVC 自有色彩＋软件解码出现 0.76×、未达实时。随后独立播放 3 次，以及按相同载入→前后定位→播放顺序 3 次，均约 1.00× 且通过，未重现；保留首次失败记录，不能认定是稳定性能瓶颈。
- Chromium 与 WebKit 的 H.264/HEVC/VP9/AV1 浏览器色彩走原生；VVC、MPEG-2、FFV1 走 WASM。H.264 High 4:2:2 在 Chromium 原生可用、WebKit 回退 WASM。
- 自有色彩硬件优先：Chromium 的常规 H.264、HEVC、VP9、AV1 通过原始平面核对。WebKit 的 H.264/HEVC 首帧核对失败，正常回退 WASM；VP9/AV1 通过。这里的原生不等于已证实物理硬件使用。
- FFV1 4:2:2 / 4:4:4 的 10 位样片实际输出仍为 10 位平面。

## 环境与方法

- Apple M5，arm64，Darwin 27.0.0；有窗口运行，逐项串行测试。
- chromium: 153.0.8010.12
- webkit: 26.6
- 使用独立临时媒体服务和构建产物；每组新页面，硬件缓冲深度 2 帧。三种设置均调用现有会话行为。
- 先载入首帧，再定位到片长 65% 和 15%，检查实际帧时间；随后使用应用自带的播放检查，从头播放 1.5 秒。
- 表内速度为媒体进度 / 实际时间；通过不等于每个源帧均被显示。例如 120fps 样片在本轮约 60fps 的呈现调度中不会显示全部 120 帧。
- WebKit 浏览器路径的 H.264、VP9 与部分 HEVC 呈现约 42–52fps，虽然进度实时且通过现有阈值，仍低于 Chromium 的约 59–60fps；FFV1 的 30fps 样片约 29–30fps。
- 本轮是单轨短片兼容性、定位和性能验证，不是跨路径颜色逐像素认证，也未覆盖 HDR、长时间播放或双轨压力。

## 样片

| 文件 | 编码 / 像素格式 | 尺寸 | fps | 秒 |
|---|---|---|---|---|
| h264_9s_1920x1080.mp4 | h264 / yuv420p | 1920×1080 | 60/1 | 10.00 |
| h264_high422p_1s_320x180.mp4 | h264 / yuv422p | 320×180 | 30/1 | 1.00 |
| h265_10s_1920x1080.mp4 | hevc / yuv420p | 1920×1080 | 60/1 | 9.95 |
| mhw_hevc_fullrange_bt709_3s.mp4 | hevc / yuv420p | 3840×2160 | 120/1 | 3.00 |
| mhw_x265_aq_qg16_4s_1920x1080.mkv | hevc / yuv420p | 1920×1080 | 120/1 | 4.03 |
| h266_10s_1920x1080.mp4 | vvc / yuv420p | 1920×1080 | 60/1 | 10.00 |
| vp9_10s_1920x1080.webm | vp9 / yuv420p | 1920×1080 | 60/1 | 10.00 |
| av1_10s_1920x1080.webm | av1 / yuv420p | 1920×1080 | 60/1 | 9.98 |
| mpeg2_10s_1280x720.ts | mpeg2video / yuv420p | 1280×720 | 60/1 | 10.00 |
| ffv1_yuv422p_8bit.mkv | ffv1 / yuv422p | 320×180 | 30/1 | 2.00 |
| ffv1_yuv422p10le.mkv | ffv1 / yuv422p10le | 320×180 | 30/1 | 2.00 |
| ffv1_yuv444p10le.mkv | ffv1 / yuv444p10le | 320×180 | 30/1 | 2.00 |

## chromium 实际路径与播放进度

| 文件 | 浏览器色彩 | 自有＋软件 | 自有＋硬件优先 |
|---|---|---|---|
| h264_9s_1920x1080.mp4 | 原生 · 0.99× | WASM · 0.98× | 原生 · 0.99× |
| h264_high422p_1s_320x180.mp4 | 原生 · 仅定位 | WASM · 仅定位 | WASM · 仅定位 |
| h265_10s_1920x1080.mp4 | 原生 · 1.00× | WASM · 1.00× | 原生 · 1.00× |
| mhw_hevc_fullrange_bt709_3s.mp4 | 原生 · 0.99× | WASM · 0.76× ⚠ 未达实时 | 原生 · 0.99× |
| mhw_x265_aq_qg16_4s_1920x1080.mkv | 原生 · 1.00× | WASM · 0.93× | 原生 · 0.99× |
| h266_10s_1920x1080.mp4 | WASM · 0.99× | WASM · 0.99× | WASM · 0.99× |
| vp9_10s_1920x1080.webm | 原生 · 0.99× | WASM · 1.00× | 原生 · 0.98× |
| av1_10s_1920x1080.webm | 原生 · 0.99× | WASM · 0.99× | 原生 · 1.00× |
| mpeg2_10s_1280x720.ts | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |
| ffv1_yuv422p_8bit.mkv | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |
| ffv1_yuv422p10le.mkv | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |
| ffv1_yuv444p10le.mkv | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |

## webkit 实际路径与播放进度

| 文件 | 浏览器色彩 | 自有＋软件 | 自有＋硬件优先 |
|---|---|---|---|
| h264_9s_1920x1080.mp4 | 原生 · 0.99× | WASM · 1.00× | WASM · 1.00× |
| h264_high422p_1s_320x180.mp4 | WASM · 仅定位 | WASM · 仅定位 | WASM · 仅定位 |
| h265_10s_1920x1080.mp4 | 原生 · 1.00× | WASM · 1.00× | WASM · 1.00× |
| mhw_hevc_fullrange_bt709_3s.mp4 | 原生 · 0.99× | WASM · 1.00× | WASM · 1.00× |
| mhw_x265_aq_qg16_4s_1920x1080.mkv | 原生 · 0.99× | WASM · 1.00× | WASM · 1.00× |
| h266_10s_1920x1080.mp4 | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |
| vp9_10s_1920x1080.webm | 原生 · 0.99× | WASM · 1.00× | 原生 · 0.99× |
| av1_10s_1920x1080.webm | 原生 · 0.99× | WASM · 0.99× | 原生 · 0.99× |
| mpeg2_10s_1280x720.ts | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |
| ffv1_yuv422p_8bit.mkv | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |
| ffv1_yuv422p10le.mkv | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |
| ffv1_yuv444p10le.mkv | WASM · 1.00× | WASM · 1.00× | WASM · 1.00× |

## 原始证据与复现

- [完整矩阵](../artifacts/local-codecs-2026-09-12/report.json)：每组实际输出描述、两次定位、播放指标、回退日志与浏览器版本。
- [独立三次复测](../artifacts/local-codecs-2026-09-12/chromium-4k-recheck.json)。
- [按相同定位顺序三次复测](../artifacts/local-codecs-2026-09-12/exact-recheck/report.json)。
- [Chromium 画面](../artifacts/local-codecs-2026-09-12/chromium-h264.png)、[WebKit 画面](../artifacts/local-codecs-2026-09-12/webkit-h264.png)。

```sh
node scripts/check-local-codec-matrix.mjs /Users/zhuhongwei/Documents/yorune/VoidPlayer/resources/video artifacts/local-codecs-2026-09-12
```

可用 `CODEC_FILES`（逗号分隔）、`CODEC_BROWSER`、`CODEC_MODE`（如 `reference/software`）及 `CODEC_REPEATS` 缩小复测范围。
