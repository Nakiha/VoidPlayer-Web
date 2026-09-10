# 统一色彩管线：交接给 Mac 上的 Codex

## 任务与当前状态

用户已授权开始重构统一色彩管线。请直接推进实现、测试和可审查的提交，不再停留在建议清单。
目标是让解码后端不再隐式决定颜色；首帧、顺播、seek、截图使用同一色彩契约。
本轮优先实现、验证 SDR，架构保留高位深及未来 HDR 的接入边界。不要为了本轮 SDR 破坏已有 PQ/HLG 呈现。

**本交接时尚未修改任何生产色彩代码，也没有新的 YUV ABI 或 shader 半成品。**
已经完成的是源码核对与取证工具。Mac 负责后续实现和实际设备验证。

| 仓库 | 已核对基线 | 用途 |
| --- | --- | --- |
| Nakiha/VoidPlayer-Web | `codex/sdr-color-evidence`，`565320555dd4b90e8576dea6cdf77cac21f1985b` | 本文之前的最新取证实现；本交接提交在其后 |
| Nakiha/VoidPlayer-FFmpeg-Build | `wasm`，`c0d3c369d52ba5397650b564842bd154935efa97` | Web 当前锁定的 core 源码 |
| Nakiha/VoidPlayer | `881eb5ccd706c33aa1ff35ab3a67ac3a226ccfba` | Flutter/native 色彩管线的参考快照 |

先读各仓库的 AGENTS.md（若有），`git fetch` 并核对用户远端更新。保留本地未提交工作。
从含本交接的取证分支开 `codex/unified-color-pipeline`；core 改动从 `wasm` 开隔离分支。
如主干有新修复，整合后记录实际测试 SHA；不要回退主干修复。

## 已成立的证据，及不能据此下的结论

用户在 Windows / Edge 152 上运行了旧版取证。原始报告留在用户本机；以下是用户提供的摘要，
不是我们独立重跑所得。样片无须上传，报告/截图也不自动上传。

- `uhd5.flv`：HEVC、1080×1920、SDR。ffprobe 报 yuv420p、tv/limited，primaries/transfer/matrix 未指定。
  WebCodecs 输出 NV12，资源标签为 BT.709 / BT.709 / BT.709 / limited。
  WASM 输出 RGBA8，sourceColor 三项 null、fullRange=false；资源 matrix=rgb、fullRange=true。
- 同一 HEVC、同一源 PTS 0 和 1s：native/WASM MAE 为 1.69 / 1.97，RMSE 为 2.07 / 2.23，最大差为 20 / 16。
  WASM 减 native 的 RGB 均差为 `[-0.65,-0.50,-2.51]` / `[-1.44,-1.20,-2.33]`。
- `Third0T200uhd6.flv`：VVC、1080×1920、SDR；浏览器无 native config，只得到 WASM 一侧。
  source yuv420p、limited、其余未知。没有可用的 VVC 原生对照。

这证明该设备上 HEVC 的两条路径输出不同，尚不能证明根因是舍入、色度上采样或矩阵。
有限范围 YUV 转为全范围 RGB 是正确的转换形式，本身不是错误。
当前 core 对未知 matrix 在 height>=720 时已使用 BT.709，不能说它“没有矩阵”。
NV12 / decoder=webcodecs 也不能单独证明硬件执行。
VVC 无原生对照，不代表用户观察的“HEVC 原生 vs VVC 软件”差异与后端无关。
两个不同编码文件不能作为软硬解像素一致性的唯一验收基准。
不能根据这两帧宣称误差不可见或全片色准正确，更不能加蓝通道偏移补偿。

`5653205` 新增的同帧隔离指标尚未收到用户实测结果：
`nativeDirectToCanvas`、`nativeCanvasToWasm`、`wasmInputToPresenter`。
完整工具说明见 [sdr-color-evidence.md](sdr-color-evidence.md)。

## 在真实 Mac 上首先做的事

Mac 能验证真实 GPU、浏览器帧可读性、上传、资源释放和复制开销；不能替代 Windows/Edge 的最终回归。
不要把 Playwright WebKit 等同于系统 Safari，也不要把 headless Chromium 的结果当作日常浏览器硬解结果。

1. 安装 Node 24+，`npm ci`，同步 `scripts/release-core.json` 锁定的真实 core。
   安装相应浏览器，记录 macOS、芯片、浏览器版本、headed/headless、DPR、输出目标和 core SHA。
2. 在任何生产改动前运行现有取证，留 baseline。用用户原片（若在本机），以及已知颜色的合成 YUV 测试图。
   原片不在 Mac 时先完成合成测试和实现，最终请用户在原 Windows 机器跑同一工具，不阻塞于搬运私有片源。
3. 验证 WebCodecs 的实际输出格式、visibleRect、色彩标签；对支持格式测试 `copyTo`、返回 layout 和实际耗时。
   将 opaque、NotSupportedError、可读格式明确分开。不要为“统一”强制软件解码而不告知。
4. 记录改动前后的同帧转换差异、顺播帧率、等待时间、复制/上传耗时及帧队列峰值。

示例（参数中的路径替换为真实本地路径）：

```sh
node scripts/diagnose-sdr-color.mjs --channel chrome --out color-evidence-before --times-us 0,1000000 /path/to/uhd5.flv /path/to/Third0T200uhd6.flv
```

脚本默认 headed；它目前是 FLV 探针，勿直接传 MP4 期待同样覆盖。`--images` 为显式保存截图开关。
Safari/WebKit 的生产路径需要另行浏览器用例；取证 CLI 当前不提供 Safari channel。

## 当前代码边界

| 边界 | 当前行为 | 改动时注意 |
| --- | --- | --- |
| core `wasm/vp_decoder.c::vp_convert` | swscale → RGBA8；原始 AVFrame 色彩写入 72 字节 ABI v1 | YUV→RGB 已发生，Web 无法再选择矩阵或恢复丢失精度 |
| `src/wasm-frame.ts::readWasmFrame` | 拷贝 ABI 与 RGBA；packet / container 共用 | 新 ABI 必须同时覆盖两个消费者；刷新增长后的 heap 视图 |
| `src/flv-decoder.ts` | WebCodecs VideoFrame 或 WASM pixels | 解码器不绘制；异步输出与背压、close 不能回退 |
| `src/media.ts` | mediabunny 的 sample 包装成 DecodedFrame | 不能只改 FLV packet 路径，漏掉普通 MP4/TS |
| `src/packet-media.ts` / `ffmpeg-media.ts` | Worker 帧适配、缓冲回收 | 扩展资源种类时同步 transfer、预算、释放和取消 |
| `src/frame-description.ts` | 几何、资源 color/sourceColor、格式与计费 | source 标签、实际资源标签、推断值三者不能混淆 |
| `src/presenter.ts` | 唯一上屏决策点 | 首帧、播放、seek 共用；采样/截图不能有另一套校色 |
| `src/presentation-surface.ts` | WebGL1 RGBA 单纹理；原生视频导入由浏览器转换 | 目前 shader 没有 YUV 数学；captureSource 直接读 RGBA 纹理 |
| `src/presentation-color.ts` | native SDR 直传；native HDR 经 sRGB 2D；WASM RGBA 原样上传 | 重构后的路径必须准确命名，不能仍把未知转换记成已统一 |

`FrameDescription`、`DecodedFrame.kind`、worker transfer、`validateDescription`、`byteSize`、截图、
取证脚本目前都有 RGBA 假设。新增 plane 资源需要贯通，不要仅在 presenter 外挂一次转换。

## 建议实现顺序与必须解决的设计点

### 1. 集中定义颜色解析与转换计划

在统一模块中明确 raw source、resource、resolved color、target，以及每个补全字段的来源。
未知原始标签继续保留 null；推断结果放在单独字段，不伪造 bitstream 标签。
逐帧资源的显式标签优先；容器信息只在确知没有提前转换的边界补充。
matrix/range/primaries/transfer 独立解析，不以 codec、位深或分辨率推断 HDR。
对未知 SDR matrix/range 的 fallback 写成全局规则并测试，允许诊断覆盖但不加入片名规则。

必须明确 SDR 的显示假设：是匹配 native 的显示参照 SDR 策略，还是进行明确的 transfer 变换。
BT.709 transfer 与 sRGB 数学并非相同，不能只写“转 sRGB”而不说明哪一步发生了什么。
本轮以明确的 SDR/sRGB 输出为目标，不宣称 EDR、Dolby Vision、HDR10+ 已受支持。

### 2. core 保留原始平面，建立版本化 ABI

对支持的 YUV 格式，交付原始精度的平面，避免提前 swscale 到 RGBA8。
至少覆盖样片的 YUV420P，以及可用回归中的 10-bit 格式；其他格式需显式描述支持/转换/拒绝策略。
descriptor 包括 plane offset/stride/有效尺寸、subsampling、bitDepth、位对齐/字节序、裁剪、SAR、
逐帧颜色与来源、必要的 chroma location。8/10/12/16 bit 不得以 RGBA8 兜底后假装保留精度。

定义 plane 内存所有权和有效期：下次解码/seek/reset 后不可继续引用 core 内部 AVFrame。
跨 worker 只传已独立拥有的缓冲；每行边界、负 stride、奇数尺寸、padding、heap growth 都要验证。
新 API 不能假设 mt/single 的 heap 视图始终同步。ABI 不匹配应明确报版本错误。
若保留旧 RGBA fallback，日志必须说明转换执行者与有效参数，不能算统一 YUV 路径验收通过。

core 构建只在 `VoidPlayer-FFmpeg-Build` 做。按 `scripts/release-core.json` 固定工具链/FFmpeg 修订，
测试 single 和 mt；先推送 core 的不可变提交，再更新 Web pin，不能引用未提交源码或浮动 wasm 分支。
不要假设 core 的现有 `build.yml` 会自动构建 wasm：当前它 push 触发的是 main 的 native 构建。
检查 `scripts/build-wasm.sh` 与 Web release-preview 的真实调用方式。

### 3. 统一 renderer，明确可控与浏览器托管边界

优先让 WASM 平面和 WebCodecs 的可读平面进入同一 YUV 转换模块：
相同 range 展开、chroma 采样、matrix、transfer/primaries 策略、目标编码和量化。
WebGL2/WebGPU/既有 WebGL 的具体选择由能力、采样精度与 Mac 实测决定；不要先承诺零拷贝。
保留高位深到颜色运算后，避免为上传先降 8-bit。需要 CPU 参考实现用于独立验证 shader。

WebCodecs `copyTo` 的原始格式支持、成本和 layout 必须实测。它可能需要 GPU→CPU 复制。
对于 `format=null` 等无法取得平面的硬件资源，保留可播放的浏览器托管路径并准确标识限制。
不能说“换成 WebGPU”就一定能取得 NV12/P010 planes；external texture 也可能已经隐式做颜色转换。
把 WASM YUV 包成 VideoFrame 可以作为能力探针/共享浏览器转换的方案，
但这并不等于应用已掌握了同一 shader 的全部数学。

若严格一致模式与不透明硬件快速路径无法兼得，应把选择做成清晰的集中策略，并交付证据与 UX 说明。
不可静默把所有视频切成 WASM；也不可让 fallback 伪装成确定性颜色评审结果。

### 4. 几何、生命周期及取像素一起贯通

转换应基于源像素，而非视口大小；SAR、crop、rotation 与颜色运算分离。
现有视口缩小 LINEAR、放大 NEAREST 约束保持；chroma reconstruction 是独立采样决策。
截图和标注取色要读取转换后的源尺寸 RGB；不能在换为 YUV 纹理后继续直接读 Y plane 当 RGBA。
无 WebGL、旋转、context loss、重载、暂停续播、取消载入均需明确资源回收。
不要每帧把像素打印到日志；路径/格式变化时记录转换计划，性能统计有界聚合。

## Flutter/native 可复用的设计与不应照搬的细节

从上表指定 native SHA 阅读：

- `native/docs/COLOR_PIPELINE.md`
- `native/renderer/decode/frame_color_metadata.cpp`
- `native/renderer/decode/frame_converter.cpp`、`hardware_frame_converter.cpp`
- `native/renderer/decode/yuv_to_bgra.cpp`
- `native/renderer/color/color_strategy.h`
- `native/macos/metal/shaders/common_color.metal`
- `native/macos/metal/shaders/layout_cvpixelbuffer.metal`、`layout_package.metal`

可复用：软硬资源布局适配到共同颜色语义，再执行同一 range/matrix/输出函数；显式位深和位对齐。
不可直接搬：Metal/CVPixelBuffer 纹理互操作、Apple EDR 输出能力、历史性的 `-1/255` 偏移。
native 的默认标签推断或 SDR gamma 约定也必须写入新契约并验证，不是跨平台色准证明。

## 验收与交付

测试应能抓住矩阵、range、布局及重复转换错误，不能仅以两个后端“变得一样”判通过。

1. **已知输入参考图**：limited/full 黑白端点、灰阶、饱和色；BT.601/709（BT.2020 SDR 若支持）；
   8/10 bit、odd dimensions、非紧密 stride、NV12/planar 等价输入、裁剪与 SAR。
   先固定数学参考和误差预算，shader 与参考比较，不能根据实现输出倒推期望值。
2. **真实 core**：single/mt 都取到正确 ABI 和 plane 像素；seek/reset/分辨率或标签变化不复用旧布局；
   用真实 FFmpeg 解码参考核对 raw planes，避免只验证假 core。
3. **同一 HEVC**：native/WASM 同 PTS、同几何、同解析后的转换计划，比较输出；
   增加新路径前后报告，保留原始基线。如果 raw YUV 已不同，先区分解码差异与 renderer 差异。
4. **VVC**：用可解码的独立软件参考验证；与 HEVC 的不同编码画面只作为辅助观察。
5. **实际播放**：首帧、至少跨几个 GOP 的连续播放、暂停续播、seek、移除重载、两轨以上；
   HDR 测试图验证旧能力不被误走 SDR，不要求本轮伪造完整 HDR 支持。
6. **性能**：对同一机器/浏览器/片源比较帧率、waiting、copy/upload 的分位耗时、队列峰值，
   检查 4K 和可用的 8K。截图读回只在显式请求时发生，持续播放不要增加隐藏 RGBA readback。

运行 `npm test`、`npm run build`、`npm run test:presentation:browser`；
播放路径改动按 AGENTS 要求先启动服务再运行 `node scripts/bench-playback.mjs webkit`，
并用实际可解码 HEVC 的 headed 浏览器完成同机基准。新增格式同时覆盖 FLV packet、MP4 packet、
mediabunny、FFmpeg container 回退；无原片或无对应 codec 的用例明确记为未验证。

云端这轮没有可用浏览器和 Emscripten，未完成真实 GPU / 新 core 的验证；不要继承为“已通过”。
Mac 回归通过后，仍需用户原 Windows/Edge 152 环境的最终取证。不要以 Mac 没差异关闭原问题。

交付生产代码与测试、core/Web 对应 SHA、构建产物来源、可复跑报告，更新 `docs/color-pipeline.md`
成为实际实现文档，并更新取证工具以识别新 plane 资源、转换参数与 fallback。
报告中分别说明“已统一的可控路径”“浏览器托管路径”“未覆盖格式/设备”，不要笼统承诺逐像素跨设备一致。
