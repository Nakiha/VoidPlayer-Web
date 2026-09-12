# 色彩链路与帧资源契约

首帧、播放、seek、截图由 `presenter.ts` 选择同一色彩管线。解码器只交付资源，不画 canvas。
应用提供“自有色彩”（SDR）和“浏览器色彩”（软件回退近似匹配）两个选项，未保存偏好时默认浏览器色彩；已保存的选择继续沿用。设置位于“色彩与解码 → 色彩转换”，UI/Agent 共用 `session.setColorMode`。不承诺跨设备逐像素一致或 HDR/EDR 输出。

## 用户选择的两条路径

- **正确颜色（reference）**：提供“强制软件解码”（默认）及“优先硬件解码”。前者选择真实 WASM；后者优先 WebCodecs → Worker 原始 YUV 读回 → 共同颜色转换，不经过浏览器 RGB 呈现。两者均保留 SDR 原始平面。此为用户选择的后端策略，不是新增整体异常捕获。FLV 仍使用 TS 解封装并暂时强制 WASM；不支持的容器仅按既有失败阶段回退。RGBA/HDR/不支持颜色明确拒绝。这里的“正确”指本文定义的 SDR 显示参照规则，不代表完整专业 HDR 色彩管理。
- 硬件缓冲深度为每轨 1/2/4/8 帧，默认 2；每源固定 Worker 数和顺序读回队列受此上限约束，应用播放队列与解码器内部队列另有自身预算。更多缓冲不保证更快。配置只在 reference 下显示；软件解码隐藏深度控件但保留选择。底层使用 prefer-hardware 偏好，不冒充实际 GPU 使用的证明。
- 硬件准入目前限 NV12/I420 8-bit SDR。载入时临时打开真实 WASM 取得同 PTS 首帧，核对全部原始 YUV 样本、coded/crop、位深、子采样及 resolved matrix/range/primaries/transfer；通过后沿用该帧确认的 chroma location，释放 WASM 源。保留硬件资源原始 color 和容器 sourceColor，不用源标签覆盖资源，也不拟合 RGB。容器 range 可以与实际帧不同；源 HDR 或 primaries/matrix 冲突拒绝。此验证增加首帧载入成本，不增加逐帧 WASM 解码。首帧证据不是动态码流全程认证；后续公开格式、尺寸、裁剪或色彩标签变化明确报错，提示切换软件，不静默沿用旧契约。
- 硬件能力/读回/首帧核对失败进入现有 decode 阶段软件回退；input/resource 失败不换后端。播放中的错误继续由会话处理，不新增整体 catch 换路径。每次关闭/seek 归还预取帧，源释放时终止 Worker 并拒绝待处理请求；已交付缓冲只在 frame.close 后回收，每 Worker 最多一个空闲缓冲。
- **匹配浏览器（browser）**：WebCodecs 优先，原生资源沿用浏览器输出；WASM 回退使用中性探针选择的 Apple/CV/普通 SDR 候选。这个选择仅是近似兼容，不认证未测编码、位深或资源；无有效探针时软件保留普通 SDR 转换。不会按 UA/文件名加 BT601 或 GAMMA22 修正，因此 Windows Edge 的已知资源差异不能承诺消除。
  原生资源的托管归属不依赖 WebGPU 是否成功初始化；无 WebGPU 时仍保留原生 sample，经浏览器纹理导入或 Canvas 绘制。切换模式准备首帧时也按目标用户模式决定，不能因旧 GPU 状态而先转换为自有 YUV 路径。
- 切换暂停播放，重新准备全部现有轨道的相同时间位置；保留媒体 ID、标注、对齐偏移。全部准备成功后再替换。失败恢复旧模式、旧源和画面；不自动恢复播放。成功选择只保存在本地 localStorage。
- Agent 工具 `set_review_color_mode` 接受 `reference` / `browser`；`set_reference_decode` 接受 decoder=hardware/software、depth=1/2/4/8，UI 共用 session.setReferenceDecode 的重载/失败回滚。状态返回 `colorMode`、`referenceDecode` 及实际轨道 decoder。配置成功后保存到本地，刷新恢复。首帧、播放、seek、截图使用同一选择。
- 显式 `colorPipeline` URL 仍供底层诊断，启动时不读取用户模式；它不是第三个用户菜单选项。没有 WebGPU 时仍能用共同 WebGL/CPU 呈现正确 SDR，但浏览器拟合不作保证。

Windows 验证：`npm run test:color:modes`（需先运行本地服务，默认 5193）在 Chrome/Edge 上用真实 HEVC 完成 reference → browser → reference、UI 再切换、刷新记忆；检查实际 decoder、时间、ID 和标注。session 单测验证偏移/标注保持及失败回滚。两浏览器两模式 4K 双轨基准均通过：reference 约 57–58 fps、browser 约 59 fps，短片结果不是长期性能保证。匹配模式只保证被选择和执行，未将之前失败的跨路径像素验收改成通过。

2026-09-11 解码设置补测：上述 reference 57–58 fps 指软件路径。新增硬件选项在 Chrome/Edge 上通过深度 1/2/4/8、反复 seek、实际 NV12 输出、WebCodecs 不可用时回退、UI 与刷新保存检查；原片首帧全平面核对通过。相关 66 项单测（含真实 core）及 Chromium UI 回归、构建通过。全量 npm test 为 348 通过、30 失败、1 跳过：28 项缺少本机回归样片，2 项 Windows SIGTERM 退出码断言失败，不能宣称全量通过。

真实应用深度 2、每场景两轮：Chrome 原片单轨 38.38–38.71 fps、双轨每轨 21.02–21.17 fps；Edge 单轨 52.61–53.25 fps、双轨每轨 30.62–31.08 fps。8 次仅 Edge 单轨一次达到现有基准阈值，其余未达实时，Chrome 双轨另有呈现停顿。与独立 960×540 吞吐实验不同，本次使用真实应用调度和 3840×2160 呈现画布。保留软件默认，硬件选项不承诺实时性能，也不按浏览器名字改矩阵或绕过首帧核对。报告位于 `artifacts/color/reference-hardware-{chrome,edge}-bench-final.json`。

当前实测结果与边界见 [WebGPU 修复记录](webgpu-color-pipeline-status.md)。
Windows 后续已验证一条显式、不依赖平台 profile 的 `?colorPipeline=unified` 共同平面路径；设计取舍、未解决资源与性能限制见 [设计审查](color-pipeline-design-review.md)。它尚未替换默认路径。

## 信息与责任

- `MediaInfo.color` / `FrameDescription.sourceColor` 是码流或容器原始标签，未知保持 null。
- `FrameDescription.color` 描述实际交付资源，不能用容器标签覆盖已经转换的浏览器资源。
- `resolveYuvColor` 产生单独的 resolved plan，逐字段记录 resource/fallback 来源，不改原标签。
- `yuv` 描述位深、位对齐、子采样、平面 offset/stride/尺寸及 chroma location。偏移按字节计，16 位数据为 little endian。
- `byteLength` 是拥有的平面缓冲大小；WebGPU 路径保留并计费原生 VideoSample；旧路径复制后立即关闭 VideoSample，队列仅计拥有的平面；显式诊断保留原资源时 `DecodedFrame.byteSize` 计入两者。每源最多额外保留一个 ≤64 MiB 回收缓冲。
- coded size、visibleRect、SAR/display size、rotation 相互独立。颜色转换在裁剪后的源尺寸执行，旋转再定位源像素，视口缩小 LINEAR、放大 NEAREST。

## 默认 WebGPU 路径

正确颜色及无用户模式的诊断默认初始化无 Apple/CV 补偿的 `planes` kernel；只有用户明确选择浏览器匹配才调用 `webgpu-calibration.ts`。Windows 独立复现已经证明：相同公开标签的 H264 与 HEVC 原生资源可能走出不同颜色结果，中性渐变不足以认证其他资源。硬件输出用于匹配模式的对比，不作为正确颜色模式的真值。初始化失败或无 WebGPU 时沿用旧路径。

- WebCodecs：原生 VideoFrame clone → external texture 的浏览器资源转换 → sRGB GPU 画布。播放无应用层 copyTo/readback。
- WASM：ABI v2 原始 YUV → GPU storage buffer → `webgpu-yuv-kernel.mjs` 的 range/matrix/transfer/primaries 转换 → 同一输出。8–16 位精度保留到运算；无需 memory VideoFrame。
- Apple/CV profile 仅用于用户选择的近似匹配或显式 `colorPipeline=webgpu-apple709` / `webgpu-cv-full-range` 实验参数。Apple profile 使用 CoreVideo BT709_APPLE 1.961 gamma 和 SMPTE-C/BT470BG→709 基色矩阵。CV profile 只对 8-bit 输入复现 full-range 资源重量化，缺失矩阵时使用该资源的 709 默认；sourceColor 和 color 原标签不修改。
- profile 是独立的资源呈现约定，不覆盖源标签。旧 `resolveYuvColor` 的默认值与新 profile 需区分；未知的显式色彩不强制套 709。
- 两入口对整数源像素转换为 RGB，缩小对四点 RGB 做双线性，放大 NEAREST；避免两路分别在 YUV/RGB 域滤波。共享设备和微任务提交，引用的资源覆写前先提交，旧 clone 在提交后关闭。
- 每个 surface 只保留当前 clone 或已上传 YUV buffer；截图按需用同一 shader 渲染源尺寸，旋转后物化 2D 画布。播放不维护隐藏 RGBA 中间画布。
- GPU 丢失、资源超限/导入失败、RGBA 或 PQ/HLG 使用下述旧路径，记本地原因。清空槽位后可重新尝试；暂停时丢失 GPU 需要 seek。`colorPipeline=legacy` 可显式选择旧路径对照。
- 可见页面播放时 rAF 与 20 ms timer 竞争且只执行一次，防止浏览器可见状态下异常节流；暂停取消、隐藏不启用兜底。该机制不承诺物理屏幕刷新率。

## 显式统一平面路径

`colorPipeline=unified` 不运行自动资源 profile 探针，直接初始化无 Apple/CV 补偿的 GPU 平面 kernel。可读原生帧通过现有异步 `prepareYuvFrame` 复制原布局后关闭 sample，与软件 YUV 共用 GPU 转换/采样。初始化失败沿用旧 WebGL/CPU 路径。不改解码器选择。

`data-color-contract` 区分 `common-yuv-sdr`、`profile-yuv-sdr`、`browser-managed` 和 `rgba-resource`。默认的软件平面也标为 common-yuv-sdr；profile-yuv-sdr 仅用于显式补偿实验。统一模式下仍然可能出现 browser-managed，不代表一致性通过。源标签和资源标签不一致时不擅自覆盖；高位深不透明资源不降精度伪装为 YUV。该模式存在真实 GPU→CPU 复制成本，尚不适合直接作为默认播放路径。

## 旧路径及能力回退

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

## 旧路径 SDR 数学与默认值

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

色度在 range/matrix 转换之前按实际资源的 AVChromaLocation 做双线性重建，单个高位深码值先完整读取，再插值，不对拆开的高低字节插值。支持 left/center/top-left/top/bottom-left/bottom；未给出位置时明确采用 center，不能从浏览器品牌推断。边界钳制到有效平面，忽略行尾 padding。WebGPU、WebGL 和 CPU 使用相同坐标规则；亮度和最终放大仍取最近源像素。位置依据 [FFmpeg AVChromaLocation](https://ffmpeg.org/doxygen/7.1/pixdesc_8h.html)。浏览器导入可能采用不同位置或滤波，因此托管路径仍可能不同。
CPU 测试固定黑白端点、独立饱和色向量；GPU 与 CPU 误差预算为每通道最多 1 个 8-bit 码值。

## 真实 WASM 与播放续接

当前已从 Actions 34499068492 同步锁定修订 1ba3ef85 的单/多线程 ABI v2 core，来源与文件哈希已校验。Windows 对照支持 `test:color:windows -- --wasm`，使用真实 packet WASM 解码并逐字节核对独立 FFmpeg 参考。诊断页面保留 COOP/COEP，记录实际 coreVariant，不能把单线程测试冒充发布环境多线程。

packet 后端提供 `framesFollowing`，让 session 在已有显示帧之后继续读取，避免开始播放时再次定位同一个 GOP。原 `framesFrom` 保留包含起始帧的语义；暂停队列复用、seek 重定位、错误阶段和资源关闭规则不变。性能证据使用 `BENCH_FORCE_WASM=1` 在测试页面禁用 WebCodecs，再调用相同 session benchmark，生产不强制改解码器。

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

## 旧路径 WebCodecs 读取与生命周期

mediabunny、FLV packet、MP4 packet 都通过 `prepareYuvFrame` 适配。
`copyTo` 在 MediaSource 的异步取帧/背压范围内完成，不在 VideoDecoder 同步 output 回调中异步堆积帧。
支持 I420/I422/I444、I420P10/P12 等可读 planar 格式和 NV12；读取完整 coded rect，再按 visibleRect 裁剪。
不请求 RGB 格式转换，不强制软件解码。copyTo 的 GPU→CPU 成本是真实成本，`copyMs` 记录当帧耗时供本地取证。

format=null 不调用 allocationSize/copyTo，按 codedWidth×codedHeight×8 估算预算，标记 byteLengthEstimated。
NotSupportedError 保留可播放资源并记录原因；其他错误继续传播，临时 clone、sample 明确 close。
取消/释放发生在 copyTo 等待期间时，返回前关闭帧。旧路径保存独立 rotation 后关闭 sample；该路径仅 preserveNativeSample 显式本地诊断保留原样本，并纳入预算。

原生 packet 最多保留 8 个未输出输入；输出预算 max(128 MiB, 8×最大帧计费)，异常数量上限 32。
输入未被接受时先 receive 再重试同一包，不前移游标。播放队列至少为两帧保留预算，并保留容量限制。

## 验证与证据边界

- `npm test`：布局/矩阵/范围/高位深/heap growth、真实 single/mt core、packet/container 与生命周期。
- `npm run test:webgpu:browser`：自动资源探针、原生 clone 生命周期、按需截图、旋转/缩放与直接高位深平面。
- `npm run test:webgpu:browser -- chrome msedge`：Windows 有窗口浏览器；`npm run test:color:windows` 补合成彩色与独立 FFmpeg 平面对照，`-- --file <MP4>` 补原片同 PTS 取证。当前未通过项和 WASM 证据边界见 [Windows 验证记录](windows-color-validation.md)。
- `npm run test:presentation:browser`：Chromium/WebKit shader 对 CPU 参考、裁剪/旋转/采样及旧 PQ/HLG 路径。
- `npm run test:browser`：轨道、尺寸调度、双轨布局、关闭与恢复。
- `node scripts/bench-playback.mjs webkit`：真实应用连续播放；Chrome 可用 BENCH_CHANNEL=chrome。
- `scripts/diagnose-sdr-color.mjs`：同一 FLV、同 PTS 比较，新增 plane/shader 参考及 copyMs；不会自动上传片源、像素、日志。

路径状态变化时才记录转换计划，不能逐帧写日志。Windows 原问题必须在用户原设备重跑；Mac 证据不能代替 Windows/Edge 最终验收。
Dolby Vision/HDR10+ 动态元数据、EDR、高峰值 HDR 输出均不在本轮支持范围。
