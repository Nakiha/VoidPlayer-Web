# HTTP API

当前 HTTP 接口按媒体库、媒体资产、工作区、标注与运维划分。API 不要求播放器页面在线。完整服务提供这些能力；Sites 仅为静态分发，不调用媒体 API。

## 媒体身份与版本

- `id` 是数据库分配的 24 位随机资产 ID，与库 ID、文件名和路径无关。媒体描述明确返回 `rootId`、`root`、`path`、`version`。
- `GET /api/media/ID` 查询当前位置与当前内容版本，用于发现、恢复和诊断；没有视频字节。加 `v=VERSION` 校验固定内容版本，同时读取有界缓存技术信息与索引身份清单，`offset` 续页。
- 原视频只从 `GET/HEAD /api/media/ID/content?v=VERSION` 读取。所有视频字节、容器识别、位置、缩略图、播放索引、索引查询与分析子资源都要求一个有效的 `v`。缺失、重复或非法版本拒绝；内容替换不自动升级调用者持有的版本。
- 应用内已完成核验的移动/改名保留资产 ID 和内容版本。物理文件 fingerprint 独立保存并用于 stat/打开后的核验。冷索引 Worker 使用当前 fingerprint 核验文件，索引仍绑定资产 ID/内容版本。原路径被新文件占用时分配新资产 ID。
- 外部内容修改使旧版本失效。没有应用执行见证的外部移动、改名、复制不按文件名或大小自动关联旧资产。命令失败或响应丢失时先观察实际结果，不自动重放文件操作。

## 读取与命令

索引读取不能启动扫描。客户端先 POST 构建命令，再 GET 索引；重连只 GET 已存在的构建。构建按完整媒体/索引身份去重，由服务拥有；断开订阅不取消构建。完成或失败的近期构建观察记录最多保留 32 项；新 POST 可以显式重试失败的构建。

```http
POST /api/media/ID/frame-index/build?v=VERSION&kind=flv
Origin: http://SERVICE
X-VoidPlayer-Action: frame-index
Content-Type: application/json

{}
```

新建或加入运行中的构建返回 202，含 buildId 和结果位置；已有完整缓存返回 200。随后 GET `/api/media/ID/frame-index?v=VERSION&kind=flv`，可用 `Accept: application/x-ndjson` 订阅读取。GET 的 `build=1` 被拒绝。

浏览媒体库仍可登记当前目录的观察需求，既有增量目录观察负责刷新文件清单；它不会探测或解码媒体。全库扫描及显式单库重扫只有 POST 命令能启动。

## 接口清单

### 媒体库

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/library/browse` | `root/directory/search/recursive/limit/offset/revision` 范围内的文件、目录、库状态和分页；支持私有 ETag |
| GET | `/api/library/scan` | 扫描状态及错误，`offset` 对错误分页 |
| POST | `/api/library/scan` | JSON `{action:"refresh",rootId?}` 或 `{action:"cancel"}`；Action 为 `scan` |
| GET | `/api/library/roots/ROOT/location` | 指定挂载根目录的绝对路径 |
| POST | `/api/library/files` | JSON move/rename/delete 文件命令；Action 为 `library-files`，详见[文件管理](library-file-management.md) |

### 媒体资产

以下路径以 `/api/media/ID` 为前缀；子资源均固定 `v`。

| 方法 | 后缀 | 作用 |
| --- | --- | --- |
| GET/HEAD | 空 | 当前描述；固定 v 时附有界缓存技术信息，不隐式探测 |
| GET/HEAD | `/content` | 原文件字节，支持单段 Range；`download=1` 作为附件 |
| GET | `/container` | 至多读取 1024 字节文件头，识别播放容器 |
| GET | `/location` | 当前文件绝对路径及本机定位能力 |
| POST | `/reveal` | 启用时仅本机页面可定位文件；Action 为 `reveal` |
| GET | `/frame-index` | 已有播放索引或运行中的构建；JSON/NDJSON，`kind/stream/schema/indexer` 选择索引身份 |
| POST | `/frame-index/build` | 显式启动/加入构建；Action 为 `frame-index`，空 JSON 对象 |
| POST | `/frame-index` | 上传允许客户端提交的索引；Action 为 `frame-index` |
| GET/HEAD | `/index-query` | 已有缓存的概览或包记录查询；不扫描、不建索引，详见[媒体查询](media-query.md) |
| GET | `/thumbnail-status` | 指定版本及 recipe 的缩略图存在状态 |
| GET/HEAD/POST | `/thumbnail` | 读取或上传 JPEG；上传 Action 为 `thumbnail`，带 epoch/尺寸/PTS |
| GET | `/bitstream-analysis/capabilities` | 深度码流分析能力和限制 |
| POST | `/bitstream-analysis/requests` | 创建分析请求；Action 为 `bitstream-analysis` |
| GET | `/bitstream-analysis/chunks/HASH` | 读取分析结果块 |

`GET/HEAD /api/media/query-schema` 描述缓存查询字段。`GET/DELETE /api/bitstream-analysis/requests/REQUEST` 观察分析请求或释放请求租约；DELETE 使用 `bitstream-analysis` Action。

### 用户、工作区与标注

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/users` | 命名用户列表 |
| POST | `/api/identity` | 显式创建、选择、改名用户或选择访客；Action 为 `identity` |
| GET/POST | `/api/workspaces` | 分页查询或创建工作区 |
| GET/PUT/DELETE | `/api/workspaces/WORKSPACE` | 读取、更新、删除；修改使用 If-Match |
| POST | `/api/workspaces/share` | 创建/更新可协作工作区，正文 `{id?,name,document}` |
| GET/POST | `/api/annotations/spaces` | 列出/创建标注空间 |
| GET/POST | `/api/annotations/spaces/SPACE` | 查询状态/提交持久标注命令 |
| GET | `/api/annotations/spaces/SPACE/ANNOTATION` | 读取单条标注 |
| GET/PUT | `/api/annotations/spaces/SPACE/ANNOTATION/preview` | 读取/上传标注预览 |
| DELETE | `/api/annotations/spaces/SPACE/previews` | 清理空间预览 |
| GET | `/api/annotations/events/SPACE` | 分页操作事件，过期游标要求快照重同步 |

工作区写入 Action 为 `workspace`，标注写入为 `annotation`。这两类写入要求显式选择身份；`X-VoidPlayer-Actor` 可绑定调用者观察的 actor，防止切换身份后误提交。持久命令的幂等和事件事务规则见[Agent HTTP](agent-http.md)。

### 运维、连接与发现

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/admin/status` | 服务运行概览；`view=overview` 不含旧请求快照字段 |
| GET | `/api/admin/requests` | 分页持久请求历史，含结构化资源上下文 |
| GET/PUT | `/api/admin/roots` | 媒体库挂载配置及修订校验 |
| GET/PUT | `/api/admin/analysis` | 分析资源设置 |
| GET | `/api/admin/caches` | 缓存总览 |
| GET/DELETE | `/api/admin/caches/TYPE` | 查询/清理缓存；删除 JSON 为 `{all:true}` 或 `{id,version,scope?}` |
| GET/POST | `/api/admin/measurements` | 查询/创建测量 |
| POST | `/api/admin/measurements/REQUEST/transfer`、`/finish` | 传输测量数据、提交完成结果 |
| DELETE | `/api/admin/measurements/REQUEST` | 取消测量 |
| GET | `/api/admin/logs` | 分页日志列表 |
| GET/DELETE | `/api/admin/logs/NAME` | 读取/按版本删除日志 |
| POST | `/api/logs` | 用户主动提交浏览器诊断；Action 为 `log` |
| GET | `/api/health`、`/api/ready` | 服务信息与就绪状态 |
| GET | `/api/connection`、`/api/connection/probe` | 连接信息、HTTPS 探测 |
| GET/HEAD | `/api/connection/certificate` | 本地根证书 |
| GET/HEAD | `/api/agent`、`/api/agent/tasks[/TASK]`、`/api/agent/operations/OPERATION` | 能力及操作说明，tasks 为调用流程目录 |
| GET/HEAD | `/llms.txt`、`/agent.md`、`/agent/*.md` | Agent 使用说明 |

管理写入 Action 为 `admin`。本机 `/api/page-bridge/*` 与 `/api/page-bridge/existing/*` 是单独的页面授权通道，不以 actor 或 Origin 代替凭据，详见[页面桥](local-mcp-page-bridge.md)。

## 访问模型与删除的入口

服务当前面向可信内网。用户是归属声明，不是认证主体；Origin/Action 保护同源写入，不提供按用户或按库授权。媒体读取依赖部署可达性与服务配置的根目录边界，资产 ID 不是凭据。需要用户隔离的部署必须另外设计认证与授权，不把 rootId 是否出现在 URL 当权限检查。

不提供旧 `/api/library` 列表、GET refresh 开关、`/metadata`、`/info`、`/playback-container`、`/api/admin/scan`、`/api/admin/frame-indexes`、`/api/shares` 或 `/api/reviews` 入口。旧路径没有重定向或别名；工作区与播放器调用一并使用当前协议。数据库升级保留已有媒体行和工作区，不以接口改版为由清空本地数据。
