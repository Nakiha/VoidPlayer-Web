# 色彩链路与帧资源契约

首帧、播放、seek、截图由 `presenter.ts` 选择同一色彩管线。解码器只交付资源，不画 canvas。
应用保留“自有色彩”和“浏览器色彩”（软件回退近似匹配）两个选项，未保存偏好时默认浏览器色彩。转换归属与 SDR/HDR 显示目标独立设置，UI/Agent 共用 session 事务。自有色彩支持标签明确的高位深 PQ/HLG 平面；支持的 WebGPU/HDR 环境可使用浮点扩展输出，其余环境明确使用 SDR 预览。请求目标与每轨实际输出分开报告，不承诺物理亮度校准或跨设备逐像素一致。

PQ/HLG 使用实际资源标签，不用源标签覆盖浏览器已转换资源。自有模式拒绝 RGBA8、低位深或标签不足的 HDR 资源；符合 BT.2100 平面契约时使用统一 HDR 数学。浏览器原生 HDR 不直接导入 external texture；具备无限 HDR headroom 和 float16 2D 转换的浏览器使用浮点 Display-P3 中转，再复制到 WebGPU rgba16float 扩展画布。缺少接口时明确使用 sRGB Canvas 兼容预览。转换完全归浏览器，不叠加源 PQ/HLG 变换。Dolby Vision/HDR10+ 动态元数据不参与转换。

## 用户选择的两条路径

- **正确颜色（reference）**：未保存解码偏好时默认“优先硬件解码”，也可显式选择“强制软件解码”。硬件优先选择 WebCodecs → Worker 原始 YUV 读回 → 共同颜色转换，不经过浏览器 RGB 呈现；软件选择真实 WASM。已有本机偏好及导入工作区的比较条件优先于新默认。FLV（含非标 HEVC）继续用 TS 解封装及渐进索引，硬件优先时与其他容器共用原始平面读回/首帧核对准入，不再因 reference 模式直接强制 WASM。特殊包索引 MP4 同样保留原生帧交给此准入流程。能力、首帧、读回或核对失败按既有失败阶段回退；input/resource 失败不换后端。RGBA/不支持颜色或无法核对的 HDR 资源明确拒绝。这里的“正确”指本文明确的转换契约，不代表专业母版参考显示。
- 硬件缓冲深度为每轨 1/2/4/8 帧，默认 2；每源固定 Worker 数和顺序读回队列受此上限约束，应用播放队列与解码器内部队列另有自身预算。更多缓冲不保证更快。配置只在 reference 下显示；软件解码隐藏深度控件但保留选择。底层使用 prefer-hardware 偏好，不冒充实际 GPU 使用的证明。
- 硬件准入支持 NV12/I420 8-bit SDR，以及 I420P10/I420P12、位深和标签一致的 PQ/HLG。载入时临时打开真实 WASM 取得同 PTS 首帧，核对全部原始 YUV 样本、coded/crop、位深、子采样及 resolved matrix/range/primaries/transfer；通过后沿用该帧确认的 chroma location，释放 WASM 源。保留硬件资源原始 color 和容器 sourceColor，不用源标签覆盖资源，也不拟合 RGB。容器 range 可以与实际帧不同；源 HDR 与资源 HDR 身份不一致、低位深 HDR 或 primaries/matrix 冲突拒绝。此验证增加首帧载入成本，不增加逐帧 WASM 解码。首帧证据不是动态码流全程认证；后续公开格式、尺寸、裁剪或色彩标签变化明确报错，提示切换软件，不静默沿用旧契约。
- 硬件能力/读回/首帧核对失败进入现有 decode 阶段软件回退；input/resource 失败不换后端。播放中的错误继续由会话处理，不新增整体 catch 换路径。每次关闭/seek 归还预取帧，源释放时终止 Worker 并拒绝待处理请求；已交付缓冲只在 frame.close 后回收，每 Worker 最多一个空闲缓冲。
- **匹配浏览器（browser）**：WebCodecs 优先，原生资源沿用浏览器输出；WASM 回退使用中性探针选择的 Apple/CV/普通 SDR 候选。这个选择仅是近似兼容，不认证未测编码、位深或资源；无有效探针时软件保留普通 SDR 转换。不会按 UA/文件名加 BT601 或 GAMMA22 修正，因此 Windows Edge 的已知资源差异不能承诺消除。
  原生资源的托管归属不依赖 WebGPU 是否成功初始化；无 WebGPU 时仍保留原生 sample，经浏览器纹理导入或 Canvas 绘制。切换模式准备首帧时也按目标用户模式决定，不能因旧 GPU 状态而先转换为自有 YUV 路径。
- 切换暂停播放，只重新准备健康且已关联轨道的相同时间位置；已失败（源已释放）与待重新关联轨道不参与准备或回滚重绘，保留原失败状态，恢复时应用当时的当前设置。保留媒体 ID、标注、对齐偏移；全部准备成功后再替换。进入事务即释放旧播放队列，避免回滚后复用旧解码/呈现契约的缓存帧。失败恢复旧模式并逐轨恢复源和画面；源重配或重绘回滚失败时记录带轨道、阶段与原始错误的本地诊断，停用并释放对应轨道，健康轨道仍可继续切换。呈现器回滚失败仍尝试恢复源，但停用受影响轨道，不能仅恢复全局设置后报告可用。回滚重绘同样可被新定位意图中止，迟到帧只释放、不上屏；不自动恢复播放。成功选择只保存在本地 localStorage。
- Agent 工具 `set_review_color_mode` 接受 `reference` / `browser`；`set_reference_decode` 接受 decoder=hardware/software、depth=1/2/4/8，UI 共用 session.setReferenceDecode 的重载/失败回滚。状态返回 `colorMode`、`referenceDecode` 及实际轨道 decoder。配置成功后保存到本地，刷新恢复。首帧、播放、seek、截图使用同一选择。
- 显式 `colorPipeline` URL 仍供底层诊断，启动时不读取用户模式；它不是第三个用户菜单选项。没有 WebGPU 时仍能用共同 WebGL/CPU 呈现正确 SDR，但浏览器拟合不作保证。

工作区导入复用同一回滚策略：准备失败时恢复原模式、解码偏好和呈现通道，再重绘原健康轨道。原导入异常始终保留；presenter 或重绘回滚失败作为带 cause 的 AggregateError 子项和本地诊断报告，受影响轨道停用并释放，保留媒体身份和标注。取消仍返回 AbortError；新意图中止旧重绘，迟到资源仅释放。

review 导出继续使用 `voidplayer-web-review` version 1，保留 media、marks、alignment、frameEvidence 等现有字段；`comparison`（version 2）与 workspace 共用快照，包含 colorMode、referenceDecode、presentation=`voidplayer-color-v2`、请求的 outputColorSpace 和完整 colorOutput 参数。旧 version 1 `voidplayer-sdr-v1` 仍可导入，恢复固定默认 SDR 条件；缺少 comparison 时沿用当前选择，未知契约拒绝。`color` 描述与当前 session 一致：reference 请求 SDR 时为 `reference-sdr`、请求 HDR 时为 `reference-hdr-requested`，browser 为 `browser-match-approximate`，均不是实际 GPU 使用或 HDR/色准认证。旧 browser 导出的 `browser-managed-unverified` 仍表示未认证的浏览器条件；消费者应优先读取 comparison，旧文件缺失时只能使用旧 color 描述，未知描述不能推定 reference。仅支持旧固定 color 字符串的消费者应保留为未知并继续读取原标注字段，无 schema/version 或标注形状迁移。

`comparisonScope=export-time` 明确 comparison/color 是生成导出时的当前条件；`markComparisonConditions=not-recorded` 明确既有及新标注都没有逐条历史色彩条件。切换模式或导入旧工作区不会改写标注、不会把当前模式回填为创建时模式。导出依然是 detached snapshot，修改 JSON 不影响会话。UI 和 Agent 的 export_review 共用此行为。

Windows 模式切换验证使用 `npm run test:color:modes`（需先运行本地服务，默认 5193）：检查 reference → browser → reference、UI 切换、刷新记忆，以及实际 decoder、时间、媒体 ID 和标注。session 单测覆盖偏移、标注保持和失败回滚。吞吐与颜色一致性需分别验证，不能将模式切换成功当作跨路径逐像素一致或实时播放通过。

## 历史负面证据的边界

以下是固定环境的旧实验，不是当前版本验收；详细过程只从 Git 历史读取。对应 `artifacts/color/` 本地产物未提交，当前 checkout 无法复核，不能用旧报告宣称今天通过或失败。

- 2026-09-10 Windows RTX 5080、Chrome 153.0.8010.36 / Edge 152.0.4191.66：统一平面实验虽使所测原片整帧 RGB 差为 0，4K 双轨各轨仍只有 Chrome 6.04–6.08 fps、Edge 10.01–10.48 fps，未达到实时门限。当轮没有真实 ABI v2 WASM core，软件参考来自独立 FFmpeg CLI；不能计作 WASM 解码或发布验收。[原设计实验](https://github.com/Nakiha/VoidPlayer-Web/blob/1d94ddb81be4800d60a852b4c210a494bfedead4/docs/color-pipeline-design-review.md)
- 同环境原生/软件平面对照的 BT.2020 SDR 内部最大差为 83，Edge HEVC 8/10-bit 为 23；即使某些内部色块通过，整帧边缘仍有较大差异。用户确认关闭 Windows HDR 后统计没有改变，但脚本未独立查询系统 HDR 状态；这不评价物理显示输出。[原 Windows 记录](https://github.com/Nakiha/VoidPlayer-Web/blob/1d94ddb81be4800d60a852b4c210a494bfedead4/docs/windows-color-validation.md)；现行复跑入口见 [Windows 色彩验证](windows-color-validation.md)。
- 2026-09-11 同机读回实验中 SharedArrayBuffer / Worker 未显著降低串行 copyTo 成本；有界流水线的 Chrome Worker 吞吐仍低于片源约 60 fps，深度 8 未带来明确收益。该流水线实验使用真实 ABI v2 多线程 core，但只核对 PTS 与每帧抽样 YUV，不是全像素或最终 RGB 认证，也不是实际双轨 UI 帧率。[原读回实验](https://github.com/Nakiha/VoidPlayer-Web/blob/1d94ddb81be4800d60a852b4c210a494bfedead4/docs/native-yuv-readback-performance.md)
- 2026-09-12 macOS 的 Chromium 无界面硬件优先实际回退 WASM，仅约 0.37× 实时；有窗口复核约 0.99× 且通过首帧平面核对。二者不证明浏览器底层物理硬件解码，也不能替代 Windows 验收。[原链路审计](https://github.com/Nakiha/VoidPlayer-Web/blob/1d94ddb81be4800d60a852b4c210a494bfedead4/docs/color-path-audit-2026-09-12.md)
- Edge 原片内部 GAMMA22 与 JS transfer=null 的差异、BT.601 候选的数学吻合都不足以确证 SharedImage/驱动根因；候选整帧最大差仍为 78–95，不能按浏览器品牌添加修正。[原源码调查](https://github.com/Nakiha/VoidPlayer-Web/blob/1d94ddb81be4800d60a852b4c210a494bfedead4/docs/chromium-color-source-investigation.md)；独立复现与上游源码定位见 [Edge 原生 YUV 复现](edge-native-yuv-repro.md)。

## 信息与责任

- `MediaInfo.color` / `FrameDescription.sourceColor` 是码流或容器原始标签，未知保持 null。
- `FrameDescription.sourceColorOrigin` 保留源标签的 container/decoder 来源，上屏同步 `MediaInfo.colorSource` 时沿用此来源；旧解码资源未标来源时按 decoder 处理，不把容器标签误报成解码器标签。
- `FrameDescription.color` 描述实际交付资源，不能用容器标签覆盖已经转换的浏览器资源。
- `resolveYuvColor` 产生单独的 resolved plan，逐字段记录 resource/fallback 来源，不改原标签。
- `yuv` 描述位深、位对齐、子采样、平面 offset/stride/尺寸及 chroma location。偏移按字节计，16 位数据为 little endian。
- `byteLength` 是拥有的平面缓冲大小；WebGPU 路径保留并计费原生 VideoSample；旧路径复制后立即关闭 VideoSample，队列仅计拥有的平面；显式诊断保留原资源时 `DecodedFrame.byteSize` 计入两者。每源最多额外保留一个 ≤64 MiB 回收缓冲。
- coded size、visibleRect、SAR/display size、rotation 相互独立。颜色转换在裁剪后的源尺寸执行，旋转再定位源像素，视口缩小 LINEAR、放大 NEAREST。

## 默认 WebGPU 路径

正确颜色及无用户模式的诊断默认初始化无 Apple/CV 补偿的 `planes` kernel；只有用户明确选择浏览器匹配才调用 `webgpu-calibration.ts`。Windows 独立复现已经证明：相同公开标签的 H264 与 HEVC 原生资源可能走出不同颜色结果，中性渐变不足以认证其他资源。硬件输出用于匹配模式的对比，不作为正确颜色模式的真值。初始化失败或无 WebGPU 时沿用旧路径。

- 初始化/刷新共用 epoch 失效守卫（`gpu-presentation-guard.ts`）：进入即递增，旧任务迟到成功或失败只清理自己那批候选，不提交全局 entries，也不全局 dispose 新一代资源；完整 source 列表独立保存，不从已提交反推，避免启动与色彩切换重叠时旧 profile 资源晚到。

- WebCodecs SDR：原生 VideoFrame clone → external texture 的浏览器资源转换 → sRGB / 扩展 Display-P3 GPU 画布。播放无应用层 copyTo/readback。
- WebCodecs HDR：仅在 HDR 目标和能力满足时，原生 VideoFrame clone → 浏览器 float16 Display-P3 2D 转换（`globalHDRHeadroom=Infinity`）→ `copyExternalImageToTexture` 至 rgba16float → WebGPU 扩展画布。此呈现入口多一次转换和纹理复制，不是零拷贝直通；不取 CPU 像素，不重新解码。每轨只保留一个可复用转换表面，尺寸变化重设无限 headroom，清空/释放时缩小表面。截图/缩略图仍按需独立生成，不读取中转画布作为 HDR 导出。
- WASM：ABI v2 原始 YUV → GPU storage buffer → `webgpu-yuv-kernel.mjs` 的 range/matrix/transfer/primaries 转换 → 同一输出。8–16 位精度保留到运算；无需 memory VideoFrame。
- Apple/CV profile 仅用于用户选择的近似匹配或显式 `colorPipeline=webgpu-apple709` / `webgpu-cv-full-range` 实验参数。Apple profile 使用 CoreVideo BT709_APPLE 1.961 gamma 和 SMPTE-C/BT470BG→709 基色矩阵。CV profile 只对 8-bit 输入复现 full-range 资源重量化，缺失矩阵时使用该资源的 709 默认；sourceColor 和 color 原标签不修改。
- profile 是独立的资源呈现约定，不覆盖源标签。旧 `resolveYuvColor` 的默认值与新 profile 需区分；未知的显式色彩不强制套 709。
- 两入口对整数源像素转换为 RGB，缩小对四点 RGB 做双线性，放大 NEAREST；避免两路分别在 YUV/RGB 域滤波。共享设备和微任务提交，引用的资源覆写前先提交，旧 clone 在提交后关闭。
- 每个 surface 保留当前 clone 或已上传 YUV buffer；原生 HDR 另外复用一个 float16 转换表面和浮点纹理；自有截图按需用同一 shader 渲染源尺寸 SDR 预览，旋转后物化 2D 画布；原生 HDR 截图按需由浏览器转换为 sRGB。自有 HDR 浮点表面截图显式关闭扩展输出并执行保存的预览策略，不能将普通截图标为 HDR 导出。SDR 和原始 YUV 播放不维护隐藏 RGBA 中间画布；原生 HDR 中转仅服务于浏览器浮点呈现。
- GPU 丢失、资源超限/导入失败、RGBA 或未满足浮点转换能力的原生 PQ/HLG 使用下述旧路径，记本地原因。WebGPU 准入（`gpuPaint`）对实际资源 transfer 判定，别名与标准名等价；原生 HDR 只通过上述浏览器浮点转换，不使用未经验证的 external HDR 导入。降级原因随每轨 `presentation.fallbackReason` 和本地日志报告。清空槽位后可重新尝试；暂停时丢失 GPU 需要 seek。`colorPipeline=legacy` 可显式选择旧路径对照。
- 可见页面播放时 rAF 与 20 ms timer 竞争且只执行一次，防止浏览器可见状态下异常节流；暂停取消、隐藏不启用兜底。该机制不承诺物理屏幕刷新率。

## 显式统一平面路径

`colorPipeline=unified` 不运行自动资源 profile 探针，直接初始化无 Apple/CV 补偿的 GPU 平面 kernel。可读原生帧通过现有异步 `prepareYuvFrame` 复制原布局后关闭 sample，与软件 YUV 共用 GPU 转换/采样。初始化失败沿用旧 WebGL/CPU 路径。不改解码器选择。

`data-color-contract` 增加原始 HDR 的 `common-yuv-hdr-preview` / `common-yuv-hdr`，并区分 `common-yuv-sdr`、`profile-yuv-sdr`、`browser-managed` 和 `rgba-resource`。默认的软件平面也标为 common-yuv-sdr；profile-yuv-sdr 仅用于显式补偿实验。统一模式下仍然可能出现 browser-managed，不代表一致性通过。源标签和资源标签不一致时不擅自覆盖；高位深不透明资源不降精度伪装为 YUV。该模式存在真实 GPU→CPU 复制成本，尚不适合直接作为默认播放路径。

## 旧路径及能力回退

| 资源 | 路径 | 诊断 |
| --- | --- | --- |
| 可读 WebCodecs SDR YUV | `copyTo` 原布局 → 共同 YUV shader 在源像素坐标转换并量化 → 视口采样 | unified-yuv-sdr |
| WASM SDR YUV | ABI v2 原精度平面 → 同一 shader → 同一视口输出 | unified-yuv-sdr |
| YUV 无 WebGL / 超纹理大小 / context lost 后的新帧 | 同一数学的 CPU 参考 → ImageData → 原有呈现回退 | unified-yuv-sdr；执行位置由实际 surface 能力决定 |
| 不透明或不可读 WebCodecs SDR、非支持色彩 | 浏览器纹理导入或 Canvas 2D | browser-default + colorFallback 原因；未实现确定性统一 |
| 原生 PQ/HLG | VideoSample.draw → sRGB Canvas 2D → WebGL | canvas2d-srgb |
| WASM 不支持的布局或色彩 | 明确 swscale RGBA 回退 | rgba8-upload + swscale-rgba |
| WASM PQ/HLG、明确的 BT.2020 NCL/primaries/range、高位深平面 | 共同 HDR 转换：SDR 预览或符合条件的 WebGPU extended Display-P3 输出 | common-yuv-hdr-preview / common-yuv-hdr；缺少条件的 RGBA 回退仍为 rgba8-hdr-unmanaged |

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

## YUV 通道隔离查看（诊断视图，非色彩转换）

顶栏“像素尺寸模式”右侧的 YUV 通道下拉栏在 `rgb` / `y` / `u` / `v` 之间切换，
状态保存在 viewport 快照（`Viewport.channel`，工作区/ Agent `setViewport` 共用），
上屏层经 `presentation-channel.ts` 全局读取，切换的是同一帧的显示方式，
不改源标签（`sourceColor`）、资源描述（`FrameDescription.color`）或 resolved plan，
不按片源堆叠修正。

- 仅 `yuv` kind 帧（WASM 原始平面；reference 硬件经首帧核对的读回平面；
  统一平面路径的 `copyTo` 平面）走隔离：Y 取归一化亮度 0–1 → 灰阶，
  U/V 取归一化色度 +0.5（中性色度为中灰），不经矩阵/基色变换；
  色度保持 AVChromaLocation 双线性重建，亮度取最近源像素，与 RGB 路径同坐标规则。
- 三条 YUV 后端共用同一数学：WebGPU `webgpu-yuv-kernel.mjs`（`p[0].w` 通道码）、
  旧 WebGL `yuv-surface.ts`（`channel` uniform）、CPU `yuvToRgba(..., channel)`；
  视口缩小 LINEAR、放大 NEAREST 的采样策略不变。
- 非 YUV 资源（浏览器托管 `video-sample`、RGBA8 回退、不支持色彩）无原始平面可还原，
  从显示 RGB 反推不是真值，因此保持 RGB 显示（`canvas.dataset.channel='rgb'`），
  不伪装成通道灰度。想看真通道请切“正确颜色（reference）”后再看。
- 暂停时切换经当前位重解一帧；播放中后续帧自动生效，不打断播放。
  截图/按需取像素反映当前通道视图；缩略图封面恒为 RGB，不随通道变化。

## 真实 WASM 与播放续接

当前已从 Actions 34499068492 同步锁定修订 1ba3ef85 的单/多线程 ABI v2 core，来源与文件哈希已校验。Windows 对照支持 `test:color:windows -- --wasm`，使用真实 packet WASM 解码并逐字节核对独立 FFmpeg 参考。诊断页面保留 COOP/COEP，记录实际 coreVariant，不能把单线程测试冒充发布环境多线程。

packet 后端提供 `framesFollowing`，让 session 在已有显示帧之后继续读取，避免开始播放时再次定位同一个 GOP。原 `framesFrom` 保留包含起始帧的语义；暂停队列复用、seek 重定位、错误阶段和资源关闭规则不变。性能证据使用 `BENCH_FORCE_WASM=1` 在测试页面禁用 WebCodecs，再调用相同 session benchmark，生产不强制改解码器。

## WASM ABI v2

core 只在 VoidPlayer-FFmpeg-Build 构建；`scripts/release-core.json` 锁定已推送提交。
`vp_frame_info` 返回 160 字节描述，版本必须为 2，旧 core 明确报错。
packet 和 FFmpeg 容器统一调用 `readWasmFrame`，同一 ArrayBuffer 跨 worker transfer 和回收。

支持无 alpha 的 planar YUV（420/422/444，8–16 位）、NV12、P010 等描述符能够明确表示的布局。
不通过 swscale 降为 RGBA 后伪称保留高精度；不支持的布局/色彩才走标明的 RGBA 回退。
当前锁定版本以 [`scripts/release-core.json`](../scripts/release-core.json) 为准（HDR 解码说明见 [HDR 支持](hdr-support.md)）。core 支持明确 BT.2020 NCL、BT.2020 primaries、至少 10-bit 的 PQ/HLG 原始平面；前端还要求实际 range 明确。HDR 使用独立传递函数，不套 SDR gamma。布局/色彩不满足条件仍显式 RGBA 回退，不将其标为已管理 HDR。

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
- `npm run test:webgpu:browser -- chrome msedge`：Windows 有窗口浏览器；`npm run test:color:windows` 补合成彩色与独立 FFmpeg 平面对照，`-- --file <MP4>` 补原片同 PTS 取证。测量方法与 WASM 证据边界见 [Windows 色彩验证](windows-color-validation.md)；历史失败不能替代当前实跑。
- `npm run test:presentation:browser`：Chromium/WebKit shader 对 CPU 参考、裁剪/旋转/采样及旧 PQ/HLG 路径。
- `npm run test:browser`：轨道、尺寸调度、双轨布局、关闭与恢复。
- `node scripts/bench-playback.mjs webkit`：真实应用连续播放；Chrome 可用 BENCH_CHANNEL=chrome。
- `scripts/diagnose-sdr-color.mjs`：同一 FLV、同 PTS 比较，新增 plane/shader 参考及 copyMs；不会自动上传片源、像素、日志。

路径状态变化时才记录转换计划，不能逐帧写日志。Windows 原问题必须在用户原设备重跑；Mac 证据不能代替 Windows/Edge 最终验收。
Dolby Vision/HDR10+ 动态元数据、母版元数据自动推定峰值及物理显示校准不在本轮支持范围。

## HDR 预览和显示目标

`hdr-policy.ts` 定义版本化参数；`hdr-color.ts` / `hdr-shader.ts` 提供 PQ/HLG 数学。CPU、WebGL、WebGPU 共用 `voidplayer-hdr-sdr-preview-v1`：绝对显示光 → 扩展 Reinhard 亮度压缩 → BT.2020 到 709 → 朝映射亮度去饱和 → sRGB。PQ 为绝对 nits；HLG 先逆 OETF，再按场景亮度执行 OOTF，不能逐通道独立 gamma。

默认假定源峰值 1000、曝光白 203、HLG 参考显示峰值 1000 nits、system gamma 1.2。UI 峰值档位 1000/2000/4000/10000 同步 HLG 显示峰值及相应 gamma，完整参数通过 session/export 保存；不把假定值标为母版实测。修改目标或参数暂停并准备原位置的新帧，失败连同模式/解码/画面回滚。

HDR 显示要求 `dynamic-range: high`、WebGPU 可用且 `rgba16float` / `toneMapping.mode=extended` 配置核验成功时启用。自有平面的转换为显示光 BT.2020 → Display-P3 → 按显式 hdrWhiteNits（默认 203、80–400 可选）归一化 → 扩展 sRGB/P3 编码，保留 >1 高亮，负色域通道钳制到 0；屏幕最终峰值由浏览器与系统决定。普通 SDR 帧转为 P3、保持 1.0 参考白。此过程无 SDR shoulder，不套浏览器近似 profile。

`MediaInfo.presentation` 单独记录 requestedTarget、actualTarget、captureTarget、executor、contract；`output` 仍是实际解码资源，不冒充显示画布。actualTarget=hdr 表示浮点 extended 输出契约，不能证明物理屏幕已测得 nits。无相应能力使用 SDR，保留请求目标，UI 说明降级。显示能力变化在会话空闲暂停后重建，启动 GPU 就绪后也重新呈现早期回退帧。

浏览器原生 HDR 仅准入 `browser-hdr-bridge.mjs` 的浮点转换。显式检查真实 2D context 的 Display-P3、float16、无限 `globalHDRHeadroom`；只设置浮点 backing store 仍会在 drawImage 时进行 SDR 映射。此接口在当前 Chromium 为实验性能力，应用不会修改浏览器启动参数或系统设置。未开放时报告 `browser-hdr-headroom-unavailable`，可切换自有色彩取得 HDR。浏览器决定原生 HLG OOTF、PQ 参考白及 HDR 转换，应用的 hdrWhiteNits/预览峰值只用于自有平面和软件回退，不用于二次校正 browser RGB。色域外负通道仍钳制到 0，正高亮保留。

直接 external HDR 导入的 Chrome 154 实验未得到符合约定的扩展显示光，但灰阶仍能区分，所以不能仅凭最高值 ≤1 宣称硬截断。当前 Chromium 源码的高位深非 RGBAF16 路径使用 N32 中间资源；`copyExternalImageToTexture(VideoFrame)` 复用同一个 external helper，直接复制到浮点目的纹理也不能解决。浮点 2D 入口绕开这个 helper。若源是 HDR 而原生资源已变为 SDR 标签，尚未验证该资源是否保留扩展显示光，使用 SDR 预览并报告 `native-hdr-resource-unverified`，不覆盖资源标签或把普通 SDR 纹理放到扩展画布后冒充 HDR 保留。每轨诊断报告 `displayHdr`、`outputColorSpace`、`outputFormat`、`toneMapping`、请求/实际目标、executor 和 fallbackReason；`webgpu-browser-hdr-float` 表示浏览器浮点中转，不表示零拷贝或自有数学认证。真实 HEVC PQ/HLG 灰阶、彩色块和浮点 GPU 读回证据见 [HDR 支持](hdr-support.md)。

## 首帧封面资源

缩略图不修改播放帧、源标签或 presenter 的播放采样策略。软件 YUV/RGBA 候选复制一份有界缓冲并转移至单任务 Worker，按小尺寸目标双线性采样，YUV 使用共同 range/matrix/primaries/HDR 预览转换，缩略图固定默认预览策略以保持缓存内容稳定；不再生成全尺寸 RGBA 中间图。旋转和显示比例沿用帧描述。原生 sample 克隆后直接绘制到小画布。符合平面契约的 HDR 可以生成 SDR 封面；不可管理的 RGBA HDR 仍跳过。候选有独立所有权和 500ms 到期释放；事件循环被外部任务阻塞时定时器只能在恢复调度后执行，此期限不是实时系统保证。慢编码、存储和上传不串行阻塞下一张完整帧。

### 工作区比较条件

导出/本机检查点持久化 `comparison`：色彩模式、referenceDecode 偏好/深度，以及 `voidplayer-color-v2` 的目标、HDR 白与全部预览参数。导入在打开解码器之前应用，失败/取消回滚原条件；通道仍保存在 viewport。兼容旧 version 1 SDR 契约，不宣称 browser 兼容路径与软件输出逐像素相同，也不承诺不同设备的 HDR 参考显示。旧工作区缺少该块时提示沿用当前条件，未知契约拒绝读取。

### Visible chroma edge contract

Raw YUV CPU, WebGL and WebGPU reconstruction clamps chroma indices to cells
intersecting `visibleRect` (floor of crop origin / subsampling through ceil of
crop end / subsampling minus one). Bilinear reconstruction never reads CTU
padding outside this crop. The native witness compares every visible luma and
chroma cell exactly, including boundary cells, with no numeric tolerance.
Different coded allocations may therefore pass when only their padding differs.
PTS, crop, packing validity, bit depth, siting and resolved color checks remain
mandatory. This does not certify arbitrary differences in decoded edge pixels.
