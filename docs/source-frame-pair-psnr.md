# 内部可信单帧对 PSNR 桥 v1

这是 #112 / #114 的一个可独立验收小切片。`FramePairClient.measure` 在一次性独立 Worker 中验证两侧已有缓存身份、读取单个闭合关键 AU、解码原始平面，然后调用 [PSNR 核心](source-plane-psnr.md)。没有接入 Session、播放游标、GUI、HTTP Agent 或媒体库自动取源；`quality.jobs` 仍为 unavailable，#114 未整体完成。本轮不实现 durable jobs、帧序列、自动对齐、SSIM 或 VMAF。

## 受信任宿主边界

调用者同时提供 `FramePairRequest` 和两份 `PreparedPairSource`，每份包括不可变 Blob、已存在的完整 `FlvIndexDocument` 及其绑定：`mediaId / mediaVersion / size / indexIdentity / indexBuildId`。媒体 ID/version 使用现有 24 位十六进制格式；`indexIdentity` 必须等于现有 FLV `kind=flv, streamKey=video:0, schemaVersion=3, indexerBuild=flv-demux-v3`；`indexBuildId` 标识这次缓存构建实例，不能用 decoder build 替代。宿主须先从自己可信的缓存/源所有者取得这些绑定，不能把任意用户上传的 JSON 或自行贴标签的 Blob 当成已认证媒体。此 API 是内部接缝，不是接受不可信请求的公开端点。

本桥验证“这些像素来自这份已绑定源快照中的指定 AU”，不认证宿主对媒体 ID 的声明，也不重新证明整个缓存的历史 AU 序号。Blob 天生不可变，克隆到 Worker 后不与活动 reader/播放缓存共享。共享执行体的 `CachedPairSource.binding()` 还在每次 IO 前后、解码后和输出前检查完整绑定；若未来接网络 reader，宿主仍必须提供版本锁定 IO，并保持该检查，不能只凭相同文件长度判定没变化。本轮没有网络 reader 或媒体库解析器，因此不声称完成了媒体库到评分的产品闭环。

两侧请求各自显式携带 `SourcePictureKey`：`sourceVersion=id@version, stream=video, configuration=0, au, picture=0, layer=0, field=frame`，以及实际 `sourcePtsUs`。还必须声明 `pairing='caller-specified'` 和相对未旋转可见亮度网格的 ROI。reference/distorted 两侧可以有不同 PTS 和媒体 ID；桥从不因 PTS 相同而选择另一侧，也不证明二者内容或时间相对应。结果明确返回 `correspondence='caller-specified-no-content-or-time-alignment'`。内层数值结果仍保留核心原来的 `caller-supplied-unverified`，这个字段只描述数值核心自身的边界。

## 逐侧验证与解码

v1 仅接受单配置、完整且无恢复缺口的 FLV / 单轨 Enhanced FLV，编码为渐进 H.264 或 HEVC。每侧必须选择缓存中唯一 PTS 的 key AU，重复 PTS 即使指定 AU 也保守拒绝。不同配置、截断/恢复缓存、非关键帧、开放 GOP/CRA、场/多层或多画面布局均不纳入。

1. 校验完整源/缓存绑定、缓存格式和原始 SPS 几何，按预算准入。
2. 从源头读到第一视频包，只用于核对源配置和缓存首包；不生成、保存或重建完整索引。缺缓存直接 `cache-miss`，不调用索引构建器。
3. 读取所选 AU 前的视频 tag 头和 footer，核对 legacy/enhanced codec、key 标志、payload offset/size、原始 DTS、composition offset 和实际源 PTS；缓存中的 AU 定位不直接冒充源证据。
4. 复用 `inspectPacketPicture` 验证 single picture / closed random access。拒绝混入依赖 VCL；包内重复参数集必须与缓存配置中的 NAL 逐字节一致，避免包内新 SPS 绕过几何准入。
5. 用单线程、独立 WASM packet context 只送这个 AU，receive 后 drain，要求恰好一张输出并核对实际输出 PTS。这里的 AU 映射证据是“独立上下文唯一闭合输入/唯一输出”，不伪称 packet ABI 提供了 AU token。每侧释放 context 后再解码另一侧，共享一个专用 core。
6. 复用 `readWasmFrame` / frame ABI v2 复制原始 YUV 平面；在复制前检查输出分配、几何和 heap。按 PSNR 核心的严格 8/10 位 YUV420、色彩、chroma location、crop/stride 与偶数 ROI 契约计算。无 RGBA、swscale fallback、WebCodecs 色度位置猜测、显示色彩补齐或降为 8 位。

输出包含 decoder 实际 `vp_core_build_id`、frame ABI、AU 映射方法、算法版本/码值域、ROI、每平面和聚合 SSE/MSE/PSNR，以及两侧完整请求身份、实际 decoded PTS、完整 FrameDescription、包 offset/size/DTS 和验证方法。所有字段可 JSON 序列化，不保留原始像素。

## 预算、取消与资源

硬上限可以通过 `budget` 降低，不能提高：两侧合计 source 读取 16 MiB、每 AU 8 MiB、每份缓存 250,000 个包 / 32 MiB 序列化字符计费、每帧输出 32 MiB、coded 像素 4096×2304、一个 core 256 MiB heap、执行 30 秒。固定两份压缩 AU 输入（每侧另有 drain 控制调用）和两帧输出，没有预卷/序列循环。PSNR 的样本数和像素输入分配还受核心原来的预算保护。源 IO 按精确 `Blob.slice` 长度在读取前合计计费，没有块预取隐藏额外媒体字节。

heap cap 在专用实例的 Emscripten JS `memory.grow` 路径上安装，并检查初始/调用后的实际 memory；当前锁定单线程 core 的分配器使用该路径。它不是任意第三方 WASM 的通用沙箱，也不是浏览器整个进程的 RSS 上限；代码、Blob、结构化克隆和 JavaScript 对象开销不等于 WASM heap。不得将未知 core 或 pthread core 接进此桥并宣称拥有同等上限。播放实例不传 cap 参数，沿用原来的装载行为。

一个 `FramePairClient` 同时只准入一个 Worker，无队列。成功、失败、`error`、`messageerror`、初始发送失败、取消和超时共用终态清理：移除事件/abort listener、清 timer、真实 terminate，再释放容量。终态使用显式成功/失败标记，取消保留原始 `signal.reason`，包括 `null / false / 0 / 空字符串`，不能按错误值真伪区分成功。异步 Worker 适配器须等退出确认；终止失败时保留 busy，防止不确定存活的 Worker 与新任务重叠。同步 PSNR / WASM 无法靠 Worker 内 abort 消息抢占，所以宿主直接终止 Worker，不能仅发送取消通知后即重用准入槽。

失败没有分数。身份与版本错误、缓存缺失、来源不支持、超预算、decoder 错误使用明确类别；数值核心的格式/色彩/ROI 错误保留原始 code。未将失败改成零分、缓存命中或降级路径。

## 验证入口与边界

- `node --test test/unit/frame-pair.test.ts`：不同媒体/PTS 的明确配对，重复 PTS、错误 AU/PTS/namespace/build、版本漂移、缺缓存、源 tag/配置不一致、依赖 AU、多配置、ROI、读取/包/索引/像素/输出/样本预算，所有 Worker 终态、四种假值取消原因的同步/异步拒绝、迟到消息和终止前准入，独立 memory.grow cap。
- `node --test test/media/frame-pair.test.ts`：FFmpeg 现场生成 H.264 8 位及 HEVC 8/10 位，再以相同压缩 AU 构造 legacy/enhanced FLV；在真实 Node Worker 内运行生产浏览器 Worker 入口（仅适配消息与 file fetch），原始 WASM 平面的 ROI 每分量/aggregate 与独立原生 FFmpeg 解码码值的精确 SSE 一致。保留的真实播放帧像素不变，桥执行期间播放 decoder 的 reset/send/receive/drain 调用为零，之后 next 仍返回预期帧。在上述三种编码/位深与两种封装中，额外插入源配置里逐字节相同的 SPS/VPS 后仍须得到相同精确 SSE；只翻转其中一个字节必须明确拒绝。实际仅编码 matrix、缺少 primaries/transfer 标签的 AVC 通过真实取帧链路后必须返回 missing-color，不能补齐。另以真实不可合作 Worker 验证取消/超时等待退出后才能再次准入，及真实 WASM 的较小 heap 准入失败。

单元用例登记在 source/fast/contract/unit；真实媒体用例登记在 media/ci-node-media/unit。`node scripts/testing/browser/media/frame-pair.mjs chromium` / `webkit` 还在真实浏览器中直接调用内部客户端，覆盖 8/10 位实际 Worker、相同图无穷 PSNR、非零误差与连续独立调用；它们登记在 browser / ci-analysis-ui / ci-analysis-browser，并不加载 Session 或 GUI。本轮没有 UI 接线或浏览器全产品质量流程。播放性能历史失败与 WebKit reload 内部错误的未知根因仍原样保留，本桥不能据此被称为“性能已达标”或“旧问题已修复”。
