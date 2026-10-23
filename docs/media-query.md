# Agent 缓存媒体信息与索引查询（#120 第一部分）

入口：`/llms.txt` → `/agent/library.md` → `/api/media/query-schema`。
`/api/agent` 中 `media.cached-info`、`media.cached-index-query` 区分实现、部署启用和逐源就绪；`media.technical-filter` 仍不可用。

## HTTP 工作流

1. `GET /api/library/browse?recursive=1&search=clip&limit=20`：按既有路径/文件名检索。分页携带同一 revision，冲突后从头开始。
2. `GET /api/media/ID/info?v=VERSION`：验证媒体仍在允许根目录、在线且版本匹配；读取文件属性及最多 16 个缓存流。`nextOffset` 续读缓存身份清单。每请求独立快照，清单变化时可重读；不是完整源流枚举。
3. 复制某项 `identity` 为 `kind`、`stream`（streamKey）、`schema`（schemaVersion）、`indexer`（indexerBuild）：
   `GET /api/media/ID/index-query?v=VERSION&kind=ffmpeg&stream=video:0&schema=3&indexer=BUILD`
4. 查看 `overview.capabilities.records.ready`、时基与覆盖，再加 `view=records&axis=pts&startTick=0&endTick=90000&limit=100&byteBudget=65536`。区间为原始流 ticks 的半开区间；endTick 可用 9223372036854775808 包含最大有符号 64 位时间戳；只有时基 1/90000 时 90000 ticks 才代表一秒。`axis=dts` 也可用。
5. 携带 `nextCursor` 和相同源、版本、流身份、axis、时间范围续读。空结果页仍可能有下一页。逐页累加 `summary` 才能形成该快照的范围统计；`exhausted` 不代表媒体覆盖完成。

所有接口支持 GET/HEAD；不创建身份，无需 GUI，沿用部署的读取权限与根目录边界。它们只做 stat/realpath 与缓存读取，不读取媒体内容、不迁移旧索引、不扫描/解码，不触碰当前播放头。未知参数（含 `build=1`）、重复参数及非法整数直接拒绝。原 `/metadata`、紧凑 `/frame-index` 与 GUI 行为不变。

可执行的 curl 示例见内嵌 `/agent/library.md`。缺缓存时返回缺口，不提供会悄悄启动工作的链接；现有 GUI/显式旧建索引入口维持原行为。带持久任务记录和准入的新 probe/build 接口待后续实现。

## 语义与边界

- `schema=voidplayer-media-query, version=1, describedBy=/api/media/query-schema`。每页包含源版本、流身份、时基、覆盖、字段状态及分页上下文。
- 文件 size 是字节，lastModified 是 Unix 毫秒。技术字段来自特定缓存流，有 value/status/source/reason；未知为 null。codec、索引器报告的 width/height、时基与流号可用；coded/visible 区别、色彩标签、profile、SAR、rotation、位深、帧率性质等没有缓存证据就不推测。
- 包记录保留原 PTS、DTS、duration 和 decodeOrdinal。64 位整数用十进制字符串避免精度损失。归一化 PTS 仅在 originVerified 时计算，取整与共享 FFmpeg 统计适配器一致。缺时间戳不替换成零或平均帧率。
- 记录按缓存 PTS 序（未知 PTS 尾部）返回，包括 DTS 条件查询；decodeOrdinal 保留解码序，重复 PTS 不合并。时间条件不包含缺该 axis 的记录，`inspectedUntimed` 只统计本页检查到的缺失值。
- 粒度是容器 packet；不保证一包等于一个 sample/AU/decoded picture。containerKey 不是随机访问验证；I/P/B、QP 和验证结果保持 null。压缩 payload 字节不是像素内存或传输流量。
- `not-indexed` 表示缓存缺失；`unknown` 表示旧格式/尚无语义适配；`partial` 包括构建中、失败、仅保留有效前段和完整性未知；`complete` 要求终态且索引显式声明完整。`terminal` 与覆盖独立，完成的截断索引仍为 partial。
- scannedBytes 是扫描进度，stablePresentationUs 是独立的排他稳定水位，不是媒体时长。上传/旧缓存未提供可信水位时为 null。终态索引也可能有缺 PTS/DTS 的包；不能因此假定 CFR、完整呈现帧数或有效评分输入。
- 每页最多检查 2048 个缓存记录、返回 256 条，响应预算 8192–262144 字节。SQL 先用 octet_length 检查磁盘列长度；仅对不超过 64 KiB 的 batch 取最多 128 条记录的片段，超限/损坏缓存返回 index-cache-invalid，不展开大 TEXT。metadata 同样限制 32 KiB；不加载整份索引。库 I/O 在既有数据库 Worker 中执行，查询持有短只读事务；每个库至多接纳 8 个在途缓存查询，覆盖文件校验、数据库读取及响应完成/断开全过程；繁忙时返回 503 + Retry-After。摘要是本页返回条数、压缩字节和容器 key 数。
- 游标绑定媒体版本、索引身份、epoch、构建快照和查询条件；增长、失败、完成、替换或清理返回 409 `index-snapshot-changed`。丢弃旧页后重查，不混用两个快照。正在频繁增长的索引可能需要等构建稳定后才能完成多页统计。
- 版本改变返回 `media-version-changed`；文件离线/路径边界失败返回 `media-unavailable`。响应不含绝对路径、内部配置或原始数据库错误。

## 首批矩阵与未完成范围

| 数据来源 | 本批行为 |
| --- | --- |
| FFmpeg schema 3、已分批缓存、支持的流身份 | 技术信息、概览、原始 PTS/DTS 区间记录和分页统计；真实 AVI/FFV1、MPEG-PS/MPEG-2 用 ffprobe 包信息对照 |
| 历史 FFmpeg 未拆分文档 | unknown / semantic-adapter-unavailable；读取不隐式迁移整份文档 |
| FLV、JS TS、JS Matroska 缓存 | 发现身份与构建状态，语义字段/记录明确不可用；既有紧凑读取保留 |
| MP4、FLV、TS 等没有上述 FFmpeg 缓存的媒体 | 文件信息可读，缓存缺失为 not-probed / not-indexed；不暗中改用另一容器解析器或解码器 |

本批不关闭 #120。完整 MP4/FLV/TS/Matroska 语义适配、技术条件筛选的覆盖/未知统计、完整流列表与 codec/色彩探测、持久探测/建索引任务、优化按时间定位及跨页聚合服务仍待实现。大范围查询按游标渐进检查缓存，未新增一套媒体索引。文件名、尺寸、时长相似仅是检索线索，不能证明参考配对内容与时间对齐。

首批开发固定依赖 #124 的 `036e951ad778725cbefd809487a76581ef58a592`。最终合并前必须基于合并后的 main 整合并重新验证；不修改 #124 的活动 UI、持久化浏览器测试或 identity CI，也不涉及评分、集群或 FFmpeg 实验。
