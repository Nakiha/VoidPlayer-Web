# 接入只读私有媒体库

在独立服务中实现 [OpenAPI v1](openapi.json) 的三个 GET 操作。VoidPlayer 完整版负责浏览、SQLite 搜索、公开的媒体 ID、索引、播放与标注。适配器负责把一个授权的存储范围映射成一个媒体根。云端 SDK、凭据和续签逻辑放在适配器进程。浏览器只连接 VoidPlayer。

## 先跑通参考服务

使用 Node.js 24+。在本目录执行，从空目录生成验收数据，然后启动参考服务。无需 npm 依赖。

```sh
mkdir demo-media
node check.mjs prepare demo-media
node server.mjs demo-media 5191
```

在另一个终端从同一目录运行以下命令。验收程序会检查目录分页、特殊文件名、stat 与列表的一致性、文件首部/中段/末尾字节和越界请求，并打印当前 revision。

```sh
node check.mjs verify http://127.0.0.1:5191
node check.mjs replace demo-media
node check.mjs verify-replaced http://127.0.0.1:5191 上一步输出的旧revision
```

替换夹具保持大小不变。对云端服务验收时，先上传 prepare 生成的完整子目录，执行 verify，再把 replace 生成的新文件覆盖上传到同一个键，最后执行 verify-replaced。验收程序对远端只发 GET。夹具的 .mp4 后缀用于目录检索，它只含确定性测试字节；播放验收请另放一个真实视频。

## 接入播放器

把以下根加入服务配置的 mediaRoots，重启完整版服务。endpoint 可带固定路径前缀。tokenEnv 可省略；配置后，VoidPlayer 从指定环境变量读取 Bearer token 发给适配器。参考服务和验收工具从 PROVIDER_TOKEN 读取同一票据。跨主机连接使用 HTTPS。适配器只向 VoidPlayer 开放授权范围，VoidPlayer 按当前部署的媒体库读取权限向播放器提供内容。

```json
{"mediaRoots":[{"id":"private","name":"私有素材","provider":{"endpoint":"http://127.0.0.1:5191"}}]}
```

将真实的 H.264 MP4 放入该根，打开播放器的片源栏，进入「私有素材」，载入视频并跳到中间帧。也可以在地址栏输入 `library:private/片名.mp4`。后台支持单库刷新，浏览器 Network 面板可观察到固定版本的 content、container 和 frame-index 请求。管理页可改显示名和移除根；适配器的服务地址与凭据配置在服务端文件中修改。

## 实现存储映射

1. **列目录。** `GET /v1/list?directory=&limit=128` 列出根目录直接子项。文件返回 name、objectId、revision、size、lastModified，目录只需 kind 和 name。返回 nextCursor，最终页显式返回 null。下一页保持同一目录视图，条目名唯一。遍历期间发现无法继续的一致性变化时返回 409。对象存储可用前缀模拟目录。上游授权失败、限流或离线时返回错误；只有目录确实为空才返回成功的空列表。
2. **取当前版本。** `GET /v1/stat?objectId=…` 返回当前文件描述。objectId 与显示路径分别传输；按普通 query 参数编码。将上游版本标识映射为可放进强 ETag 的 revision。size 使用字节数，lastModified 使用 Unix 毫秒，未知可用 0。文件大小和秒级时间戳不足以区分同大小覆盖。VoidPlayer 按根和显示路径登记资产，把来源、对象键、版本及大小映射为自己的固定版本；外部改名按新路径发现。
3. **读取固定版本。** `GET /v1/content?objectId=…` 同时收到 `Range: bytes=10-19` 和 `If-Match: "v1"`。两个端点都包含在区间内。成功返回 206、原样强 ETag、`Content-Range: bytes 10-19/文件总长` 和恰好 10 字节。使用存储提供的条件读取或固定版本句柄消除 stat 与读取之间的竞争。版本失配返回 412，越界返回 416。响应未完整时中止传输，客户端断开时取消上游读取并释放句柄。每次请求至多 1 MiB，传输原始字节。列表与 stat 的 JSON 每次不超过 1 MiB，单次上游请求超时 15 秒。

参考实现按路径组件限制访问、跳过隐藏项与符号链接，并在文件读取前后核对版本。替换为云服务时建议先改目录映射，然后改 stat 和条件 Range，最后用独立的黑盒工具验证。诊断取消可在适配器中延迟一次 Range，请求期间关闭客户端，并从适配器观察上游读取退出。协议错误返回状态即可，云凭据、可签名下载链接和内部错误详情留在服务端。

## v1 功能范围

适配器可使用已有的 MP4、FLV、MPEG-TS 和 Matroska/WebM 播放索引路径，实际可播放的编码和流布局遵守播放器原有准入条件。适配器 v1 提供只读访问。云端文件管理、绝对路径、本机定位、服务端封面生成、同步 FFmpeg 索引器和深度码流分析需要本地文件能力。本地磁盘根继续使用原有实现。Sites 静态版使用浏览器本地文件。
