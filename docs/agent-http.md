# HTTP Agent 与操作同步

服务入口为 `/llms.txt`、`/agent.md` 和 `/api/agent`；能力描述只包含当前提供的媒体库、缓存查询、工作区、标注和页面桥。操作目录位于 `/api/agent/tasks`，它描述调用流程，不保存后台任务。

## 无页面写入

只读媒体库 `GET /api/library/browse` 支持私有 ETag 条件读取。校验身份绑定实例、查询范围、分页、库修订、数据库变化、缩略图 epoch 和完整扫描/根目录状态；先验证参数及指定 revision，再在 COUNT/行排序之前判断 304。错误继续 `no-store`，旧客户端无需发送条件头。缩略图在核验源可访问性和版本后按 JPEG 内容响应 ETag，已清除或换源不能由旧标签返回 304。浏览器在当前视图持有对应响应，不跨查询替换缓存。

管理概览可用 `GET /api/admin/status?view=overview` 省略请求历史，默认 status 保留旧 wire。`GET /api/admin/requests?page=1&pageSize=40` 查询保留的运行日志，返回 `recentRequests`、`page`、`pages`、`pageSize`（默认 40，范围 1–100）和 `total`；单页记录仍按时间正序，管理页倒序展示。支持绑定当前 actor 和页内容的私有条件读取；管理 GET 不列入记录。`GET /api/admin/logs?page=1&pageSize=40` 同样支持页码、总页数、总条数，原 `before` 游标调用继续可用。页码须为正安全整数，越过末页时返回最后一页。GUI 仅在请求视图首页自动观察，旧页由翻页或刷新主动读取。CPU、运行时间等动态状态不使用整包 ETag。GUI 的空闲退避只调度自动读取，不改变 Agent 的显式读取、持久提交或服务执行。

HTTP 客户端先显式 POST `/api/identity` 并保存 cookie，再向 `/api/annotations/spaces/SPACE` 提交 `AnnotationOperation`。必须提供与服务匹配的 `Origin`、对应的 `X-VoidPlayer-Action` 和 JSON Content-Type。用户名与 `client` 是可信内网下的归属声明，不是身份认证；既有同源保护保持不变。

持久目标由 space、标注 ID、`document.media` 中的源 ID/版本和 `mark.frame` 确定。现有文档仍带有 A–H 槽位与 decoder 来源字段；它们是兼容的显示/来源描述，不是要求 Agent 加载轨道或拥有浏览器。媒体描述必须来自已知工作区或实际探测，不能编造；接受标注不意味着服务器验证了帧内容。自解释缓存媒体信息/索引的首批只读接口见 [媒体查询](media-query.md)。

浏览器标注构造和编辑已移到 `shared/review/marks.ts`。`shared/review/annotation-command.ts` 定义与宿主无关的命令验证和持久状态转换；SQLite 适配器负责事务和序列。页面 GUI 与 WebMCP 继续共用 `ReviewSession` 视图行为。HTTP 业务命令不依赖 GUI 是否在线、播放状态、当前帧或选中轨道。

同一请求重试必须保留 operationId、完整原始 payload 和 actor；回执返回第一次提交的结果。对象的 revision 是乐观并发条件。版本冲突先读最新状态再协调，新增意图使用新的 operationId。现有主媒体版本/帧锚点不可移动，删除只能显式 restore 恢复。

## 操作记录与状态恢复

`GET /api/annotations/events/SPACE` 读取最近 50 条保留事件；加 `?after=CURSOR` 每页最多 100 条，按 sequence 升序续读。事件记录操作、请求 ID、actor、声明的 client、对象/修订、源/帧目标和提交状态。对象、回执和事件在同一个 SQLite 事务提交，响应不等待 GUI 消费。

事件是确认的操作历史；`GET /api/annotations/spaces/SPACE?after=...` 是合并过的最新对象状态，二者不能混用。sequence 全库递增，某一空间出现空档是正常的。消费者按 sequence 去重，处理整页后保存 cursor，并继续读取 more=true 的页。

全库保留最近 10000 条事件，幂等回执沿用原有持久策略。游标落后于保留窗口或超前于恢复后的数据库时，响应返回 `resetRequired`、原因、快照入口和当前 cursor。客户端保留本机待提交草稿，完整分页读取并替换已确认状态，再从捕获的 cursor 继续观察。GUI 的活动轮询每轮最多读五页，失败不会阻塞标注同步；活动区不会自动打开、改变播放、替换轨道或移动焦点。

标注数据库升级至 user_version=2。v1 对象与幂等回执保留；升级前没有操作历史，因此较旧事件游标会要求重同步。旧版本程序会拒绝打开升级后的数据库，不支持原地降级。

Node 回归覆盖无前端 HTTP 写入、Origin/身份检查、重复提交、版本冲突、重启和事件游标。已移除的技术发现、任务中心和评分接口均返回 404。
