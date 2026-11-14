# URI 观看状态与 ABI 分享

观看现场由 URI 表达，不再保存服务器工作区文档，也不写本机工作区检查点。片源标注独立持久化，链接不包含标注正文、回复、预览或视频字节。旧工作区接口、文件导入、workspace/share/review 链接不提供兼容恢复；已有数据文件不自动删除。

## 明文 URI（ABI 1）

`/?abi=1&A=ASSET@VERSION&B=ASSET@VERSION&t=12.5&offset.B=0.04&view=split&split=0.37&channel=y`

- A–H 参数的顺序是初始轨道顺序。片源固定 24 位十六进制资产 ID 与 24 位内容版本；外部库写作 `https://origin/ASSET@VERSION`，本服务使用相对身份。
- `t`、`offset.A` 到 `offset.H` 使用秒，恢复为整数微秒。`visible.A=0/1` 控制显示。
- `view=side-by-side/split`、`arrange=horizontal/grid`、`split`、`zoom`、`x`、`y`、`pixel=uniform/fill`、`channel=rgb/y/u/v` 控制视口。
- 可选 `basis=WIDTH,HEIGHT` / 状态 `panBasis` 记录发送端主画面的适配尺寸（CSS 像素）。`x/y` 仍是 CSS 像素；恢复先建立发送端基准，再按接收端实际画面尺寸缩放偏移，窗口大小和面板布局不同时保持同一画面中心。省略时保留旧链接的像素含义，不沿用接收端上一个场景的适配尺寸。
- `comparison` 与 `layout` 是 JSON 参数，包含色彩/解码要求、工具区与分析面板、媒体库导航和搜索。请求条件不保证接收设备的实际 HDR/硬件解码能力。
- `mark=ID` 可定位指定片源标注。管理页生成单片链接。
- 本地引用为 `file:[ID,NAME,SIZE,MTIME]`。它不包含路径或文件字节，只能复用当前页面源或已授权的本地句柄；无法读取时明确失败，不能冒充可远端访问的片源。普通文件输入不会凭 URI 获得持久读取权限。

规则与校验在 `shared/review/uri-state.ts`。ABI 1 固定其默认值、参数含义、元组顺序和枚举；改变这些语义必须增加 ABI。GUI 和页面 Agent 共用 `get_uri_state`、`apply_uri_state`、`share_state`。

页面停止忙碌后约每 500ms 将稳定状态合并进地址。片源集合、顺序或偏移变化产生历史条目，连续的播放位置、平移和缩放使用 replaceState。显式 apply 使用 pushState。popstate 走同一恢复路径；较晚的导航、身份切换和关闭会取消旧请求，旧解码结果不能改写新地址。片源版本核验与打开在浏览器完成；服务器不代 URI 抓取任意媒体。

直接访问且尚未载入片源的首页保持原地址，不把默认布局和比较条件展开为查询参数。JSON 参数中的引号、花括号与中文由 URLSearchParams 正常转义；百分号表示 URL 编码，不是状态损坏。

## 自包含分享

`POST /api/uri/encode` 接受 `{state: UriState}`，需要 JSON、匹配的 Origin 与 `X-VoidPlayer-Action: uri`，不需要创建身份或保存文档。返回 `{abi:1,token,url}`。`GET /api/uri/decode?s=TOKEN` 返回 `{abi:1,state}`。

链接形式为 `/?s=VERSION.CODEC.BASE64URL`：封装版本 1 是紧凑 JSON 文本，版本 2 是二进制；状态及 API 的 `abi:1` 仍指同一份观看状态语义。CODEC 为 n（未压缩）、d（raw Deflate）或 b（Brotli）。旧链接继续可读。后端：

1. 校验并规范化 ABI 1 状态，拒绝本地文件分享。
2. 二进制封装直接写入 12 字节资产 ID / 版本，槽位、枚举与开关使用位域，整数使用变长整数，非整数保留 IEEE 754 float64。布局与分析状态按固定字段顺序写入，空查询、重复搜索文本和默认视口值省略；比较条件只保存相对于 ABI 1 固定默认值的差异。字符串使用固定字典与本链接内的重复引用，用户文本不改写。
3. 分别比较未压缩、Deflate level 9、Brotli quality 11 的最终 token 长度，选择最短者。不含 `panBasis` 时同时保留旧文本编码候选，避免个别状态变长；含此扩展时只使用能完整表达它的二进制封装。

二进制合同在 `shared/review/uri-binary.ts`。首字节按位标记 position / viewport / comparison / layout / mark / panBasis，第二字节是轨道数；每轨一个字节依次容纳 3 位槽位、隐藏、偏移存在、外部 Origin 存在，后跟资产与版本的各 12 字节，以及可选偏移和 Origin。顶层字段按上述标志顺序写入；视口、布局和分析各有独立的存在/枚举位域，字段顺序冻结。无符号长度与整数采用规范 unsigned LEB128；轨道有符号偏移的首字节以最低位存符号、中间 6 位存绝对值、最高位标记剩余 unsigned LEB128。float64 为小端。

通用值类型标记为 null=0、false=1、true=2、非负整数=3、负整数绝对值=4、float64=5、UTF-8=6、数组=7、对象=8、固定字典=9、字符串引用=10、保留孤立代理项的 UTF-16LE=11；0–31 整数以 32–63 单字节表示。字典、字段位和顺序只能通过新封装版本变更。拒绝截断、尾随字节、越界字典/引用、重复对象键、未知位/类型、无效 UTF-8、整数溢出和超过 16 层的嵌套。

不存在短链 ID 到文档的数据库映射。链接随状态复杂度增长；复制不更新他人的链接。压缩不是加密。编码/解码均限制解压后的内容为 64 KiB，token 上限为 16,384 个字符，拒绝未知 ABI/codec、不规范 Base64URL、无效元组和解压超限。

显式参数覆盖压缩内容：`/?s=1.b.PAYLOAD&t=30&channel=y`。A–H 覆盖对应槽位，`A=-` 移除槽位，其他槽位保留。接收后地址展开为可编辑参数。剪贴板不可用时，在设置中显示可手动复制的链接。

当前轨道含本地文件时，两处分享按钮禁用并通过 tooltip 解释原因；片源列表中的未上屏本地文件不影响分享。编码期间按钮保持外观、焦点和文字，以 `aria-busy` 报告忙碌，重复操作复用同一次编码与复制。

## 片源版本标注

目标键为 `media-` 加以下 UTF-8 JSON 的 SHA-256 十六进制摘要：

`[namespace, assetId, contentVersion]`

本服务片源的 namespace 是空字符串，因此本服务的域名别名不改变归属；外部库保留其 HTTP(S) Origin。`shared/review/annotation-target.ts` 是浏览器和 HTTP 客户端的计算契约。槽位、临时 mediaId、排列、偏移和会话位置均不参与目标键。文件名、路径和仅凭元数据相似不能合并媒体库标注。

- `GET /api/annotations/media`：已有片源版本目标。
- `GET /api/annotations/media/TARGET?after=CURSOR`：分页最新对象状态，含删除墓碑。
- `GET /api/annotations/media/TARGET?list=1&search=…&deleted=0/1&before=…`：管理列表与回收站。
- `GET /api/annotations/media/TARGET/ID`：单条标注。
- `POST /api/annotations/media/TARGET`：put/delete/restore 操作包。put 的媒体版本必须与 TARGET 一致。
- `GET /api/annotations/events/TARGET?after=CURSOR`：有界操作事件，与合并后的对象状态分别消费。
- `GET/PUT /api/annotations/media/TARGET/ID/preview?revision=…`：独立 JPEG 缓存。上传还核对 preview epoch。

存储的内部 scope 字段仍名为 space，它仅表示上述片源版本键；没有任意评审空间创建接口，也没有工作区外键。标注正文、幂等回执和操作事件保持同事务。已有源版本/帧锚点不可移动；删除只能显式恢复。帧使用源时间，不受当前轨道偏移影响，回复与解决状态不依赖已加载轨道。

浏览器为每个目标单独持有游标，自动发现已打开片源，不需要先分享。草稿按目标/用户/窗口保存在 IndexedDB；刷新沿用本窗口的操作编号，未知回执重试不换键。初次连接或游标重置完整分页读取后，原子替换已确认状态，保留待提交草稿。前台从 3 秒退避到最多 15 秒，编辑、焦点和恢复在线时唤醒；活动读取失败不阻塞对象同步。同步不打开媒体、不 seek、不抢焦点，绘制期间不覆盖正在编辑的内容。

冲突保留草稿，设置中可采用服务器版本，或将本机内容保存为新标注。预览独立上传，每轮最多 4 条，不影响正文成功。没有持久访问能力的本地文件标注仍只属于本机当前源身份，不会上传或依文件名跨会话归并。

## 验证映射

旧工作区 CRUD、检查点、文件恢复与分享空间场景退出；`test/uri-state-migration.json` 明确映射到 ABI 编解码、迟到导航、片源版本同步和真实浏览器场景，测试清单检查对应 engine 与 CI 门禁仍有覆盖。沿用标注存储、操作事件、身份、pending queue 的事务和生命周期回归。

主要验证：`npm run test:fast`、`npm run build`、`npm run test:uri:browser -- webkit` / `chromium`、Sites 双引擎、标注绘制及实际 WebKit 播放基准。浏览器 URI 场景复用两个既有样片，不再执行工作区存储/导入循环。
