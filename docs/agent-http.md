# HTTP Agent 与操作同步

运行服务后，从同一 origin 打开 `/llms.txt` 查看短索引，`/agent.md` 查看工作流程，`/api/agent` 获取版本化 JSON 能力描述。按任务继续读取 `/agent/library.md`、`workspaces.md`、`annotations.md`、`quality.md`、`live-session.md` 或 `errors.md`。这些文件由 `server/agent-guide.ts` 内嵌，GET/HEAD 不依赖前端构建，也不会创建身份、扫描媒体或提交任务。

`implemented` 表示代码支持，`enabled` 表示部署启用，`readiness` 表示当前条件。媒体内容逐源判断，浏览器视图需要活动会话；`quality.frame-pair` 提供受限的[一次性媒体库 PSNR 调用](source-library-psnr.md)，不需要浏览器；`quality.jobs` 提供受限的[单帧 PSNR 持久任务](source-psnr-jobs.md)，qualityJobs 对象列出精确请求/端点/预算，支持单个明确帧对的 PSNR、可选固定变种 SSIM 及至多 64 块源网格，已接持久任务 GUI、共享证据和独立原帧查看。闭合 GOP 的重排/延迟输出使用固定 packet identity ABI1 与 opaque token，不按 PTS 归属 AU。`quality.vmaf` 另提供可选 Linux x64 原生组件的受限连续序列 VMAF；固定官方源码、模型、recipe、原始平面、逐帧与池化结果见 [native-vmaf.md](native-vmaf.md)。它不把稀疏 range 拼成连续视频，也不表示任意 ROI／容器支持。CAMBI、本机 MCP 桥接和远程 worker 仍未实现；#114/#121 没有整体完成。`/api/health` 的原有字段保持兼容。

## 无页面写入

HTTP 客户端先显式 POST `/api/identity` 并保存 cookie，再向 `/api/annotations/spaces/SPACE` 提交 `AnnotationOperation`。必须提供与服务匹配的 `Origin`、对应的 `X-VoidPlayer-Action` 和 JSON Content-Type。用户名与 `client` 是可信内网下的归属声明，不是身份认证；既有同源保护保持不变。

持久目标由 space、标注 ID、`document.media` 中的源 ID/版本和 `mark.frame` 确定。现有文档仍带有 A–H 槽位与 decoder 来源字段；它们是兼容的显示/来源描述，不是要求 Agent 加载轨道或拥有浏览器。媒体描述必须来自已知工作区或实际探测，不能编造；接受标注不意味着服务器验证了帧内容或分数。自解释缓存媒体信息/索引的首批只读接口见 [媒体查询](media-query.md)；完整探测与技术条件筛选仍由 #120 跟踪。

浏览器标注构造和编辑已移到 `shared/review/marks.ts`。`shared/review/annotation-command.ts` 定义与宿主无关的命令验证和持久状态转换；SQLite 适配器负责事务和序列。页面 GUI 与 WebMCP 继续共用 `ReviewSession` 视图行为。HTTP 业务命令不依赖 GUI 是否在线、播放状态、当前帧或选中轨道。

同一请求重试必须保留 operationId、完整原始 payload 和 actor；回执返回第一次提交的结果。对象的 revision 是乐观并发条件。版本冲突先读最新状态再协调，新增意图使用新的 operationId。现有主媒体版本/帧锚点不可移动，删除只能显式 restore 恢复。

## 操作记录与状态恢复

`GET /api/annotations/events/SPACE` 读取最近 50 条保留事件；加 `?after=CURSOR` 每页最多 100 条，按 sequence 升序续读。事件记录操作、请求 ID、actor、声明的 client、对象/修订、源/帧目标和提交状态。对象、回执和事件在同一个 SQLite 事务提交，响应不等待 GUI 消费。

事件是确认的操作历史；`GET /api/annotations/spaces/SPACE?after=...` 是合并过的最新对象状态，二者不能混用。sequence 全库递增，某一空间出现空档是正常的。消费者按 sequence 去重，处理整页后保存 cursor，并继续读取 more=true 的页。

全库保留最近 10000 条事件，幂等回执沿用原有持久策略。游标落后于保留窗口或超前于恢复后的数据库时，响应返回 `resetRequired`、原因、快照入口和当前 cursor。客户端保留本机待提交草稿，完整分页读取并替换已确认状态，再从捕获的 cursor 继续观察。GUI 的活动轮询每轮最多读五页，失败不会阻塞标注同步；活动区不会自动打开、改变播放、替换轨道或移动焦点。

标注数据库升级至 user_version=2。v1 对象与幂等回执保留；升级前没有操作历史，因此较旧事件游标会要求重同步。旧版本程序会拒绝打开升级后的数据库，不支持原地降级。

## 范围与验证

本阶段交付 #113 的 HTTP 入口与 #119 的首条持久业务链路：标注写入、可追踪事件、GUI 被动观察。已交付的持久单帧评分、取消/历史、结果证据、测量候选和 GUI 编排见下列专门文档；其受限范围不代表序列和计算节点完成。剩余能力仍按 [roadmap #112](https://github.com/Nakiha/VoidPlayer-Web/issues/112) 推进。

新增 Node 回归覆盖：无前端资源的 HTTP 操作、只读部署、Origin/身份检查、能力状态、重复请求、版本冲突、重启、事务回滚、v1 升级、事件分页及保留窗口。浏览器回归验证先由 HTTP 写入、之后打开 GUI 恢复，及播放 A 时收到 B 的操作仍保持轨道、播放与焦点。

已完成单帧 PSNR 结果可通过同一标注命令入口的 `attach-quality-result` 显式共享到已有标注。精确任务/attempt/digest、媒体版本/实际源 PTS/ROI、幂等重放与导入降权规则见 [PSNR 标注证据](annotation-psnr-evidence.md)。任务私有读取权限不会因共享附件扩大。


`create-quality-candidate` 在同一标注入口从自有完成结果原子创建测量候选、证据、回执和事件；`candidate.text/severity` 必须明确填写，不能附伪造 document。来源、实际源 PTS、索引起点、时长和 ROI 从结果的 `annotationContext` 派生；旧结果缺少此见证时明确拒绝。候选标记为 `not-subjectively-assessed`，不冒充人工缺陷判断。相同 actor/operationId/正文的回执优先于结果读取，结果回收后仍能重放；跨 actor 的捕获身份不匹配在写入前返回 `actor-changed`。候选导出为工作区/评审 v3，普通证据仍 v2，无证据仍 v1；导入/复制保留事实但服务核验降为 historical。

播放器独立 ROI 入口从已载入媒体显式选择每侧 AU；不继承旧播放 token 的时间戳关联，不自动猜当前帧。独立 Worker 在已有可信缓存上获取原始帧并核验，ROI 吸附偶数源网格；原播放器不暂停、不 seek、不完成索引。后台持久执行不随对话框关闭取消。详见 [ROI 测量候选](quality-roi-candidates.md)。

暂停原生画面另有可选页面工具 `capture_presented_quality_frame`，返回 `voidplayer-native-presented-input` 未绑定见证，不是评分请求。必须将实际同服务版本传输、精确 AU/配置字节/包范围与时钟、可信 cache namespace/build 和几何逐项绑定；不按 PTS 搜索或自动建索引。原生路径不支持时明确拒绝，HTTP Agent 的显式 AU 业务能力不受此 GUI 子集限制。缺缓存可单独显式 `POST /api/media/{id}/psnr-index`（`{version}`、actor cookie/header、同源 Origin、action `quality-source-build`）；读取、快照和评分不会调用它。预算、取消和原始像素边界见 [暂停原生帧 ROI](paused-native-quality.md)。

媒体库已注册来源的技术选片、未知覆盖、一致分页和显式有预算 probe/可信 FLV 索引准备，使用 [媒体技术发现](library-discovery.md) 的同一 GUI/HTTP 命令。`/api/library/discovery-schema` 给出字段、请求、状态机、预算和支持矩阵；MP4/MKV/TS 元数据可读不等于可评分。
