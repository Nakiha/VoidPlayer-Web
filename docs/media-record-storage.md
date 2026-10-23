# FLV / JS-TS 有界记录查询：待确认的存储接口

本后续分支固定依赖 #126 的 `07648c5613e1e6aff376e6b29269bd55dc114337`。
此文是接口提案；**尚未改变写入格式，也未启用 HTTP 记录能力**。
`semantic_json` v1 及 #126 的概览语义保持原样。旧缓存不扫描、不迁移、不补建索引。

## 已验证的障碍

现有 FLV / JS-TS 把整份权威 JSON 放在 `media_index_batches.seq=0` 的 TEXT 列。
本地 Node 24 / SQLite 实验使用 64 MiB TEXT：`octet_length(payload)` 峰值 RSS 增量为 0 KiB；
`substr(payload,32000000,256)` 和 `substr(CAST(payload AS BLOB),32000000,256)` 均约增加 65664 KiB。
只返回 256 字节仍会在 SQLite 内加载整列，不能作为有界记录查询。

SQLite 的真正增量 TEXT/BLOB 读取是独立的
[incremental BLOB I/O 接口](https://www.sqlite.org/c3ref/blob_open.html)；
项目当前统一数据库适配只暴露 exec/prepare/close，未提供跨 Node/Bun 的增量 BLOB 句柄。

## 建议确认的接口

仅对后续**新显式提交**采用独立版本的 packet 存储布局，复用同一 `media_index_batches` 表：

- 在 manifest 添加独立可空的 `packet_storage` 描述符，schema/version 与 `semantic_json` 分开。
- `seq=0` 保存去掉 packets 的原文档元数据；记录查询永不读取此列的内容。
- `seq=1..N` 保存原 packets 数组的连续片段，不排序、不删包、不创建第二份包索引。
  建议每片最多 64 条、64 KiB；原记录、配置编号、原始时间戳及缺值保持不变。
  单条过大或不支持布局明确返回记录不可用，不能绕过预算。
- 按原包数组序号稳定分页，ordinal 可由固定片长和片内 offset 验证，不为分页构造另一套权威排序表。
  每页仍最多检查 2048 条、返回 256 条，并单独限制累计读取的片段字节数及响应体。
- 包片、描述符、JS seal 和 #126 小头同事务提交；重复提交不混用证据。
  包片修改/替换/删除同时使描述符和小头失效，旧游标必须冲突。
- 原 GUI 的 get/has/紧凑 NDJSON 适配重组同一份原文档，保持既有对象及网络协议兼容；
  原本就返回完整索引的 GUI 路径不作为语义查询的读取入口。
- 旧单列 JSON 缓存保留概览和原 GUI 读取；记录能力返回明确的 storage-unavailable。
  即使用户再次读取，也不隐式重写、迁移或开始构建。

需要确认的是这个**新提交的权威存储布局边界**，不是要求 #126 任务修改分支。
在确认前，本分支仅推进不依赖存储的共享投影和真实片源测试。

## 已实现的独立语义部分

`committed-record-query.ts` 保留源包顺序，支持原始 PTS/DTS 的半开区间过滤，
不把 presentation rank 当作 decodeOrdinal。TS 的派生呈现时间和索引估计时长单列说明，
不填补缺失 raw PTS/DTS，不把索引时长转换成容器 durationTick。
FLV 配置变化及显式 discontinuity 保留；TS 未记录的 discontinuity 为 null。

范围只过滤原始时钟值；不展开 33 位 PES 或 FLV 时钟回绕，不宣称跨 discontinuity 的连续时间轴。
FLV normalizedPtsUs 仅做原始时钟减去首个解码包 PTS，明确不是展开后的经过时间；TS 原点未建立时为 null。
QP、pictureType 和经过验证的随机访问均不从容器/包标志推断。

测试包含真实 H.264 FLV、H.264 TS、MPEG-2 TS 的逐包对照。原始 TS 时间戳另读 PES 头验证：
ffprobe 会补推部分 MPEG-2 DTS，不能把它的非空值当作源 PES 中存在 DTS 的证据。
