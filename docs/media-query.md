# Agent 缓存媒体信息与索引查询（#120 分阶段交付）

入口：`/llms.txt` → `/agent/library.md` → `/api/media/query-schema`。
`/api/agent` 中 `media.cached-info`、`media.cached-index-query`、`media.technical-filter` 区分实现、部署启用和逐源就绪。技术候选筛选 v1 见下文；不是全库探测。

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
- 文件 size 是字节，lastModified 是 Unix 毫秒。技术字段来自特定缓存流，有 value/status/source/reason；未知为 null。FFmpeg 的 codec、索引器报告的 width/height、时基与流号可用。新 FLV/TS 提交还提供容器、TS PID、初始配置头可解析的 coded/visible 尺寸；色彩标签、profile、SAR、rotation、位深、帧率性质等没有缓存证据就不推测。
- 包记录保留原 PTS、DTS、duration 和 decodeOrdinal。64 位整数用十进制字符串避免精度损失。归一化 PTS 仅在 originVerified 时计算，取整与共享 FFmpeg 统计适配器一致。缺时间戳不替换成零或平均帧率。
- FFmpeg 记录按缓存 PTS 序（未知 PTS 尾部）返回；FLV/TS 按原包数组顺序返回，包括 DTS 条件查询。`overview.recordSemantics` 明示排序、原始值过滤、时钟模数与未验证连续性；decodeOrdinal 保留解码序，重复 PTS 不合并。时间条件不包含缺该 axis 的记录，`inspectedUntimed` 只统计本页检查到的缺失值。
- 粒度是容器 packet；不保证一包等于一个 sample/AU/decoded picture。containerKey 不是随机访问验证；I/P/B、QP 和验证结果保持 null。压缩 payload 字节不是像素内存或传输流量。
- `not-indexed` 表示缓存缺失；`unknown` 表示旧格式/尚无语义适配；`partial` 包括构建中、失败、仅保留有效前段、FLV 恢复间隙和完整性未知；`complete` 要求终态且索引显式声明完整。`terminal` 与覆盖独立，完成的截断索引仍为 partial。
- scannedBytes 是扫描进度，stablePresentationUs 是独立的排他稳定水位，不是媒体时长。上传/旧缓存未提供可信水位时为 null。终态索引也可能有缺 PTS/DTS 的包；不能因此假定 CFR、完整呈现帧数或有效评分输入。
- 每页最多检查 2048 个缓存记录、返回 256 条，响应预算 8192–262144 字节。SQL 先用 octet_length 检查磁盘列长度；仅对不超过 64 KiB 的 batch 取最多 128 条记录的片段，超限/损坏缓存返回 index-cache-invalid，不展开大 TEXT。metadata 同样限制 32 KiB。FLV/TS 使用独立分片布局，每页至多读取 256 KiB 包分片，64 条/64 KiB 每片，另有 8 KiB 语义头与 4 KiB 存储描述符；永不读取 seq=0。响应分页不是有界存储读取的替代。库 I/O 在既有数据库 Worker 中执行，查询持有短只读事务；每个库至多接纳 8 个在途缓存查询，覆盖文件校验、数据库读取及响应完成/断开全过程；繁忙时返回 503 + Retry-After。摘要是本页返回条数、压缩字节和容器 key 数。
- 游标绑定媒体版本、索引身份、epoch、构建快照和查询条件；增长、失败、完成、替换或清理返回 409 `index-snapshot-changed`。丢弃旧页后重查，不混用两个快照。正在频繁增长的索引可能需要等构建稳定后才能完成多页统计。
- 版本改变返回 `media-version-changed`；文件离线/路径边界失败返回 `media-unavailable`。响应不含绝对路径、内部配置或原始数据库错误。

## 缓存技术候选筛选 v1

从 browse 取得固定 ID/version 后，调用 `GET /api/library/technical-filter?candidate=ID@VERSION&codec=h264&minWidth=1280&recordsReady=1`。一次提供 1–8 个不重复 candidate；多源重复 candidate 参数。codec 为忽略大小写的精确 token，不做别名推断；minWidth/maxWidth、minHeight/maxHeight 为 1–16384 的闭区间，可组合，recordsReady 只支持 1。至少一个条件，byteBudget 为 8192–262144，默认 65536。共享字段契约发布在 `/api/media/query-schema` 的 `technicalFilter` 字段，`/api/agent` 的 `technicalFilter` 给出版本、入口和边界；可直接运行的 curl 在 `/agent/library.md`。

所有条件必须由同一缓存身份与同一 stream 的证据满足，不能把一个身份的 codec 与另一个身份的尺寸拼成 match。每条 evidence 绑定完整 identity，给出 match/not-match/unknown、条件检查和 value/status/source/reason；旧 schema、缺失/不支持/partial/冲突均为 unknown，即便另一个条件已不匹配也不将不完整合取当已知反例。同 streamKey 的已知 codec/尺寸相互冲突时，相关证据保守降为 unknown。来源级有返回的匹配证据才为 match，否则始终 unknown：`streamInventoryComplete=false`，未观察到的流可能匹配，不能宣称整个源不含目标流。

尺寸证据范围：FLV/TS 为 initial-codec-configuration，FFmpeg 为 cached-stream-metadata，不承诺每幅图像。recordsReady 只反映现有有界 overview 的记录适配器声明；不读取/重哈希包负载，不能证明每片均完好。离线候选保持 unknown，固定版本已改变或已不在允许根目录则 409。此旧候选接口仍不提供 duration、位深和色彩 probe；新增全库发现/显式准备见 [媒体技术发现](library-discovery.md)。新接口不改变此 v1 接口的范围，也不代表 #120 整体完成。

v1 是一次性有界候选查询，**没有一致分页**。每候选最多检查 8 个身份并读 1 个 lookahead，按复合主键前缀读取，无 COUNT/全库扫描；两次投影用于读取与最终验证。每身份只物化至多 32 KiB metadata、8 KiB semantic header、4 KiB packet descriptor，单次请求两轮总投影 TEXT 上限 6,488,064 字节，身份字符串另有限长。记录 document/packets/batches 不读取；响应不超过 byteBudget。达到身份/响应限制时 `truncated=true`，被省略的匹配证据不能留下隐藏 match。libraryTotal/nextCursor 始终 null，cursor/offset 参数拒绝；不同候选批次是独立观察，不可累计为同一快照的全库数量。

每轮在短只读事务内读取同一快照，来源 stat/realpath 前后校验；其后在 Worker 用新快照复核。snapshot 绑定规范化条件、固定来源版本、可见投影、库 revision、连接变更计数、Worker 实例和已验证的来源可用性；它仅标识这次证据，不能复用为 cursor。索引新提交、增长、替换/清理、来源变化及同连接重建均可要求 409 `technical-evidence-changed` 后重新 browse/查询，不能只依赖 library_revision。无关数据库写入也可能保守触发 409。每库与其他缓存查询共享 8 个在途容量，断连/超时仍等 Worker 或尚未结束的来源校验返回后释放。只读查询不触碰 LRU，不触发 probe/扫描/建索引/迁移/解码/后台任务，不移动播放头；未改 FrameIndexStore 事务。

## 首批矩阵与未完成范围

| 数据来源 | 本批行为 |
| --- | --- |
| FFmpeg schema 3、已分批缓存、支持的流身份 | 技术信息、概览、原始 PTS/DTS 区间记录和分页统计；真实 AVI/FFV1、MPEG-PS/MPEG-2 用 ffprobe 包信息对照 |
| 历史 FFmpeg 未拆分文档 | unknown / semantic-adapter-unavailable；读取不隐式迁移整份文档 |
| 新提交 FLV schema 3 | 有界技术头、两条原始时间轴观察范围、分片记录查询与分页统计；FLV 原生毫秒在缓存中缩放为整数微秒；截断/恢复间隙保持 partial，上传缓存不能证明完整扫描 |
| 新提交 JS TS schema 2 | 有界技术头、原始 PES PTS/DTS 分片记录查询与统计、PID 与有效呈现范围；原始时基 1/90000；派生 PTS 与缺失 raw PTS/DTS 分开 |
| 旧 FLV / JS TS 缓存 | 有 #126 语义头仍可读概览，无头则 unknown；记录不可用并明确要求显式重新索引，原 GUI 仍可读，查询不回填或扫描 |
| JS Matroska 缓存 | 发现身份与构建状态；本阶段尚无语义适配 |
| 没有支持缓存的 MP4、FLV、TS 等媒体 | 文件信息可读，缓存缺失为 not-probed / not-indexed；不暗中改用另一容器解析器或解码器 |

本批不关闭 #120。MP4/Matroska 语义适配、全库技术条件筛选及覆盖/未知统计、完整流列表与 codec/色彩探测、持久探测/建索引任务、优化按时间定位及跨页聚合服务仍待实现。包记录的大范围查询按游标渐进检查缓存，技术候选筛选 v1 则不提供 cursor；未新增一套媒体索引。文件名、尺寸、时长相似仅是检索线索，不能证明参考配对内容与时间对齐。

第一批开发固定依赖 #124 的 `036e951ad778725cbefd809487a76581ef58a592`。最终合并前必须基于合并后的 main 整合并重新验证；不修改 #124 的活动 UI、持久化浏览器测试或 identity CI，也不涉及评分、集群或 FFmpeg 实验。


## FLV / JS-TS 提交语义头（第二小阶段）

本阶段以 #125 候选 `90b0502b28fc67e425b779a17dfa9a7a241b1611` 开始，已整合其合并后的 main `aabb88eb5c95e0c6b359f8f2933e5243bc0d6491`。只扩展已提交缓存的技术信息与覆盖概览；不关闭 #120，不新增后台任务系统、评分、集群或编解码实验。

- 在既有 `prepareFrameIndex` / `commit` 写入路径投影已验证的权威文档，单独保存 `voidplayer-committed-index` v1 语义头，与包表同事务提交。每头含源版本、索引身份、schema、来源、统计和时钟，封装上限 8 KiB，校验和检测损坏。语义头投影只遍历已有有界包数组，不新建包表或新增排序；尺寸解析复用共享 AVC/HEVC 配置解析器，上限 4 KiB，配置变更、未识别配置保持未知。
- `semantic_json` 是附加的可空列；升级不展开或回填旧文档。原 `metadata_json`、manifest 和紧凑包表协议保持兼容。重复/并发提交以已存在的整份文档为准，不能把另一份文档的头或 JS 校验值写入。删除、替换或修改包表会通过 SQLite 触发器使头失效；源版本、源离线和根目录变化沿用原失效边界。
- 读取先检查 SQL `octet_length`，只取至多 8 KiB 的头（原 FFmpeg metadata 仍限 32 KiB），不读取、hash、扫描或迁移整份 FLV/TS 文档；每页仍至多 16 个身份、每库至多 8 个在途查询。头校验失败、源/身份/计数不匹配返回 `semantic-header-invalid`；超限返回 `semantic-header-too-large`，未知版本返回 `semantic-header-version-unsupported`，均为 `unknown`，字段值为 null。读取只检查小头，`evidence.validation` 明示不重新验证包文档内容。
- `coverage.pts` / `.dts` 的 `minTick`、`maxTick` 是**包含端点的观察极值**，不能当作连续覆盖或时长。`count`/`missing` 分别计数；重复 PTS 包仍计入记录和负载。`coverage.effectivePtsUs` 是有效呈现极值，TS 可能含派生时间，不能填入 raw PES PTS/DTS；PES 的 33 位时钟不会在此推定展开。`continuousPresentation` 和 `stablePresentationUs` 保持 null。
- FLV `clock.timeBase` 为 1/1000000（缓存原始整数微秒），`nativeTimeBase` 为 1/1000；原点遵循 `flvMediaTiming` 的首个解码包 PTS，早于原点的重排包仍保留。TS 原始时基为 1/90000，播放/解码后的时间原点在此未知。
- `statistics.payloadBytes`、`indexKeyCount` 与原权威包表一致，涵盖未计时包；key 是索引解析器分类，不能推断 decoded picture、I/P/B、QP 或经过验证的逐帧随机访问。`evidence.geometryScope=initial-codec-configuration` 的尺寸只描述初始配置，不保证每张画面恒定。`indexedDurationUs` 标记 `derived`，复用索引跨度及尾包时长估计；`durationUs`（容器时长）仍未知，不强行判定 CFR/VFR。
- FLV 的服务端扫描与经过结构验证的上传分别标为 `server-scan` / `validated-upload`。上传不证明完整扫描，`scannedBytes=null`、完整性未知。前缀与恢复间隙分别报告，终态不等于完整覆盖。TS `integrity` 沿用原解析器；`coverage.recovery` 单独保留 late-PSI 恢复方法，不伪造 FLV 间隙数。
- FLV/TS 现有路径只提交终态文档，扫描中/失败记录未持久保存；因此 `cache-miss` **不能判断任务没有运行或已经失败**。本阶段不改变任务生命周期。若持久 manifest 明确标为 building/failed，概览保留 partial / 对应原因，不声称完成。
- 第三小阶段已启用 FLV/TS 记录适配。仅新显式提交使用版本化分片；旧单文档缓存 `ready=false`，原因 `packet-storage-unavailable-explicit-reindex-required`，不回填。详见 [分片存储约定](media-record-storage.md)。

普通 HTTP 示例（先从 browse 获得 ID/VERSION）：

```sh
curl -fsS "$BASE/api/media/$ID/info?v=$VERSION"
curl -fsS --get "$BASE/api/media/$ID/index-query" \
  --data-urlencode "v=$VERSION" --data-urlencode 'kind=flv' \
  --data-urlencode 'stream=video:0' --data-urlencode 'schema=3' \
  --data-urlencode 'indexer=flv-demux-v3'
# TS 的身份从 info 复制，indexer 是确切版本，不猜测未来 build。
curl -fsS --get "$BASE/api/media/$ID/index-query" \
  --data-urlencode "v=$VERSION" --data-urlencode 'kind=js-ts' \
  --data-urlencode 'stream=video:0' --data-urlencode 'schema=2' \
  --data-urlencode "indexer=$TS_BUILD"
```

回归入口已登记在 manifest：`test/unit/committed-index-query.test.ts` 覆盖时间戳/缺值、旧库升级、错误头、超大文档、重复提交、失效和 HTTP；`test/media/committed-index-query.test.ts` 用 ffmpeg 临时生成 H.264 FLV、H.264/MPEG-2 TS，连同尾部损坏及 FLV 重同步，与共享索引统计及 ffprobe 对照，检查 GET/HEAD、info 和原 GUI 紧凑接口。测试媒体仅在临时目录生成，不上传样片。


## FLV / TS 记录查询示例

```sh
curl -fsS --get "$BASE/api/media/$ID/index-query" \
  --data-urlencode "v=$VERSION" --data-urlencode 'kind=flv' \
  --data-urlencode 'stream=video:0' --data-urlencode 'schema=3' \
  --data-urlencode 'indexer=flv-demux-v3' --data-urlencode 'view=records' \
  --data-urlencode 'axis=dts' --data-urlencode 'startTick=0' \
  --data-urlencode 'endTick=1000000' --data-urlencode 'limit=100' \
  --data-urlencode 'byteBudget=65536'
```

此例查原始 FLV 缓存微秒的 `[0,1000000)`。TS 复制 info 中的身份，原始 ticks 为 1/90000。
`durationTick` 不填派生时长；TS `effectiveDurationUs` 单独标注 index-derived，
`timestampSource` 分开 flv-tag / pes / derived。缺 DTS 保留 null，不能使用 ffprobe 补推的值。
FLV `normalizedPtsUs` 是减去首解码包 PTS 的原始值偏移，不展开 wrap；TS 归一化未知。
断连通过共享取消标记中止数据库遍历；容量直到 Worker 真正结束才释放，超时也不能提前释放。

全库技术发现使用独立的 `/api/library/discovery` 快照游标协议，保留未知与覆盖统计；旧 `/technical-query` 候选协议保持上述限制。新 probe、持久准备任务及 GUI/Agent 选片契约见 [媒体技术发现](library-discovery.md)。
