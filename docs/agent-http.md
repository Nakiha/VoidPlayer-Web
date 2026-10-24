# HTTP Agent 与操作同步

运行服务后，从同一 origin 打开 `/llms.txt` 查看短索引，`/agent.md` 查看工作流程，`/api/agent` 获取版本化 JSON 能力描述。按任务继续读取 `/agent/library.md`、`workspaces.md`、`annotations.md`、`quality.md`、`live-session.md` 或 `errors.md`。这些文件由 `server/agent-guide.ts` 内嵌，GET/HEAD 不依赖前端构建，也不会创建身份、扫描媒体或提交任务。

`implemented` 表示代码支持，`enabled` 表示部署启用，`readiness` 表示当前条件。媒体内容逐源判断，浏览器视图需要活动会话；`quality.frame-pair` 提供受限的[一次性媒体库 PSNR 调用](source-library-psnr.md)，不需要浏览器；`quality.jobs` 提供受限的[单帧 PSNR 持久任务](source-psnr-jobs.md)，qualityJobs 对象列出精确请求/端点/预算，仅支持 psnr + single-explicit-frame-pair。序列、SSIM/VMAF/CAMBI、本机 MCP 桥接和远程 worker 仍未实现；#114/#121 没有整体完成。`/api/health` 的原有字段保持兼容。

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

本阶段交付 #113 的 HTTP 入口与 #119 的首条持久业务链路：标注写入、可追踪事件、GUI 被动观察。工作区业务的统一命令迁移、持久评分任务、任务取消/进度/并发上限、结果证据和计算节点仍按 [roadmap #112](https://github.com/Nakiha/VoidPlayer-Web/issues/112) 推进。

新增 Node 回归覆盖：无前端资源的 HTTP 操作、只读部署、Origin/身份检查、能力状态、重复请求、版本冲突、重启、事务回滚、v1 升级、事件分页及保留窗口。浏览器回归验证先由 HTTP 写入、之后打开 GUI 恢复，及播放 A 时收到 B 的操作仍保持轨道、播放与焦点。

已完成单帧 PSNR 结果可通过同一标注命令入口的 `attach-quality-result` 显式共享到已有标注。精确任务/attempt/digest、媒体版本/实际源 PTS/ROI、幂等重放与导入降权规则见 [PSNR 标注证据](annotation-psnr-evidence.md)。任务私有读取权限不会因共享附件扩大。
