# 色彩链路与帧资源契约

首帧、播放、seek、截图由 `presenter.ts` 选择同一色彩管线。解码器只交付资源，不画 canvas。
本轮统一可读 SDR YUV；不承诺跨设备逐像素一致或 HDR/EDR 输出。

## 信息与责任

- `MediaInfo.color` / `FrameDescription.sourceColor` 是码流或容器原始标签，未知保持 null。
- `FrameDescription.color` 描述实际交付资源，不能用容器标签覆盖已经转换的浏览器资源。
- `resolveYuvColor` 产生单独的 resolved plan，逐字段记录 resource/fallback 来源，不改原标签。
- `yuv` 描述位深、位对齐、子采样、平面 offset/stride/尺寸及 chroma location。偏移按字节计，16 位数据为 little endian。
- `byteLength` 是拥有的平面缓冲大小；正常 WebCodecs 复制后立即关闭 VideoSample，队列仅计拥有的平面；显式诊断保留原资源时 `DecodedFrame.byteSize` 计入两者。每源最多额外保留一个 ≤64 MiB 回收缓冲。
- coded size、visibleRect、SAR/display size、rotation 相互独立。颜色转换在裁剪后的源尺寸执行，旋转再定位源像素，视口缩小 LINEAR、放大 NEAREST。

## 实际呈现路径

| 资源 | 路径 | 诊断 |
| --- | --- | --- |
| 可读 WebCodecs SDR YUV | `copyTo` 原布局 → 共同 YUV shader 在源像素坐标转换并量化 → 视口采样 | unified-yuv-sdr |
| WASM SDR YUV | ABI v2 原精度平面 → 同一 shader → 同一视口输出 | unified-yuv-sdr |
| YUV 无 WebGL / 超纹理大小 / context lost 后的新帧 | 同一数学的 CPU 参考 → ImageData → 原有呈现回退 | unified-yuv-sdr；执行位置由实际 surface 能力决定 |
| 不透明或不可读 WebCodecs SDR、非支持色彩 | 浏览器纹理导入或 Canvas 2D | browser-default + colorFallback 原因；未实现确定性统一 |
| 原生 PQ/HLG | VideoSample.draw → sRGB Canvas 2D → WebGL | canvas2d-srgb |
| WASM 不支持的布局或色彩 | 明确 swscale RGBA 回退 | rgba8-upload + swscale-rgba |
| WASM PQ/HLG | 保留原 RGBA 路径及警告 | rgba8-hdr-unmanaged |

截图按需调用同一 shader，在源尺寸 RGB 纹理上物化并读取，不读 Y plane，不在播放中维护隐藏 RGBA 画布。
YUV shader 的 colorAt 对整数源像素转换并量化，再做视口采样。放大取最近源像素；缩小对邻近四个已经转换、量化的 RGB 做双线性插值。颜色数学不随视口大小变化；色度重建和视口滤波是两次独立决策。
无 WebGL 的旋转使用相同 CPU 结果。context lost 后停止使用失效纹理，下一次呈现/seek 走源画布回退；暂停帧丢失需重新 seek，不承诺从失效 GPU 恢复像素。

## SDR 数学与默认值

SDR 使用显示参照的 sRGB-like 约定：YUV 矩阵得到的非线性 R'G'B' 直接作为 SDR 显示码值。
**不做 BT.709 OETF 的逆变换再编码为 sRGB**，两者不是同一数学函数。这是明确的观看约定，非场景线性色度学转换。
BT.601/709 SDR 保持此约定；BT.2020 SDR 在 sRGB-like 线性化后变换到 BT.709 基色，再编码。
BT.601 基色当前沿用 native 的普通 SDR 约定，不单独进行 601→709 色域校准。

独立解析 matrix、range、transfer、primaries；不按 codec、片名或位深推断 HDR：

- 未知 matrix：width ≥ 1280 或 height > 576 使用 BT.709，否则 SMPTE 170M / BT.601。
- 未知 range：limited；仅源格式为 YUVJ 且没有显式标签时 full。
- 未知 transfer：显示参照 SDR。支持 bt709、smpte170m、iec61966-2-1、bt2020-10/12。
- 未知 primaries：从 resolved matrix 得出 709、601 或 2020。仅支持这些普通 SDR 基色。
- 矩阵支持 BT.601、BT.709、BT.2020 NCL；其他显式色彩保留托管/旧 RGBA 回退，不能静默套 709。

位深 n 的 scale = 2^(n−8)，max = 2^n−1：limited Y=(code−16×scale)/(219×scale)，
Cb/Cr=(code−128×scale)/(224×scale)；full Y=code/max，Cb/Cr=(code−128×scale)/max。
按矩阵 Kr/Kb 推导 R/G/B，不加 native 历史 `−1/255` 偏移，不添加蓝通道补偿。
直到输出 RGB 前都保留 8/9/10/12/14/16 位整数精度。

色度采用 nearest-block：每个源像素从 floor(x/subsampling)、floor(y/subsampling) 读取色度。
保留 chroma location 作诊断，但本轮不按位置标签改变重建核。浏览器导入可能采用其他滤波，故托管路径仍可能不同。
CPU 测试固定黑白端点、独立饱和色向量；GPU 与 CPU 误差预算为每通道最多 1 个 8-bit 码值。

## WASM ABI v2

core 只在 VoidPlayer-FFmpeg-Build 构建；`scripts/release-core.json` 锁定已推送提交。
`vp_frame_info` 返回 160 字节描述，版本必须为 2，旧 core 明确报错。
packet 和 FFmpeg 容器统一调用 `readWasmFrame`，同一 ArrayBuffer 跨 worker transfer 和回收。

支持无 alpha 的 planar YUV（420/422/444，8–16 位）、NV12、P010 等描述符能够明确表示的布局。
不通过 swscale 降为 RGBA 后伪称保留高精度；不支持的布局/色彩才走标明的 RGBA 回退。
HDR 继续旧路径，不把 PQ/HLG 平面误当 SDR。

core 每行复制有效字节，去掉 padding，支持负 linesize。descriptor 与缓冲只在下次输出/reset/destroy 前有效。
Web 在下一次解码前独立复制，验证范围、尺寸、stride、位深及平面非重叠；字符串 ccall 可能增长 heap，描述必须先读完，再刷新像素 heap 视图。

旧 RGBA 回退仍由 swscale SWS_BICUBIC 执行：显式 AVFrame matrix/range 优先，未知 matrix 用 height≥720 的 BT.709，否则 BT.601；未知 range 为 limited。
该回退不计入统一 YUV 验收，尤其不代表完整 HDR tone mapping。

## WebCodecs 读取与生命周期

mediabunny、FLV packet、MP4 packet 都通过 `prepareYuvFrame` 适配。
`copyTo` 在 MediaSource 的异步取帧/背压范围内完成，不在 VideoDecoder 同步 output 回调中异步堆积帧。
支持 I420/I422/I444、I420P10/P12 等可读 planar 格式和 NV12；读取完整 coded rect，再按 visibleRect 裁剪。
不请求 RGB 格式转换，不强制软件解码。copyTo 的 GPU→CPU 成本是真实成本，`copyMs` 记录当帧耗时供本地取证。

format=null 不调用 allocationSize/copyTo，按 codedWidth×codedHeight×8 估算预算，标记 byteLengthEstimated。
NotSupportedError 保留可播放资源并记录原因；其他错误继续传播，临时 clone、sample 明确 close。
取消/释放发生在 copyTo 等待期间时，返回前关闭帧。正常路径保存独立 rotation 后关闭 sample；仅 preserveNativeSample 显式本地诊断保留原样本，并纳入预算。

原生 packet 最多保留 8 个未输出输入；输出预算 max(128 MiB, 8×最大帧计费)，异常数量上限 32。
输入未被接受时先 receive 再重试同一包，不前移游标。播放队列至少为两帧保留预算，并保留容量限制。

## 验证与证据边界

- `npm test`：布局/矩阵/范围/高位深/heap growth、真实 single/mt core、packet/container 与生命周期。
- `npm run test:presentation:browser`：Chromium/WebKit shader 对 CPU 参考、裁剪/旋转/采样及旧 PQ/HLG 路径。
- `npm run test:browser`：轨道、尺寸调度、双轨布局、关闭与恢复。
- `node scripts/bench-playback.mjs webkit`：真实应用连续播放；Chrome 可用 BENCH_CHANNEL=chrome。
- `scripts/diagnose-sdr-color.mjs`：同一 FLV、同 PTS 比较，新增 plane/shader 参考及 copyMs；不会自动上传片源、像素、日志。

路径状态变化时才记录转换计划，不能逐帧写日志。Windows 原问题必须在用户原设备重跑；Mac 证据不能代替 Windows/Edge 最终验收。
Dolby Vision/HDR10+ 动态元数据、EDR、高峰值 HDR 输出均不在本轮支持范围。
