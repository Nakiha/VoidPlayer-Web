# FLV / JS-TS 有界记录查询与权威分片存储

从公开检查点 `1e5b1fc9ee46df3729d0232317ad58c86a3f5aaf` 接续，整合 main
`909bbf2b52bd5fef2abf314f83e139843eaaa3d8`。未取得旧任务未推送的本地内容；
没有恢复全部旧工作或修改旧工作目录。此实现保持 #126 `semantic_json` v1，Refs #120。

## 为什么需要改变新提交的布局

SQLite 的 64 MiB TEXT 即使用 `substr(payload,32000000,256)` 或
`substr(CAST(payload AS BLOB),32000000,256)` 也会物化整列。
`octet_length(payload)` 可以只读列长度；响应分页不能保证读取内存有界。
项目跨 Node/Bun 适配尚未提供增量 BLOB 句柄，因此只在新的显式索引提交时分片。

## 一个权威包表

新增可空 `packet_storage` 描述符，不改 `semantic_json` 版本，也不新建表。
使用现有 `media_index_batches`：

- `seq=0`：原文档元数据，在原属性位置保留 `packets:null`。语义查询永不读取此列。
- `seq=1..N`：原 packets 数组的连续片段，不排序、不删包；每片至多 64 条、64 KiB。
  封装 version/commitId/seq/first/packets/sha256，校验序号、固定片长、末片条数和内容校验和。
- `packet_storage`：独立 schema `voidplayer-packet-storage` version 1，至多 4 KiB；
  绑定唯一 commitId、来源版本、完整索引身份、总条数、片数、片长、原文档及元数据校验和。
  不保存另一份包索引或时间排序表。单片超限时提交失败，不降级为大 TEXT 查询。
- 文档元数据、chunks、描述符、原 JS 文档 seal 和语义头在同一 `BEGIN IMMEDIATE`
  事务提交。任何失败全部回滚。重复/并发提交保留先提交的完整版本，不混用头或 seal。
- 分片 INSERT/UPDATE/DELETE 触发器同时使存储描述符及语义头失效；UPDATE 更换身份
  时旧、新身份均失效。源版本、根目录和清理沿用原失效机制。
- GUI 原 compact JSON / NDJSON 路径在单一事务快照中校验 seal 并重组这些权威片段，检查完整文档
  hash，保留原对象及线协议。该读快照不更新 LRU 或删除坏缓存；
  COMMIT 后才按该快照的完整身份、buildId/分片描述符和 epoch 尽力更新 accessed_at，争用失败不丢弃已验证响应，也不触碰并发替换的新提交。非分片新提交使用唯一 buildId；没有唯一提交标识的旧行跳过 touch，不回填。
  显式 has 的坏缓存清理在独立写事务中重新校验，避免误删并发新胜者。
  GUI 本来就取完整文档；它不是有界语义查询的读取路径。

升级仅添加可空列和触发器，旧缓存不自动回填、改写或迁移。带 #126 头的旧缓存仍可读概览；
无头则保持 unknown。旧 GUI 原样读取旧文档。记录查询返回 `ready=false`，原因
`packet-storage-unavailable-explicit-reindex-required`；显式清除该缓存并重新建索引后才可用。
重复提交不会偷偷迁移已存在的旧缓存。

## HTTP 工作量与一致性

共用原 GET/HEAD `index-query` 与 cursor/axis/半开范围验证：

- 每页至多检查 2048 条，返回 256 条，响应预算 8192–262144 字节。
- packet TEXT 累计读取至多 262144 字节，每次先预留最大 64 KiB 再 SELECT；SQL CASE
  用 `octet_length` 拒绝超限列，绝不对旧整段文档使用 substr/CAST。
  `readBytes` 计算实际取出的整片字节，不只是返回记录字节；`chunksRead` 和 `workLimits`
  随页返回。预算耗尽或不匹配可能产生带 nextCursor 的空页，调用者必须继续。
- 查询上下文列分别限 metadata 32 KiB、semantic header 8 KiB、descriptor 4 KiB；
  每页包读取加上下文至多 300 KiB TEXT，另有固定大小 SQL 标量、解析和响应副本。
  每次最多访问 33 个连续分片（首片可从中途开始），无全表计数/遍历/时间排序。
- 短只读事务固定本页快照；cursor 绑定来源版本、身份、epoch、描述符内唯一 commitId、头、
  描述符和轴/范围。更改、清理、失败、重新提交使旧 cursor 冲突，不能混合版本。
- 每库 8 个在途查询覆盖 stat/realpath、Worker 工作及响应生命周期。断连以共享原子
  标记取消排队/运行中的记录查询，每片及每条检查；取消不提前释放容量。
  查询超时同样等待 Worker 回复或终止才结算。HTTP 发送前再次验证源 stat/realpath。
- 无隐式扫描、解码、探测、构建、缓存迁移或播放头操作。overview 就绪是小头与描述符
  可用，不代表已读完整包表；实际页校验失败返回 `index-cache-invalid`，不返回部分成功页。

## 原始语义与验证

共享 `committed-record-query.ts` 保留源包序号、重排和重复 PTS。
范围过滤原始 PTS/DTS；不展开 FLV/33 位 PES 时钟回绕，不宣称跨 discontinuity 连续。
FLV normalizedPtsUs 仅为减去首解码包 PTS 的原始偏移；TS 原点未知。
TS 派生有效呈现时间和估计时长单列，缺失 raw PTS/DTS 保留 null，不能用 ffprobe
补推 DTS 冒充源 PES 字段。durationTick、随机访问验证、QP、pictureType 保持未知。

已登记测试覆盖真实 H.264 FLV、H.264 TS、MPEG-2 TS 的逐包/HTTP 分页对照，
另读原 PES 头验证 ffprobe 补推 DTS 的差异；覆盖前缀/恢复间隙、缺值、重复、wrap、
旧库无回填、GUI 重组、竞争提交、失败回滚、缺片/重复/过大/损坏分片、版本/来源不符、
取消、读取/遍历/响应预算。媒体只在临时目录生成，不提交或上传。
