# 媒体技术发现与显式准备 v1

管理页「技术发现」与无 GUI HTTP Agent 使用同一共享契约
`shared/media/discovery.ts`、服务命令和持久事实。入口为
`GET /api/library/discovery-schema`；结构化能力在 `/api/agent` 的
`libraryDiscovery` 和 `library.discovery` / `library.preparations`。

## 发现、筛选与身份

`GET /api/library/discovery?codec=h264&bitDepth=10&limit=16` 在已注册媒体行上查询，
可指定 `root`、路径子串 `search`、codec、min/maxWidth/Height、bitDepth、
colorTransfer、min/maxDurationUs、`recordsReady=1`。同一视频证据流内条件为 AND，
流间为 OR，不拼接不同流、缓存 namespace 或 probe/cache 的字段。
无技术条件时列出已注册行，不要求先 probe；match 始终不是评分准入。

优先使用当前版本已准备元数据；缺少时复用已有有界缓存摘要。
`recordsReady=1` 只使用带原 namespace/build 的缓存证据。每来源最多投影四个身份
加一个 lookahead，每身份至多 45056 字节的 metadata/header/storage，
不读 packet document/batch；冲突、截断或不可用保持 unknown。recordsReady
只表示记录适配器声明可用，不重哈希包负载，不证明整个缓存完好。

字段携带 value/status/source/reason，未知值为 null。known 是元数据证据，
不是解码验证。`container-or-codec-metadata` 明确表示固定解析器未公开哪个声明优先，
不能称为 SPS/容器一致性认证。SAR/rotation 的解析器默认值标 derived，不能满足
精确筛选。pixelFormat 是编码配置的名义采样/位深，不能当解码资源布局。
durationUs 是容器声明的整数微秒，不是解码时长或 CFR。

`GET /api/media/ID/discovery?v=VERSION` 返回文件属性、技术证据、各流、时钟及链接。
ID/version 是媒体库的 stat 身份，不是内容哈希认证；读取只观察数据库记录的状态，
`liveChecked=false`，不保证路径此刻可访问。流 ID 仅在该解析结果中有意义。
timeBase 是原容器 tick 的秒比例，origin=null，relationToQualityAu=not-established；
不得按相等 PTS 将它拼成质量 AU。可信评分身份继续通过既有 psnr-source/psnr-frames
获取，包含源版本、namespace/build、stream/configuration/AU 及原时钟。

每页最多返回 32 行、处理 64 个候选加一个 lookahead，响应至多 256 KiB。
按媒体 ID 主键索引 keyset seek，不执行每页 COUNT、OFFSET 或路径全排序。
root/path/state 条件只在当前有界候选窗内判断；稀疏搜索可能连续空页且带 nextCursor。
候选累计数与范围内已检查数分开；total 在穷尽前为 null，穷尽后才是范围内登记行总数。
继续页必须重复相同筛选、scope、includeUnknown 和 limit，附 opaque cursor；
服务 HMAC 验证游标并绑定数据库快照。来源、probe 或缓存变化/服务重启返回
409 discovery-snapshot-changed，须从第一页重新开始。page 与 cumulative 计数分开；
只有 exhausted=true 才给全 scope match/unknown/notMatch 数量。
includeUnknown 默认 1，不把未知算成负例。scope 是已注册行，
filesystemCompleteness=not-established，目录扫描状态另查 /api/library/scan。

## 首批 probe 支持范围

| 容器 | 可观察范围 | 流清单 | 评分 |
| --- | --- | --- | --- |
| FLV / Enhanced FLV | 固定前缀初始音视频信息/尺寸/位深等 | 不完整，不证明音频或多轨缺席 | 仍须既有可信 FLV 质量准入 |
| MP4 / QuickTime | 固定解析器元数据与初始配置 | 有界初始 trak，包括字幕/data/未知 | 未支持 |
| Matroska / WebM | 固定解析器元数据与初始配置 | 有界初始 Tracks，包括字幕/data/未知 | 未支持 |
| MPEG-TS | 有界初始节目/配置 | 不完整，不证明后续节目/配置 | 未支持 |

streamInventoryComplete 仅表示初始容器声明已完整覆盖且与解析器公开轨道一致，
不是完整包/帧/配置变化清单。头部子预算或解析器不一致使其 incomplete。
FLV 前缀严格限制在 64 KiB 内、至多处理 8 个 tag 头、配置至多 4096 字节，
报告已处理头数/结束位置/停止原因。纯音频返回初始容器/AAC 配置信息，
不认证所有音频包或实际解码输出；无视频或迟到视频保留未知，
不为寻找视频走到 EOF。probe 不调用外部 ffprobe、解码器或全包扫描；TS 可读初始配置包，全部 IO 计费。
固定 Mediabunny 1.55.7；独立 FFprobe 仅用于合成测试素材的事实对照。

## 显式服务持有任务

```http
POST /api/library/preparations
Origin: 同源
Content-Type: application/json
X-VoidPlayer-Action: library-preparation
X-VoidPlayer-Actor: 发起时捕获的身份
Idempotency-Key: 本次操作固定键

{"source":{"id":"ID","version":"VERSION"},"operation":"probe","client":{"id":"agent-1","name":"Selection Agent"}}
```

cookie actor 必须与捕获身份一致，失配在副作用前返回 409 actor-changed。
首次受理 202；同 actor/client/key 和规范化正文重放 200，同键异正文 409。
先查回执再查来源/结果，因此版本改变、probe 被回收后仍能重放原任务。
丢响应须原键原正文重试，不另造任务。临时数据库不提供持久准备，返回 503。

GET collection 返回当前 actor 的历史摘要（limit 1..32、before=next），
GET /JOB 返回详情。其他 actor 为 404。关闭窗口/断开观察不取消服务执行。
POST /JOB/cancel，正文 `{}`，显式取消；running 到 cancelling 后必须待真实 IO/DB
关闭、Worker 物理退出才释放准入。queued 未运行可直接 cancelled。
完成与取消竞争以持久事务终态为准；完成结果和 probe 事实原子发布。
重启后未完成任务为 interrupted，不自动重试、不共享计算。

probe 固定预算：实际读 4 MiB、512 次 OS read、32 流、32 KiB 结果、256 MiB
Worker heap、30 秒执行 deadline；初始头部见证另有 256 次/2 秒子预算。
deadline/取消撤销后，迟到回调不能继续读取或发布；若 OS IO 尚未结束，settlement
延长到 IO drain 和物理退出，绝不提前放容量。退出无法证明则保留许可并报告不可用。

operation=quality-index 单独复用既有 FLV 可信构建的 64 MiB 来源、128 MiB 实际读、
包/索引及 30 秒预算，不给其他容器造质量身份。取消竞争可能留下已经提交的合法缓存，
应重新只读查询。所有实际准备与评分、索引/码流工作共享实例现有独占执行准入。
准备队列自身最多 8 个、每 actor 4 个，60 秒到期；历史最多 1000 行/64 MiB 预留。
这些不是其他子系统队列的合计上限。队列忙不伪造 attempt，不显示猜测百分比。

GUI 可显式 probe/构建、看历史/取消、检查评分前提并打开带精确源版本的评分选择器。
它不选择近似 AU、不自动配对、不控制原播放器。metadata 可读不等于可测量。
reference integrity 仍未认证，concealment detection unavailable；既有性能负结果不变。

## 验证与剩余范围

清单登记 Node/Bun HTTP/状态机/IO 与物理退出围栏，固定 FFprobe 对照合成
FLV/MP4/MKV/TS 8/10 位、缺色、三轨和纯音频/无视频/迟到视频素材，真实 Chromium/WebKit 选择/准备/丢响应
重放/关闭观察/actor 迟到/取消/缓存复用/原播放器隔离，以及编译包空 PATH 下真实
probe Worker 和重启历史。最终候选的三平台与完整 PR CI 仍须实际通过。
100,000 行稀疏检索实测每页最多 65 行候选读取；深页 EXPLAIN 仅主键 SEARCH，
无表扫描/临时排序，穷尽后才给精确范围总数。
本批不完成新容器可信评分、区间任务、全库自动 probe、全部 #120 或整个 roadmap。

播放隔离回归的定时采样证明观察到真实帧推进且观测时仍在播放；不证明采样之间从未发生
短暂停止/恢复。保留同源/generation、位置/帧 PTS 前进、结束时 playing 与页面无错误断言，
不扩大为连续性认证，也不把通过称为旧 WebKit CI 根因已修复。

启动播放的严格后继提取与其他 packet 遍历入口一致：`framesFollowing` 首次 `next` 前启动
已有的 memoized 完整索引，不等待全文件完成；Worker 在实时索引前沿等待后续包。
真实 ST/MT MediaSource 门闩回归会延迟主线程后台启动 timer 与完整索引最终回执，
确认同一个 iterator 可继续输出正确 PTS/原始像素；索引先完成对照、换源物理退出与
服务端索引错误传播也被覆盖。旧版本在 next 先于索引启动时会把有限启动前缀当作 EOF。
该本地因果复现与远端 WebKit 的 ended/零帧症状一致，但远端没有 RPC 顺序记录，
不能据此声称已直接观测其调度顺序。夹具、EOF 语义、core 和播放隔离等待条件不变。
