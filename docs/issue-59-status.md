# Issue #59：首轮 MP4 / FLV 适配

本轮关联 [#59](https://github.com/Nakiha/VoidPlayer-Web/issues/59)，交付有限文件的 FLV 分析和精确暂停帧遮罩。后续 fragmented MP4、TS、MKV 仍由该 issue 跟踪，首轮 PR 不关闭 issue。

## 输入与身份

`input.ts` 根据文件头选择 `mp4-input.ts` 或 `flv-input.ts`。公共 `AnalysisInput` 由 `types.ts` 定义；runner 用 `readUnit(packet)` 读取 codec 输入，不解释文件位置。适配器保留容器的原始配置记录和压缩 payload，没有为解码器合成配置。包元数据保留原始 PTS/DTS ticks、timebase 与供解码器使用的微秒时间。普通 MP4 的原始 ticks 来自 STTS/CTTS，不把 edit-list 或 POC 修复后的时间反标为原始 ticks；缺 STTS 时原始 ticks 为 null。既有 HEVC 时间修复仍局限于 MP4 适配器，FLV 不借用该规则。

FLV 直接复用 `scanFlv` 的 decode-order 包序号、configuration 和 discontinuity。媒体零点仍是首个 decode-order key 的 PTS。播放 `PacketTimeline` 只在 codec 证明单 picture 且源 PTS 唯一时把 AU/config 身份附到实际解码输出；重复时间戳不提供精确 token。分析同样拒绝歧义，容器 key 只作候选，实际预滚起点由 codec 语法验证。

本地和服务器各自持有独立 reader、扫描游标和分析 core。播放只提供只读索引前缀；分析不调用播放 seek/decoder。FLV 服务器索引沿用共享扫描器已验证的单调前缀进度，完成后解析 FLV JSON document 检查最终计数，不解释为 FFmpeg 的 48 字节 record。完成的索引查询不重复加载完整文档。取消释放分析订阅，不终止其他索引消费者。

索引枚举结束与源完整性分开：适配器显式保留 complete/recovered/prefix 及截断位置，前缀枚举完成不冒充源文件完整。整片任务在下一个 key/config/discontinuity 或确定的有效前缀终点处封口。最终 AU 数在扫描/外部索引完成前为 `null`，进度显式报告等待；等待不 drain decoder。配置变化和损坏重同步都在安全锚处重建参考状态，包括配置未变化的 discontinuity。区间跨配置时只重开 decoder，复用独立元数据计划。预算保持一秒、32 个结果、300 个预滚包和既有缓存/heap 上限。

## 支持矩阵

可执行定义在 `scripts/bitstream-analysis-matrix.json`。

| 容器与 framing | Codec | 来源 | 播放与分析 |
| --- | --- | --- | --- |
| 普通 MP4 | H.264 / HEVC / VVC | 本地 / 媒体库 | 原有组合继续验证 |
| AVC FLV、legacy HEVC、private VVC | H.264 / HEVC / VVC | 本地 / 媒体库 | WebCodecs 可用时使用浏览器；独立 WASM 播放兜底；统一分析 |
| Enhanced FLV avc1 / hvc1 / vvc1 | H.264 / HEVC / VVC | 本地 / 媒体库 | 同上；VVC 使用软件播放 |

输出沿用 blocks、8-bit luma QP、基础模式和 active L0/L1 参考列表。AV1 分析、多轨 Enhanced FLV、持续增长直播、无法证明的随机锚、field/layer、多 picture AU、复杂 VVC 工具及 MV 不纳入。尾部截断保留已验证 picture 前缀，未知丢失数据之后只有共享扫描器证明的闭合恢复起点可以继续精确分析。

## 素材与验收说明

`node scripts/make-analysis-flv-fixtures.ts` 将已有三 codec QA 片源的压缩 payload/config 原样封装为两种 FLV framing，不转码。原 MP4 的 H.264 部分 ctts 导出值会产生负数、异常巨大的 DTS；普通正向 remux 使用已知 60 fps 的单调 decode clock、源 presentation delta 和 FLV 毫秒精度。此转换仅定义测试素材，不作为产品中的时间修复。独立 codec 答案仍按源 decode ordinal 核对具体块；VVC 仍使用原 VTM 已知答案。

另外保留异常 DTS 跳变、负 CTS 和重复 PTS 用例：适配器不规整原始 ticks，分析输出保留具体源时间/AU；重复 PTS 明确拒绝分析，实际播放不提供精确 picture 身份。真实 H.264/HEVC 分辨率切换使用现有 fixture 生成器验证区间、整片和反向 seek。异常间隙、尾部、重复 sequence header、取消、索引等待/恢复、完整命中和稀疏补缺有回归。

三 codec 本地流式用例实际消费 600 帧；服务器重启/损坏补缺用例各保存 120 帧，使用未改变的 128 MiB 缓存预算。初次用完整 600 帧测试“全部保留”时 H.264/HEVC 超出缓存保留范围，重启必须重新解码；这是实际淘汰行为，不能宣称任意整片都可永久命中。已有 quota/lease/backpressure 用例继续覆盖有界回收。

最终验证结果与 PR 的精确提交和 CI 一起报告；本机验证不代表三平台发布门禁已经完成。

### Review follow-up: local IO and growing identity

Bounded local FLV requests obtain a source-bound, validated complete FLV index document from the existing metadata worker. Library picture/range requests subscribe to the same version/epoch-bound shared index and use its complete snapshot. Analysis never borrows the playback byte cache, reader, or decoder; each request reads only its verified target GOP independently. A standalone reader without a snapshot must scan metadata first; this may touch every 256 KiB block and is explicitly limited to sources at most 64 MiB. `metrics.bytesRead` measures logical bytes, not underlying cached block loads; regression tests separately count real `Blob.slice` bytes for two distinct rear requests.

FLV output gets a precise playback picture identity only after the source index is complete: a growing prefix cannot promise global PTS uniqueness. A frame presented before completion remains unverified until a new presentation/seek, including a paused startup frame. The browser matrix verifies that boundary and then seeks after indexing to test exact first-frame overlays. At output reception and pending lookahead delivery, PacketTimeline rechecks identity against the current index; append invalidates pending duplicate identities. This prevents an identity emitted from an incomplete prefix from becoming stale when later packets collide. MP4 raw STTS decode timing is opt-in for analysis; ordinary playback adds no STTS payload read or per-sample decode-time allocation.

### CI matrix partitions

Chromium job [115206446227](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/38370470947/job/115206446227) on `be4e7ad` was stopped by the unchanged 600-second case watchdog (`600091 ms`) while executing the library/browser Enhanced VVC cell of the enlarged 36-cell matrix; its geometry, diagrams, incremental-index and source-analysis panel cases all passed. The matrix is now three independently required cases: MP4, legacy FLV and Enhanced FLV, 12 combinations each. Both engines run all three, with the same assertions, per-operation limits and 600-second case budget. The unfiltered CLI still runs all 36 combinations. A contract checks that the partitions cover every original fixture exactly once and own distinct evidence directories; CI uploads those directories. No performance threshold or timeout was increased.

## 第二阶段 fMP4 检查点

从 FLV 合入后的 `68e44e2` 开始。共享 `mp4-config.ts` 已映射完整、自包含、未加密、单视频轨/单 stsd 的 init + moof/mdat，播放和分析共用整轨 decode-order AU。Mediabunny 1.55.7 的分片 sequenceNumber 为 moofOffset + 片内 index，仅用于交叉验证定位，不作为 AU。支持 trex/tfhd/trun 默认值优先级、多 run、显式 base_data_offset / default-base-is-moof、signed data_offset、tfdt v0/v1、CTO v0 unsigned / v1 signed；decode clock 必须连续。原始 ticks 与 edit-list 后微秒时间分离。Fragment 不定义 GOP；codec 安全锚和预滚预算沿用既有逻辑。

初始检查点：H.264/HEVC/VVC 三个真实 QA 片源按 payload/config 原样 remux 为 30 个非 GOP 对齐 fragment、每片两个 trun；Node 逐 AU 字节核对、独立首帧/后段块答案、实际软件播放 AU 均通过。WebKit × 本地 H.264 × 软件偏好的当前帧 presented token、独立分析、可见遮罩精确身份、缓存/区间和取消闭环通过（`.run/browser-fixtures/bitstream-analysis-matrix-fmp4-webkit/matrix.json`）。`npm run build` 通过。下一步扩展解析负例、整片 drain、IO/缓存与完整浏览器矩阵；此检查点尚不代表最终验收。

混合普通 samples + fragments、外部 init/.m4s、增长直播、多配置/多视频轨、加密/样本分组、decode 时间断裂或回退、隐式跨 traf 基址、损坏/截断分片不支持；继续容器 fallback 或明确拒绝精确分析。TS/MKV 仍由 #59 后续阶段跟踪。本阶段只开 draft PR，不合入、不发版，Refs #59。
