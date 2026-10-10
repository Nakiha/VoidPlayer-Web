# 按需码流分析 MVP

深分析默认关闭。轨道工具条的「分析当前帧」在暂停画面上启动分析，支持块边界、QP 热图、基础 intra/inter/skip 着色和鼠标命中查询。关闭按钮释放遮罩和当前请求。换帧先清除旧遮罩；连续播放、逐帧和 seek 仅复用精确命中的缓存。未缓存画面不会隐式启动第二次解码。

UI 和 Agent 使用 `ReviewSession` 的相同入口：`getPresentedFrame`、`requestBitstreamAnalysis`、`requestBitstreamRange`、状态、缓存查询及取消。Agent 工具对应 `get_presented_frame`、`request_bitstream_analysis`、`request_bitstream_range`、`get_bitstream_analysis_state`、`cancel_bitstream_analysis`。基础半开区间最长一秒、最多 32 个 picture；批量区间管理 UI 属于后续扩展。

## 支持矩阵与身份

可执行矩阵是 `scripts/bitstream-analysis-matrix.json`；浏览器回归逐行执行本地 File / 媒体库和现有 browser / reference software 播放路径。H.264、HEVC、VVC 的真实 MP4 均有成功正向样本。WebCodecs 可用性由平台决定，实际使用的 decoder 写入测试报告；VVC 走 packet WASM。FLV、TS、MKV、fragmented MP4 和无 packet 身份的容器解码不在首批范围。

持久 key 是 source version、video stream、description 配置段、稳定 sample/AU ordinal、picture 0、layer 0、frame。本地 File 使用会话中的随机来源 ID，不按文件名、长度或 mtime 拼身份；媒体库使用 `id@version`。配置、AU 索引、源时间戳缺失或重复以及不唯一的 packet/picture 映射必须拒绝。

播放送包时只检查已经读入的 NAL 首部，不新增 I/O；H.264/HEVC 检查首 slice，VVC 首版限定单 slice；AVC 扩展层和 HEVC/VVC 非零 layer 被拒绝。输出以**唯一且完全相等**的源 PTS 关联 AU，不做最近 PTS 或容差匹配。HEVC 特殊时间映射复用现有经过验证的 POC 修复实现。分析核心用 FFmpeg COPY_OPAQUE 把源 AU 传到输出；VVC 的旧 range-local decode_order 已被替换。

Presenter 在成功提交绘制后发布 token：真实 picture key、原始微秒时间戳、减去 first PTS 后的媒体时间、slot generation、commit 和几何快照。它是应用绘制提交，不是物理屏幕扫描时刻。轨道 offset 只在 session 边界换算；不进入缓存 key。coded 坐标经 visible crop、SAR 对应的共享显示矩形、旋转和当前视口变换投影。缩放和分屏只重投影；几何变化不重分析。分析层位于视频和标注之间。

Field picture、palette 的使用、损坏/concealment、不完整覆盖和非 4px 网格不能显示精确遮罩。Field/concealment 在解码输出时校验；palette 在 VVC 实际 CU hook 中拒绝。VVC 复杂运动/参考语义、MV、chroma QP、高位深 luma QP 和可交互 NAL 浏览器不在 MVP 输出范围。高位深输出可以声明 blocks/modes，但 QP 为 null/unsupported。8-bit luma QP 范围 AVC/HEVC 为 0..51，VVC 为 0..63；均值按 coded 像素面积加权，包含编码边缘的 padding。

## 独立执行与逐 picture 生命周期

分析核心构建在 `VoidPlayer-FFmpeg-Build`，Web 只消费固定产物。`scripts/release-analysis.json` 固定构建修订、instrumented FFmpeg、Emscripten、ABI 和语义版本；`scripts/sync-analysis-core.sh` 验证并复制 js/wasm/manifest/LICENSE，同时生成 SHA-256 provenance。分析核心单线程，无文件系统、avformat 或网络；和播放 core 完全分离。不依赖 cross-origin isolation。

旧批量 writer 已被独立 streaming collector 替换；不调用旧 finalize_frame_summaries / finish_vachunk，不全局重排、重算或在文件结尾重赋 coded_order。每个 picture 的 records 在 codec hook 中 collecting，只有成功 avcodec_receive_frame 才 sealed，排序一次后 take；take 释放分析 records，不释放 decoder 的参考帧。已交付源 AU、坐标、QP 和顺序不会回写。没有继承旧 COMPLETE/EXACT 位。

定位器只读取有界 MP4 元数据和必要 NAL 首部。闭合 IDR 的语法检查与容器 key 标记同时成立才能起步；CRA、recovery 和未知 open-GOP 不按安全起点处理。每个区间保留一个 decoder，逐 picture 取结果并等待 consumer ACK 后才继续。找不到预算内的安全起点、跨配置区间或块覆盖不完整会明确失败/降级，播放不受影响。

本地 File 由独立 browser worker / RangeReader 分块读，文件不上传。媒体库由独立服务端 worker 本地读盘；浏览器只取 JSON chunks，不加载分析 WASM，也不会在服务端失败时隐式下载远程文件分析。二者使用相同输入适配、核心和协议。Worker 终止是同步 WASM 取消的硬兜底；正常循环在每次 feed/step/take 前检查取消。

## 服务、缓存与资源预算

路由是 `/api/media/:id/bitstream-analysis/{capabilities,requests,chunks/:id}` 和 `/api/bitstream-analysis/requests/:requestId`。写请求需要同源 Origin、专用 action header 和确切媒体版本；API 不接受文件路径。capabilities 是实现的 admission 范围，每个 picture 仍需独立验证。

服务端独立单 worker 队列，排队的当前 picture 优先于区间、同类 FIFO；每个 work 可以有多个 owner 隔离的 consumer lease，取消一个不终止另一个。GET 状态续租，30 秒失联回收；最后一个 consumer 退出时终止 worker。HTTP、播放和帧索引队列不等待分析。每个可信 picture checksum 校验后原子 rename 单独提交；区间 manifest 仅在完整完成后提交。异常/取消保留之前已完成的 chunks。重启、坏 checksum、截断、丢失 chunk、版本或 build 变化不能形成错误的完成覆盖。

| 资源 | 上限 |
| --- | --- |
| 分析并发 | server 1；browser service 1 |
| consumers / 提交队列 | 各 32 |
| 任务 / consumer 租约 | 30 秒 |
| 区间 | 1 秒，32 picture |
| 预滚与目标送包 | 300 packet；32 MiB payload；单包 8 MiB |
| 元数据索引 / 逻辑读取 | 250000 sample；64 MiB（含重复逻辑 read） |
| coded 尺寸 | 4096×2304；4px 网格完整且无重叠 |
| 核心 collecting + sealed | 32 picture；每 picture 131072 blocks；records 总 32 MiB |
| WASM heap | 初始 64 MiB，最大 512 MiB；stack 4 MiB |
| 单 picture 结果 / 出站 chunk | 8 MiB，按每条 128B + header 的保守 JSON 上界在 JS records 分配前检查；每 consumer 一块 ACK 背压 |
| HTTP 结果传输 | 同时 2 个，忙时返回 429 |
| 本地结果缓存 | JSON 计量 32 MiB LRU，会话结束回收，无持久化 |
| 服务端缓存 | 128 MiB LRU，最多 1024 文件；含 manifest |
| 遮罩 | 最大 8192 边长、32M 像素；缩小跳过 <2 CSS px 的边界线 |

结果 JSON、JS 对象、WASM heap、viewport canvas 属于不同的内存开销；JSON 计量缓存配额不宣称是浏览器总 RSS 限额。预算超限只结束分析，不能改变播放 decoder、轨道 failure、时长或索引。逻辑 bytesRead 不是 RangeReader 物理网络字节；服务端无 Range 下载，测试另外记录 Range 响应时间。

## 失败分类与首批交付边界

本地 worker、服务端队列、HTTP 与会话共用结构化 `reason: {code, kind, message}`。稳定码包括 `unsupported-container`、`unsupported-codec`、`unsupported-picture-layout`、`no-safe-anchor-within-budget`、`unsupported-qp-depth`、`incomplete-reference-state`、`ambiguous-picture-identity`、`resource-limit`、`source-changed`、`invalid-request`、`cancelled`、`internal-error`。分类不匹配人类可读异常文本；未知异常仍是实现错误。`resource-limit` 是 limited，合法但未支持的组合是 unsupported，源变更和内部错误是 error。界面显示对应反馈，Agent 可以直接读取原因码。

服务端不再把所有 partial 输出归为内部错误；经过身份校验、无块且最多 16 KiB 的 unsupported 摘要只保留在 consumer 租约内，不写 exact chunk 或完整 manifest。10-bit HEVC 实测 blocks/modes 保持 exact、QP 为 null/unsupported；QP 选项禁用。损坏和 unsupported 输入不放宽身份、预滚预算或完整覆盖校验。

第一阶段交付仍是普通 MP4 MVP；#56 保持开放。后续依次追踪 FLV、高位深 QP、复杂随机访问（包括非闭合 IDR 起点）、更多 slice/工具的独立验证，以及按 picture/能力补缺口和只读定位描述复用。现有本地缓存和服务端 manifest 复用不等于完整跨区间稀疏覆盖；已缓存的目标也不代表可以跳过后续缺失结果所需的参考解码。

## 验证与证据

`node --test test/bitstream-analysis*.test.ts` 覆盖三种真实核心、选定已知记录、随机/顺序逐块一致、后段闭合 IDR、H.264/HEVC/VVC 各 600 帧持续 drain、B 帧重排、各三个后段闭合 GOP 的随机/顺序逐块对照、记录/heap 稳态、暂停 consumer、单帧超预算、双 consumer、lease、原子缓存损坏/配额和重启。H.264/HEVC 额外使用固定编码器 CU/MB 大小与 QP 17 的全黑输入，独立检查完整网格、QP 和 intra；不只检查非空。

`docs/fixtures/bitstream-analysis-answers.json` 固定原样片 SHA-256 和旧原生 analyzer 的选定 CU/MB 记录，用于三种 codec 的迁移对照。该原生参考运行使用旧 writer，和新流式 writer 独立，但两者共享 instrumented codec hook。它不是独立证明所有 VVC 复杂工具语义的 oracle；MVP 不声明那些工具。VVC 更全面的独立语法/参考实现核对仍应持续补充。

`node scripts/check-bitstream-analysis-browser.mjs chromium|webkit` 执行矩阵，检查 disabled 不加载 worker/core/canvas、local 无上传、library 不下载分析 decoder、真实 token/key、QP/mode、DPR 2、缓存、区间、offset、换帧和迟到响应。`node scripts/check-analysis-release.mjs` 从解压原生包、无 Node/Bun/ffmpeg 的 PATH、无关 cwd 实际执行三种分析并验证重启缓存。三平台 release workflow 均运行该验收，产物汇总另外验证相同 analysis provenance 与字节。

`ANALYSIS_BASELINE_DIR=/path/to/built/main/dist node scripts/bench-bitstream-analysis.mjs webkit` 保留原播放 bench 的场景和阈值，并记录关闭、暂停分析、缓存播放、后台区间分析的本地/媒体库、hardware/software、单/双轨对照。持续缓存场景先覆盖所有显示轨道的 120 ms 窗口，再在窗口内进行 30 次短段播放（累计至少 1.5 秒实际播放），使用 QP 热图；要求真实命中比例至少 98%、实际绘制至少 30 次、恒定几何不重设 canvas。窗口回放的 seek/start 总成本单列，不能把它写成连续 1.5 秒唯一画面的遮罩验收。原有连续播放 bench 和阈值另行保留；CI 矩阵也含本地/媒体库的持续命中回归。

后台分析使用未完成需求期间的连续 1024-byte Range 探测，记录数量和 p50/p95/p99/max、实际请求时段和分析耗时，分析结束后不再启动探测。输出记录首选配置和实际 decoder、播放吞吐/失败、每帧遮罩绘制耗时、缓存命中率、主线程 timer lag 分位数/long tasks、服务端 CPU/RSS、并发 Range 延迟和分析 heap/records/输入量。CPU/RSS 为观测值，不是任意负载下零竞争承诺。

### 2026-10-10 初始本机测量（阶段 A 之前）

固定 main `d87fda7`、同一播放 core `1e68e6c`，Apple M5 / 10 CPU / 32 GiB / macOS / Node 24.15.0；原有四场景 WebKit bench 在 main 与功能分支均通过。WebKit 32 个争用场景中，8 个暂停分析及 24 个播放场景完成，24 个播放判定全部通过；暂停请求总耗时 131–333 ms，Range 约 4–7 ms，主线程 timer lag 最大约 26 ms。不同场景存在冷启动/缓存命中差异，这些耗时不作为恒定 SLA。

Chromium 功能矩阵通过，但本机 headless + reference 色彩路径低于实时：关闭分析时 main 与功能分支速度均约 0.31–0.39，所有这些 reference 性能判定仍按原阈值记为失败。它们没有被改成验收成功；不能从这些结果推断可见窗口或真实 GPU 硬解的性能。硬件只是首选配置，报告同时保留实际 decoder。

测量汇总：`docs/fixtures/bitstream-analysis-validation.json`，包含两种浏览器 64 个场景、Chromium 的 8 个 main 同条件对照、CPU/RSS/主线程/Range 指标及原始播放 measurements。解压原生包的真实分析已在 macOS ARM64 本机通过；Linux/Windows 与 CI 构建/完整发布验收由 PR workflow 执行，运行状态以远端报告为准。

### 阶段 A 收口

三种 codec 的持续生命周期证据保存在 `.run/analysis-lifecycle/`，CI 上传该目录。每种样片均输出并释放 600 个 picture，源 AU 与原始 PTS 一一匹配，显示顺序严格递增；AU 104/232/584 的随机结果与连续解码逐块相同。AVC/HEVC/VVC 的峰值记录内存分别为 294912/589824/786432 字节，heap 分别为 67108864/67108864/115998720 字节。随机起点分别覆盖三个已验证闭合 GOP，不提高 300 packet 预算。

冻结只读结果仅在入缓存时复制；公共请求仍返回隔离的数据，遮罩命中不深拷贝整份结果。画布仅尺寸变化时重设，帧、几何、样式均未变化时跳过绘制。命中提示由单个按需 output 显示，并验证其经过全局 tooltip 处理后仍可见。
