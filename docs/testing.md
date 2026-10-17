# 验证说明

套件与稳定 case ID 以 `scripts/testing/manifest.json` 为准，统一入口为 `scripts/run-tests.mjs`。`package.json` 保留原有单项命令。不要把某次历史测试数量或构建成功当作当前兼容性结论。

码流分析的 `ci-analysis-browser` 保留完整本地套件。CI 将 MP4、legacy FLV、enhanced FLV 三个矩阵分片分别放在 Chromium/WebKit 的独立并行 job 中，使用 `ci-analysis-matrix-{mp4,flv-legacy,flv-enhanced}`；每个 job 只跑一个矩阵 case，合计保留每种引擎全部 36 格。流式图表、增量索引、几何、布局由 `analysis-browser` job 的 `ci-analysis-ui` 必跑，使用逐例生成的小素材，不下载 QA 样片。普通只读分析面板两引擎用例归入已有样片环境的 `uncovered` job。三个真实分析 Node 用例由 `unit` job 的 `ci-node-media` 必跑，不在每种浏览器重复执行。`release-set` 同时依赖 `analysis-browser` 与整个 `analysis-matrix`，任一分片失败、取消或跳过都不能产出验证通过的发布集。

各矩阵、流式图表与增量索引 case 仍拥有独立服务、浏览器、临时目录和 600 秒整例 watchdog。原有逐操作超时、整片 ready/EOF/帧数、取消、身份与性能断言保持不变；没有延长 job 超时或降低性能门槛。直接调用 `node scripts/testing/browser/media/bitstream-analysis.mjs <engine>` 会依次运行 matrix、diagrams、index 三组；每组独占服务、浏览器、临时素材及报告，一组失败仍完成其他独立组，最终非零退出。

统一 runner 会按清单准备明确标记 `prepareOnDemand` 的本地衍生 fixture，目前仅 `analysis-flv`：任一所需输出缺失时，先验证三个固定 MP4 输入，再调用 `node scripts/make-analysis-flv-fixtures.ts`，重新检查六种基础 FLV 与 H.264 损坏/重复配置变体。每次套件内只准备一次，生成器拥有独立 300 秒超时、取消与子进程清理；失败记录在套件目录的 `fixtures/analysis-flv/`，依赖它的 case 失败，其他独立 case 继续。`unit`、`media` 和浏览器入口共用此前置流程；core、基础视频和 FATE 等外部资源仍须事先显式同步，不会自动下载。

## 验证层级、职责与 CI 分工

新增用例先明确一个可解释的行为、必要环境和独立的预期依据，再选择层级。纯计算放 Node 逻辑；取消、迟到结果和资源释放放可控异步模块测试；真实解码/像素身份放媒体集成；焦点和手势放浏览器交互；完整应用流程只覆盖实际接线。一个行为可以有多条相互支持的断言，不需要机械拆成每个断言一个 case。禁止为了减少维护成本而删除矩阵、扩大容差、增加重试或用同一实现生成预期来掩盖错误。

本地 `unit` 是完整入口。CI 的 `source` 与 `ci-node-media` 在每个平台必须互斥，且并集严格等于 `unit`；新增用例缺少归属或被两边重复选择都会使清单验证失败。独立的 `analysis-logic` job 已移除，其用例仍属于 `source` 并受门禁保护，原 `ci-analysis-logic` 仅保留为本地领域筛选。原生 Node/Bun 或不同平台的重复有独立兼容性目的，继续保留。发布汇总同时依赖源码和媒体分片，任一失败、取消或跳过均不能生成验证通过的发布集。

`--plan` 输出本次选择的层级、责任、实际执行模块、引擎/输入、素材、工具和预算，不启动服务、不构建、不运行测试。每次实际执行也在报告目录写入 `plan.json`。已有用例的层级可按其所属目录给出初始分类；尚未人工梳理的责任保持 `reviewNeeded: true`，不把分类自动视为已经覆盖某项产品能力。analysis 先作为明确责任的试点：

| 行为组 | 责任 / 预期依据 | 必要环境 |
| --- | --- | --- |
| navigation | 区间编辑、缩放锚点、seek 分离、参考层级 | 生成的 H.264 / HEVC 小素材 + 两个 core |
| layout / overlay | 首帧布局、滚动、焦点及覆盖层隔离 | 生成的双轨小素材 + 两个 core |
| matrix | 已有完整编码 × 输入 × 解码策略、像素与缓存/Range 断言 | 对应固定 QA 样片 + 两个 core |
| diagrams | 可见 GOP、并发准入、图表交互、多轨身份和能力限制 | 按需生成 stream / incremental / queue / depth 素材 |
| index | 部分 FLV 索引的暂停、继续、取消及非 EOF 契约 | 生成的增量 FLV + 可控服务端 gate |
| geometry | 旋转、裁剪、SAR 与 RGBA 回退的实际帧身份 | 原有生成器 + 两个 core |
| 普通 analysis 页面 | 只读容器查询、双轨配对、DTS、播放共存 | 复用 `uncovered` 的 QA 样片环境 |

行为组在 `scripts/testing/analysis/plan.mjs` 声明职责、阶段和生成素材 profile；场景函数位于 `scenarios/`，无导入即执行的副作用，通过显式 context 使用当前 case 的服务与控件。`fixture.mjs` 只拥有生命周期和故障 gate，`controls.mjs` 只操作公共 UI/Session facade；预期和断言留在场景内。每例生成素材位于其临时目录，成功/失败均由夹具删除。领域阶段用 `stage()` 命名，保留 case 的整体 watchdog；内部等待继续使用原逐操作期限，命名阶段不会偷偷增加 30 秒限制或延长整例预算。

analysis 行为组和普通 analysis 页面均先把已构建的静态资源复制到自己的临时目录；服务端、浏览器 Worker 与矩阵的 build-info 校验读取同一快照。复制前后及副本的字节摘要必须一致，复制期间遭遇重建则在启动浏览器前明确失败；之后其他本地套件重建 `dist` 不会删除当前页面将要加载的分块或替换 core 身份。快照随 case 清理。其他尚未迁移的专用脚本仍应避免在运行中重建其共享 `dist`。

benchmark 的诊断流程位于 `scripts/testing/playback-diagnostics.mjs`；故障注入测试直接调用该函数验证诊断失败、落盘和原始异常保留，不再按源文件缩进和字符串边界截取代码。新增测试应优先操作公开函数/协议和可观察结果；源码扫描只用于明确的架构边界。

迁移时原 501 条浏览器行为断言中，497 条移入场景及诊断函数，4 条汇总检查留在入口；此数量只记录本次迁移核对，不作为未来冻结文件布局或断言数量的门禁。长期保护使用稳定 case ID、矩阵轴、required 属性、职责、实际执行及故障注入证据。历史覆盖下限仍保留，已有命令与预算没有缩水；未来迁移应审查行为映射，不能只修改计数让检查通过。

```sh
node scripts/run-tests.mjs ci-analysis-ui --plan
node scripts/run-tests.mjs unit --plan --platform linux
node scripts/run-tests.mjs ci-node-media
```

## 统一套件与单项筛选

| 入口 | 范围与准备 | CI 对应 |
| --- | --- | --- |
| `npm run test:fast` | 明确登记的轻量 Node 逻辑与测试基础设施契约；不需要媒体、core 或浏览器 | 本地快速反馈；完整 Node 检查由 playback job 运行 |
| `npm run test:source` | 所有不依赖媒体、core、浏览器、外部工具或构建的 Node 逻辑测试；新增适用用例必须登记 | 独立 `source-logic` job，不等待解码器构建 |
| `npm run test:contract` | 清单、覆盖下限、独立结果、生命周期、发布依赖等契约 | identity / playback job；release identity 在安装依赖前也检查清单 |
| `npm run test:suite -- unit` | 全部 Node 测试，包括真实 WASM 与媒体断言；准备完整媒体环境 | CI 为 `source-logic: source` 与 `unit: ci-node-media` 的互斥并集 |
| `npm run test:browser:all` | 自动化浏览器检查及内部矩阵；Chromium/WebKit、媒体/core/FFmpeg，默认构建一次 | `ci-audio`、`ci-playback`、`ci-cache`、`ci-flv`、`ci-fate`、`ci-analysis-ui`、`ci-analysis-matrix-*`、`uncovered`、`flv-startup` 与 HEVC 四格矩阵 |
| `npm run test:media` | 真实媒体 Node / 浏览器检查；包括特殊的可信 HTTPS 功能用例 | playback / hevc-browser job；可信 HTTPS 仅在一次性 CI 主机执行 |
| `npm run test:suite -- release` | 固定 core 来源、原生归档、归档浏览器及三平台汇总；需先生成对应产物 | decoder / native-release / release-set；打包及草稿操作仍由 workflow 管理 |
| `npm run test:perf` | 索引构建、争用和可信 HTTPS 播放性能；所有结果显式 informational | `ci-perf`，保留 `continue-on-error`；可信 HTTPS 仅在一次性 CI 主机执行 |

`browser` 是自动化浏览器套件。需要 Windows 可见桌面的 Chrome/Edge 色彩与 WebGPU 检查属于清单中的 `manual-regression`，仍使用原有专用命令；外部服务、用户指定媒体的诊断/实验/基准属于显式工具分类，不会自动变成发布门禁。清单记录限制和理由，不能把 `npm test` 当作 fast，也不能把旧 `test:browser` 当作完整浏览器套件。

FLV 浏览器回归固定 640×480 视口，两种引擎均解码原始尺寸的输入。Chromium 的隔离 headless 进程显式启用 SwiftShader WebGL，避免 GPU 黑名单把整帧 YUV 转换送进逐像素 CPU 兜底；这不代表物理 GPU 或大视口性能验收。普通本地命令仍按原有全部性能阈值必过。GitHub 虚拟 runner 显式设置 `VOIDPLAYER_FLV_VIRTUAL_PERF=report`，只在 Linux headless Chromium、未验证物理硬件、已知 WebCodecs/WASM 与 browser-managed/WebGL 渲染路径中把 `below-realtime` 和 `A:presentation-stall` 留作非阻断性能报告；基准的阈值、`passed:false` 和失败原因不变，负面结果写入 job summary。没有采样/帧、错误、延迟、同步偏差与暂停后冒帧等失败仍阻断，seek、逐帧、尾帧与 Range 原有断言也保留。每个输入的完整结果保存到 `.run/playback-reports/flv/<engine>/` 并随 CI 报告上传。0.6.0 预检的 [1080p HEVC 负面记录](evidence/release-0.6.0/flv-legacy-hevc-ci.json)为 0.366×，[AV1 负面记录](evidence/release-0.6.0/flv-private-av1-ci.json)为 0.8998×，不能把功能门禁通过解释成实时播放达标。

HEVC 时间线检查保留每个输入两轮各 600 帧、每帧源尺寸截图、帧身份和 seek/逐帧/尾帧断言。Linux Chromium 每次全尺寸截图实测可耗时约 0.6–1.4 秒，因此 Chromium 单项总预算为 30 分钟，CI job 留出 35 分钟；这不是实时播放性能阈值。每 100 帧以及打开、seek、重开边界记录进度和呈现/截图/读回耗时；页面连续 180 秒没有进度则立即失败并输出最后阶段，关闭页面与浏览器。播放基准的帧率、延迟与停顿阈值不变。

Node/WASM 单元由独立 `source-logic` / `unit` job 分工；串行 `playback` CI job 包含音频、播放、片源 UI、标注/缓存、FLV、FATE 和可信 HTTPS 检查。Linux 实测前序检查全部通过后，HTTPS 可在第 35 分钟才开始；该 job 总预算为 45 分钟，为后续检查和报告上传留出余量。统一清单中的各用例时限、FATE 步骤时限和必需断言均保持不变；不能将总预算取消解释为已完成 HTTPS 验证。

analysis matrix、FLV startup 和 HDR 功能套件通过 `scripts/testing/playback-presentation.mjs` 等待真实 Session 呈现事件：commit 与实际帧时间必须严格前进，源/generation、已提交帧和可用的精确 picture 身份必须匹配。20 秒无严格进展、60 秒总期限及独立 65 秒宿主 watchdog 限制宿主等待（浏览器清理由调用方 finally 负责）；重复帧与元数据心跳不能续期。暂停后保留原 100ms 稳定性观察，并拒绝迟到呈现。playing 时长从实际进入播放起计算，中途暂停再恢复也失败。只读窗口订阅直接复用 Session 状态与呈现事件，不复制帧资源或改变渲染/解码算法。

原 1/1.5/2/4 秒 benchmark 窗口、绝对性能阈值、`passed:false` 和原因保留为独立报告，不用功能等待期间的帧补写原样本。错误、错源/错帧、提前结束、异常中断和暂停残留仍阻断；短窗口无帧由独立严格呈现证明替代。FLV 分辨率/open-GOP 的实际帧仍须推进超过既有 100ms 媒体下限，再核对帧所属尺寸和显式后段 seek；缓存 workload 仍做 20 次播放、保留实际 playing 时长、命中率和几何断言。源码 benchmark 的绝对目标尚未达标不能解释成物理硬件验收；可信 HTTPS 配对脚本目前也没有候选/基线回归比值阈值。

```sh
npm run test:manifest
npm run test:suite -- browser --list
npm run test:suite -- browser --engine webkit --list
npm run test:suite -- --case browser-menu-webkit,browser-settings-chromium
npm run test:suite -- browser --case hevc-timeline-webkit-remote
npm run test:suite -- ci-native-console --platform win32 --list
```

`--case` 使用精确 ID，可逗号分隔；与套件、引擎、输入筛选取交集。带内部多引擎/输入循环的脚本作为一个 case 整体执行，筛选不会改写它的内部覆盖。`--platform` 仅用于枚举，不允许在另一平台伪执行。`--list` 输出适用 case、命令、引擎、输入、平台、夹具、外部工具、超时、产物目录、required 属性及不适用理由；空选择不算通过。参数拼写错误直接失败。缺少夹具、工具、浏览器或原生包是失败，不是自动跳过。

清单中 `fixtures.*.prepare` 给出准备命令；suite 不隐式下载或更换参考结果，仅为明确标记 `prepareOnDemand` 的本地衍生 fixture 生成缺失输出。CI 每个 job 只准备一次可复用媒体/core，并继续负责下载、系统依赖、浏览器和平台矩阵。内部断言专用的可写夹具仍由各 case 自行生成。

### 解码 Worker 的消息契约

`src/media/workers/worker-protocol.ts` 定义 FFmpeg 与 packet Worker 的命令、请求、响应和渐进索引事件。
`WorkerRpc` 位于 `src/media/workers/worker-rpc.ts`；FFmpeg 的旧导出保留兼容。调用者只传命令和对应参数，
响应从命令推导；Worker 用 `workerReply` 按请求命令检查回包。索引输入单独按 action 区分，
不占用新的 RPC 或改变 ready/batch/complete/error 的确认顺序。

`node-worker-rpc` 登记在 fast、unit、contract 和 ci-playback。它运行编译期负例
（未知命令、缺字段、错误字段、任意结果类型及错误回包）与 Browser Worker 接口、真实
Node worker_threads 的 transport 测试。负例位于 `test/helpers/worker-protocol-types.ts`，
随 `tsc --noEmit` 和 build 编译；删除类型约束会导致未使用的 `@ts-expect-error` 报错。
真实媒体仍由现有 FFmpeg、FLV 和 MP4 用例验证，播放性能阈值保持不变。

消息格式仍为 `{ id, type, ...payload }` 和 `{ id, ok, data/error }`；结果依靠请求 ID
对应 pending 请求，类型约束针对同版本内的 Worker，不在每帧路径增加序列化或结构校验。
帧描述与缓冲范围继续由媒体适配器验证，取消后迟到的 VideoFrame 由 transport 关闭。

### 构建、隔离与报告

普通套件运行会为需要构建的 case 构建一次。多个 CI 步骤复用同一个源码/配置的构建时使用：

```sh
node scripts/run-tests.mjs --prepare
node scripts/run-tests.mjs ci-audio --prepared
node scripts/run-tests.mjs ci-playback --prepared
node scripts/run-tests.mjs uncovered --prepared
```

`--prepared` 必须有当前 job 显式生成的凭据，校验源码（包括未提交改动）、配置、Node/平台、实际 core 字节和 dist 输出；过期或损坏时失败。普通运行不自动读取旧凭据。不同平台/job 不共享构建凭据。构建日志在报告下的 `build/`，显示本次构建或验证后的复用。

新入口的选择清单在 `.run/test-suites/<suite>/selection.json`，逐项日志和聚合结果在同目录的 `<case>.log`、`results.json`；单例筛选默认目录为 `selected`，可用 `--directory` 另选目录。旧 runner 仍支持 `node scripts/run-browser-regressions.mjs uncovered` / `flv-startup`，保留 `.run/browser-regressions/<suite>/` 的报告路径与 case 名。

每个 case 是独立子进程，断言失败、准备失败或超时后仍运行其他独立 case；required 的失败、取消或缺失结果使总检查失败。报告从运行前开始写入，未完成的通过前缀不会成为通过套件。informational 失败保留原始退出码、日志和状态，但不阻断 required 聚合。纯 informational 套件有失败时仍返回非零，CI 在独立性能步骤使用 `continue-on-error` 并显示警告。SIGINT/SIGTERM 会清理活动子进程树并记录取消结果。父级 runner 为每项提供独占系统临时目录（TMPDIR/TEMP/TMP），正常、失败、超时和取消后均删除；即使子进程被强制结束也不会绕过该清理。报告记录 temporaryDirectory、temporaryDataRemoved 与独立 cleanupErrors，日志和失败截图目录保留。

13 类回归（menu、settings、theme、shortcuts、feedback、mark-cards、color-settings、metadata、stepping、timeline、annotation、annotation-rendering、workspace）已迁入 `scripts/testing/browser-fixture.mjs`：每个 case 独占临时 SQLite、随机端口、浏览器/context 与产物目录，正常完成、断言失败、部分启动失败、超时、取消均按逆序清理。失败产物包含 case/engine/阶段、原始异常、控制台、页面错误、Range 请求、可用的会话状态、截图与 DOM。清理异常单独写入 `cleanup-errors.json`，不会替换原始异常。公共 fixture 接管 SIGINT/SIGTERM/SIGHUP，旧单项脚本直接中断也会先完成资源清理，并在结束后移除信号监听；浏览器关闭由 fixture 统一负责。可信 HTTPS/身份、服务重启、Range 故障注入、Vite 测试页及原生包浏览器保留专用生命周期和服务扩展；它们仍由统一 runner 执行并登记既有产物目录。主题的受限存储 context 与设置的 DPR 2 context 通过 `newContext` 登记；额外 context 的启动失败或取消也属于同一 case 的清理范围。扩展服务在开始监听或等待 ready 前可用 `defer` 注册部分启动资源。连接与身份的普通 HTTP 测试共用 `http-origin.mjs`，将虚拟测试域名的 HTTP 请求转到临时 loopback 服务，保留页面的不安全 origin；HTTPS 请求不匹配此转发，仍验证真实证书信任。

### 浏览器测试约定与失败取证

测试入口首先声明环境前提，操作后的断言等待可观察的完成状态：

- 通过 Agent 调用分享不带点击激活；Chromium case 必须为当前服务 origin 显式授予 `clipboard-write`，不可全局放开权限。专门验证剪贴板拒绝的用例保留拒绝路径。不同引擎只配置其支持的权限，不以捕获权限错误后继续执行代替授权。
- 通用夹具的 `ready()` 已等待动态入口发布 `window.voidPlayer.tools`。专用生命周期在导航、重载后也必须等待实际需要的 API/会话状态，再调用工具。
- `scripts/testing/browser-contracts.mjs` 的 `waitForDialogClosed(page)` 同时等待设置对话框退出、关闭标记清除和焦点归还。其他对话框显式传 selector/invoker；不要求焦点时显式传 `{ invoker: null }`。不要只等元素隐藏后立刻发送快捷键。
- 主题/高对比度变化使用 `settleAppearance(page)` 等待有限动画完成及布局刷新；忽略持续动画，但不禁用动画、不降低动态效果配置。颜色检查针对可渲染的控件或有标识的临时 probe，不读隐藏值存储器的绘制样式。既有 tooltip 延迟、暂停稳定性等有意观测窗口仍保留。
- 比较基线在相关前置操作完成后采集。拖动、seek、换源后重新获取所需基线，不沿用旧视窗。异步索引需明确等待状态或明确测试增量状态。缩放目标必须处于可达范围；测试手势生效时还须证明前后范围确实不同，零位移不能算通过。

公共夹具支持给等待命名并记录操作前现场：

```js
checkpoint('scroll-baseline', { view, scrollTop });
await phase('scroll-charts', () => page.waitForFunction(
  before => document.querySelector('.analysis-charts').scrollTop > before,
  scrollTop,
), { expectedView: view });
```

`checkpoint(name, details)` 在调用时克隆数据；`phase(name, action, details?)` 保留步骤状态、开始时间、耗时及原始错误，遵守既有逐操作和整例期限。两类记录各保留最近 50 条。完成的步骤不会把后续普通断言误标为之前的步骤。优先标记关键操作和边界，不把每个点击包装成阶段；记录有用的基线和预期，避免保存帧数据。

失败 JSON（`schemaVersion: 2`）在访问浏览器前先落盘。现有字段继续保留，并增加步骤/基线、浏览器与视口/DPR、媒体查询、主题、焦点、打开的对话框/菜单，以及关键控件的几何、计算样式和图表 dataset。Range 和普通 API 请求分别记录总数、待完成数和最近 100 条；另保留最近 100 条 HTTP/网络失败（包括静态资源）。控制台和页面错误也各保留最近 100 条，不记录请求体。截图、DOM、会话状态和界面摘要独立尽力采集；崩溃、超时或采集失败不能替换原始异常。

需要重启服务的标注持久化 case 保留专用生命周期，但共用取证器，统一 runner 下在逐 case 产物目录保存各页面的阶段和现场，随现有 CI 报告上传；直接运行时默认写入 `.run/playback-reports/annotation-persistence-<engine>/`。公共夹具报告同样遵循逐 case 产物目录及直接运行的默认目录。读取失败证据时先看统一 runner 的 `results.json`，再看阶段、基线、实际图表 dataset 和网络记录；不要只凭超时判断 runner 抖动。

`browser-contracts-{webkit,chromium}` 已登记在 `browser` / `uncovered`，不依赖媒体、core 或构建。它们故意触发一次真实页面超时，只有确认等待约定、原始失败、JSON/DOM/截图取证均正确才通过；其 `*-failure.*` 是预期的测试产物，不代表该 case 失败。Node 契约同时覆盖请求缓冲淘汰后的总数、不可变基线及清理异常。

### 覆盖下限与兼容入口

`test/testing-coverage-baseline.json` 保存迁移时已有 case × engine × platform × input、执行命令、required 属性与 CI 归属下限；`test/test-manifest.test.mjs` 检查每格仍存在。`uncovered` 保留原有 20 格，并补齐此前遗漏的 16 格；CI 按 Chromium/WebKit 拆分执行。FLV startup 两引擎、HEVC 的两引擎 × 本地/远程（各两次重开）、FATE 内部矩阵和原生 Node/Bun 三平台验证都保留。本地 `unit` 仍运行完整 Node 验证；CI 由 `source` 提前验证无需媒体的逻辑，`ci-node-media` 只运行剩余 Node 用例；断言、媒体和参考结果不变。新增 case 必须显式登记，删除矩阵项或 required 属性会使契约失败。不得改写覆盖下限文件来掩盖覆盖减少；新增基础设施用例和工具可追加登记。

契约测试解析发布与身份工作流中的 suite/case 选择和引擎/输入矩阵，要求每个 required 浏览器组合都被实际选择；移除 job、漏掉矩阵引擎或新用例未接入 CI 会失败。

CI 细分套件是统一清单的标签，本地执行相同标签会枚举相同的平台适用 case；不是第二份脚本列表。发布依赖测试继续确保所有 required job 成功才能汇总和创建草稿。`ci-native-http` / `ci-identity-http` 使用隔离数据模拟远程 HTTP 入口；`ci-native-https` 与 `ci-https` 涉及临时证书信任，入口要求 `CI=true` 的一次性主机，普通本地运行会明确失败而不会修改信任。

旧 npm 命令和脚本路径保持兼容，包括它们的既有默认引擎、参数和构建行为。例如 `npm run test:browser` 委托 runner 的 `--alias test:browser`，由现有清单 case 的 `npmAliases` 绑定选择默认 WebKit，传入 `chromium` 只选择原来的 Chromium 基础 UI case；准备步骤、默认参数和执行命令来自唯一 case 定义，别名不再独立编排 build。`npm run test:browser -- chromium --filter=子用例名` 保留原筛选参数，并在选择记录标记部分执行；未匹配任何检查必须失败，CI 覆盖枚举不能把筛选后的 case 算成完整覆盖。它仍不是完整浏览器套件；连续执行旧带 build 的命令仍会重复构建，需要完整或组合检查时使用新套件入口。浏览器领域实现归入 `scripts/testing/browser/{ui,annotations,media,workspace}/`；127 个 Node 文件分批归入 `test/{unit,contract,media}/`，可复用模块归入 `test/helpers/`。顶层旧脚本和 Node 文件保留薄入口，清单的 `implementation` 记录实际文件。只选择旧入口或实际文件中的一处执行，不能同时枚举两处导致重复用例；`npm test` 委托 `node scripts/run-tests.mjs unit`，与 CI 使用相同的 case ID、准备步骤、超时及逐项结果；不再依赖顶层 glob。`npm test -- --list` 枚举适用用例，`npm test -- --case node-test-manifest` 可缩小选择。runner 逐项运行，原来的 Node `--test-concurrency=4` 不再维护另一份调度；参数使用 runner 的选择选项，单文件 Node/Bun 命令和旧脚本路径保持兼容。契约检查旧入口指向、唯一实现归属，以及漏登记或悬空实现。开发、夹具、诊断、性能和发布工具分列于 `scripts/tools/`，入口与保留专用工具见 [脚本职责索引](../scripts/README.md)。逐项覆盖下限见 `test/testing-coverage-baseline.json`，当前选择以统一清单为准。

## 准备

```sh
npm ci
bash scripts/sync-wasm-core.sh
bash scripts/sync-samples.sh
npx playwright install webkit chromium
npm run fixtures:flv
npm run fixtures:hlg
node scripts/sync-fate-samples.mjs
```

FLV 样片生成需要 Python 3、ffmpeg 和 ffprobe。`fixtures/`、`dist/` 和 `public/vendor/voidplayer-core/` 是本机产物，不进入 Git。需要基础合成样片时运行 `python3 test/generate-fixtures.py`。

发布 CI 的 FLV 硬件优先策略回归使用 `FLV_CASE=standard-h264`，同时限定素材生成与浏览器用例，验证 WebCodecs、Range、seek 和播放。完整 FLV 回归仍默认覆盖所有编码，其中 H.266 素材生成需要支持 VVC 的新版 FFmpeg；Ubuntu 24.04 自带的 FFmpeg 6 无法生成该素材。

## 常规检查

```sh
npm test
npm run build
npm run test:browser
node --test test/range-reader.test.ts test/mp4-packets.test.ts test/range-media.test.ts
npm run test:range:browser
```

单元测试使用 Node test runner，包含真实 WASM 和 FLV 解码。浏览器脚本启动独立的临时媒体服务并清理，不需要刷新用户页面或重启后台服务。各脚本的默认引擎和可接受参数不同：支持引擎参数的旧 npm 命令可在末尾追加 `-- chromium`；固定引擎或内部矩阵不能用该参数扩大覆盖。组合执行优先使用上文的清单筛选。

| 改动 | 补充验证 |
| --- | --- |
| 页面启动、模块载入与失败提示 | `npm run test:startup:browser`、`node --test test/startup.test.ts` |
| 标注交互、采样与图层 | `npm run test:annotations:browser`、`npm run test:annotations:rendering` |
| 设置窗口、分类导航、焦点、日志及窄屏布局 | `npm run test:settings:browser` |
| 工作区导入导出、失败回滚、外观设置及进度回跳 | `npm run test:workspace:browser` |
| 亮暗主题、系统跟随、外观持久化 | `npm run test:theme:browser` |
| 菜单、色盘、工具条 | `npm run test:menus:browser` |
| 标记身份、卡片、缩略图 | `npm run test:mark-cards:browser` |
| 快捷键与 tooltip | `npm run test:shortcuts:browser`、`npm run test:feedback:browser` |
| 混合帧率步进 | `npm run test:stepping:browser` |
| 时长、进度、子轨道 | `npm run test:timeline:browser` |
| 像素格式与色彩元数据 | `npm run test:metadata:browser` |
| FLV 文件路径 | `npm run test:flv:browser` |

修改播放或解码路径后还必须跑播放基准。修改视图尺寸调度、轨道操作或片源 UI 后跑 `test:browser`。

启动回归在 Chromium / WebKit 验证开发页面和打包页面的真实界面。它模拟入口、静态依赖、动态模块及 Vite 预构建依赖的 504，检查错误提示与重新加载；请求持续无响应超过 15 秒时显示重试，迟到的成功启动可以恢复界面，正常启动后停止超时监测。Node 开发服务测试还检查启动模块及 MessageFormat 运行时的 HTTP 状态与 JavaScript 类型，避免仅凭首页返回 200 判定可用。

## 播放基准

先构建并启动包含 QA 媒体库的服务，然后运行：

```sh
node scripts/bench-playback.mjs webkit
node scripts/bench-playback.mjs chromium
```

`BASE_URL` 选择服务地址，`BENCH_REPEATS` 默认 3，`BENCH_DURATION_MS` 默认 8000。`--headless` 为离屏自动化运行。场景和阈值分别以 `scripts/bench-playback.mjs`、`src/session/benchmark.ts` 为准。

播放基准通过 Agent `benchmark_review` 和脚本运行，设置页不提供手动检查入口。它检查呈现帧、速度、等待、卡顿、同步和暂停后的旧帧；失败场景使脚本返回非零退出码。

远程 HTTP 现在进入连接准备页，不再启动播放器或 WASM。对应检查为：

```sh
npm run test:connection:browser
npm run test:presentation:browser
```

前者检查 Windows/macOS 安装步骤、实际公开 CA 下载、HTTPS 链接与未配置状态，并确认未加载播放器或解码 Worker；后者在 Chromium/WebKit 中检查原生帧和 RGBA 直接上传、按需源像素、旋转、像素缓冲复用、无 WebGL 回退与资源清理。页面取源像素应使用 `window.voidPlayer.captureFrame(slot)`，不要直接读取可能尚未生成的隐藏 canvas。

发布工作流使用 `VOIDPLAYER_HTTPS_TEST=1 node scripts/check-http-playback.mjs` 验证可信 HTTPS 下的重复载入和播放：只在一次性 Actions runner 中导入测试根证书，结束后删除信任项；浏览器不使用忽略证书错误的参数。样片由 `node scripts/make-playback-fixtures.mjs` 生成，报告写入 `.run/playback-reports/`。Linux 和 Windows 还检查用户设置、重启恢复、解码出帧与标注。本机播放基准使用上文的 localhost 媒体服务，无需更改本机证书信任。

帧队列同时按数量和字节限制，播放报告的 `measurements.buffers` 记录每轨当前值、峰值及上限。这仅统计队列内已解码帧，不代表浏览器总内存；解码器、压缩文件、画布与 GPU 还会占用内存。

CI 将这两类检查分开运行：`--functional-only` 检查载入、解码路径、资源释放和队列边界，失败仍阻止发布汇总；`--benchmark-only` 单独输出性能报告，保留原阈值和非零失败退出码，但该步骤不阻止合并或发布汇总。无参数时仍依次运行全部检查。共享 runner 的绝对速度不是目标设备性能，也没有 main 的同环境对照，不能独自判定 PR 性能回退。身份工作流仅在 PR 和 main 推送时触发，避免同一 PR 分支推送重复运行。

这些是当前设备上的 canvas 呈现证据，不是物理显示扫描、所有 Safari 版本、HDR 保真或低端硬件性能保证。浏览器下载和剪贴板还受宿主权限影响，不能用“调用成功”代替实际文件/内容送达验证。

## 独立发布产物

使用 `.bun-version` 对应的 Bun 执行 `npm run release`，可用 `BUN_BIN` 指定可执行路径。`npm run test:release` 校验最新归档并在临时目录解压运行；也可传归档路径。测试服务使用空 PATH，不依赖源码或 node_modules，覆盖配置初始化、不同工作目录、HTTP/HEAD/Range、并发、中断、鉴权、上传日志、退出及升级保留数据。`RELEASE_BENCH=1 npm run test:release` 额外用 WebKit 在独立服务上跑四组真实播放基准，需要同步样片和浏览器。

远程 WASM 专项验证包含 MP4/VVC 索引不遍历 mdat、与原 FFmpeg 路径逐像素对比、B 帧/GOP 随机跳转和尾帧、5 GiB 稀疏来源、Range 响应校验与取消。`range-media.test.ts` 使用真实本地 HTTP 服务；`range-reader.test.ts` 使用可控响应检查缓存与 AVIO 桥接，不替代浏览器网络验证。私有 FLV 继续由 `test/flv.test.ts` 和 `test:flv:browser` 覆盖。

## 专项回归与行为边界

下列说明帮助选择专项检查；完整行为契约见 [架构](architecture.md)、[渐进索引](progressive-indexing.md) 和 [色彩链路](color-pipeline.md)，历史阶段计数见 [文档导航](README.md)。

### FLV first-frame and shared index cache

`node --test test/flv-startup.test.ts test/frame-index-cache.test.ts` checks checkpoint resume, bounded reads, index deadlines, decoder retry, cache schema/version validation, persistence, deletion and offline storage.

After syncing the pinned core and generating `standard-h264.flv`, run `node --test test/flv-background.test.ts` and `npm run test:flv:startup`. The fixture appends a sparse 256 MiB audio tail and blocks reads beyond the initial 64 KiB. The first decoded/drawn frame must arrive while the tail remains blocked. After release, the completed index becomes available, a second opening reuses the cache without rebuilding, and playback plus administrator UI/WebMCP clearing are checked. Run `node scripts/check-flv-startup-browser.mjs webkit` for WebKit.

FLV startup reads the configuration and first video packet, then flushes the decoder to display that frame. Local files and arbitrary URLs resume the client scanner from the saved tag offset; seeks wait only for the required published prefix. Version-pinned library URLs instead start or join the server shared-parser disk scan, receive progress, and import resumable chunks of the completed document. That server path does not publish playable prefixes during scanning, so seeks beyond startup coverage wait for completion. Index work does not block the first presentation. Duration is provisional until finality, exposed as `indexState` in session metadata and the inspector; a failed library build is not silently replaced with a browser full-file scan.

Media indexes are stored in `library.sqlite` schema 7, keyed by media ID/version, kind, stream, schema, and indexer build. The schema migrates older FLV rows into identity-keyed manifests and batches; downgrading to an older schema requires restoring the prior database backup or rebuilding the library index. Only version-pinned library URLs use the cache API. FLV client uploads validate bounded packet offsets, codec configuration, and timing. FFmpeg fallback indexes are built on the server for versioned library media and streamed as validated record batches. MPEG-TS scan progress is reported before batches; the demux scan reaches EOF before the complete record set is persisted and transferred. While batches import, `indexState: building` means index finality has not arrived, not that scanning is still in progress. The complete document remains available for compatibility. Missing/changed files and removed/relocated roots invalidate caches, while offline storage preserves them. FLV uploads are capped at 32 MiB; FFmpeg record streams are capped at 2 million records/128 MiB, and total live cache data is capped at 256 MiB with least-recently-used eviction. Clearing increments an epoch so an earlier in-flight upload cannot undo the clear. SQLite may retain reusable free pages after deletion.

Administrators can list/search and clear individual versions or all caches under **帧索引缓存**. `list_frame_indexes` and `clear_frame_indexes` are registered through WebMCP in both the player and administration page and share the same client functions and server authorization.


暂停续播回归：`test/session.test.ts` 验证双轨连续暂停/恢复不重新 seek 或创建迭代器；定位、替换及释放会销毁原队列。`test/playback.test.ts` 验证暂停期间未完成解码最多归还当前一帧、不继续拉取，且未显示的帧不会被丢弃。播放队列仍按 4 帧 / 64 MiB 双重背压限制，允许单帧超预算以保证进展；原生帧按 allocationSize 估算像素存储，格式不可见时才按 RGBA 估算。该值不包含解码器内部参考帧、Mediabunny 预解码队列或 GPU 的全部开销。暂停保留这些有界解码资源以便快速续播，移除轨道才完全释放。

`check-http-playback.mjs --functional-only` 在真实 MP4/WebCodecs 上验证暂停无时间推进、快速反复续播不重新 configure 解码器，并继续执行原有双轨内存与资源释放检查。性能基准仍独立记录，避免把续播改善等同于持续解码达到实时。

失败诊断：`test/media-diagnostics.test.ts` 覆盖带 CRC 的 PAT/PMT、跨包 PSI、连续计数缺口、188/192/204 字节 TS 包，以及 AVS3 (0xD4)、HEVC (0x24)、私有 PES (0x06) 不误识别。只有所有打开路径都失败且不是网络/资源错误时，才额外探测至多 64 KiB、远程读取至多等待 1.5 秒。诊断报告 PMT 声明的编码，不把声明当作码流有效性证明；探测失败保留原错误，不扩大下载范围。


FLV 损坏恢复：`test/flv-recovery.test.ts` 和 `test/flv.test.ts` 验证首帧优先、尾部截断与有界内部重同步。已有有效配置和起始关键包后，标签类型/flags、stream ID、PreviousTagSize 或不完整标签等结构损坏会尝试有预算的重新定位；后续必须同时证明标签结构和独立解码锚点，不能仅凭容器 key 标志恢复。找不到安全锚点或耗尽预算时保留已验证前缀，配置头或起始关键帧缺失仍失败。IO/版本变化、取消、不支持的编码/配置和资源限制不转成可缓存的损坏文件。时长来自保留包的真实时间戳；`indexIntegrity` 区分 complete / recovered / prefix，警告及 `indexTruncatedAt` 保留损坏边界，索引 complete 仅表示终态。共享 FLV 帧索引为 schema 3 / `flv-demux-v3`，保存恢复间隙、损坏原因与解码边界；旧格式按新身份重建，客户端和服务器需一起升级。详细恢复预算与准入见 [FLV 时间线](flv-timeline.md#damaged-tails)和 [容器恢复](container-recovery.md)。

真实 HEVC/私有 VVC/AVC 回归在完整码流后追加残缺视频标签，验证连续取帧、前后定位、尾帧及警告。首帧浏览器夹具包含被阻塞的大尾部和最终残缺标签，验证后台恢复、播放基准、警告显示与服务器缓存复用。缺失包可能是其他完整包的参考帧，因此恢复不保证任意损坏流都能输出每一帧；解码失败保留上下文并停止重复调用失败的解码器。worker 原始异常堆栈进入现有本地诊断日志，不额外上传。


FLV 同编码配置/分辨率切换：索引记录每段配置和所属视频包，新配置从关键帧开始；解码或跨段定位时切换对应配置并在段末 drain，避免丢失旧段 B 帧。WASM 复用模块，通过既有 vp_packet_open 重建上下文；WebCodecs 重新 configure。`test/flv-resolution.test.ts` 生成真实 H.264/HEVC 双分辨率文件，验证顺序帧、来回定位和缓存序列化；浏览器夹具验证实际播放跨过切换点及 UI 尺寸。尺寸由 session 在显示帧时更新，不由后台预读提前改变。不支持中途更换视频编码种类；配置切换缺少关键帧仍明确报错。


HEVC 竖屏：从 hvcC 的 SPS 数组读取编码尺寸、按色度采样单位计算的 conformance window 和 VUI SAR；配置 WebCodecs codedWidth/codedHeight 与 displayAspect，切换配置时同步更新。coded 与 SPS 不一致、visible 缺失/更小/错位、宽高互换时拒绝原生首帧并走软件回退，不能仅交换画布宽高；浏览器 visible 完全包含 SPS 可见区时只做 VideoFrame 元数据收窄（同一底层资源，无像素拷贝）并记 `hevc-visible-rect-repaired` 后继续 WebCodecs，像素区域一致时才可通过 VideoFrame 显示元数据修正比例。SPS 读取有边界/数量限制，多个不同尺寸 SPS 不猜测当前生效者。`test/hevc-geometry.test.ts` 包括 736→720 的 4:2:0 裁剪、720×1272→1270 收窄修复/拒绝分支与真实竖屏/非方形 SAR。

首帧与关闭重开：原生片源保留一份首帧引用，frameAt(0) 返回独立 clone，dispose 释放缓存及活跃 sink 迭代器。添加片源不会重复解码已经在会话时间 0 的其他轨道。浏览器回归使用带预滚的 H.264 / HEVC MP4，重复定位 0 不重新 configure 解码器，双轨打开/播放/关闭循环后检查所有主线程 VideoDecoder 都已关闭，并验证竖屏上屏与采样尺寸。

软件解码预滚：逐个探测负时间前缀，仅将返回时间不匹配的不可输出包移出显示索引，原始包仍留在 core 中用于解码参考。最多探测 128 个，非负时间包及其他错误不跳过。`test/preroll.test.ts` 使用真实 HEVC open-GOP 裁切文件验证首次及重复定位；浏览器回归同时覆盖原生与可用的软件回退路径。

HDR 上屏一致性：自有色彩模式接收满足契约的高位深 PQ/HLG 平面；浏览器原生 HDR 在浮点桥接与扩展画布能力满足时输出 HDR，其余环境走 SDR 兼容预览。首帧、播放、定位应使用同一路径，截图与缩略图保持 SDR。以实际资源 transfer 为准，不用容器标签覆盖已转换资源。具体准入、降级原因与真实屏幕测试入口见 [HDR 支持](hdr-support.md)及 [色彩链路契约](color-pipeline.md)；普通呈现回归不认证物理 HDR 显示。

`check-presentation-browser.mjs` 使用相同 PQ/HLG 像素的真实 VideoFrame 和 VideoSample，验证 clone/toVideoFrame 元数据、展示层创建前后、连续帧、回到首帧的像素完全一致，并检查随后 SDR 恢复直接上传；保留旋转、像素提取、无 WebGL 回退和资源释放检查。

WASM 堆增长：通过 Emscripten 公开的 instantiateWasm 回调取得 core 的实际 WebAssembly.Memory。每次外部包/配置写入及 RGBA 读取，按 memory.buffer 重建过期视图，再执行范围检查；不信任 pthread 扩容后可能滞后的 Module.HEAPU8，不修改生成胶水、不移除越界检查。测试覆盖非共享内存增长后旧视图脱离、另一 worker 扩容共享内存后旧视图仍有效但过短，以及真实 720×1280 HEVC 多线程 core 首帧、连续播放、回退定位。core 版本和构建锁不变。

后台索引时长：子轨道 dock 的刷新签名纳入 durationUs/indexState。FLV 启动浏览器回归在阻塞尾部时记录临时时长，解除阻塞后验证子轨道时长文字和标尺更新到完整索引时长，不靠切换轨道/修改标记触发刷新。


### 码流分析与按需面板

原生 Mediabunny 分析通过独立 metadata Worker 持有包表、排序缓存和统计，主线程每批最多发送 2,000 条 PTS/大小/关键包元数据，并等待追加确认。查询取消立即结束调用方等待、移除排队请求，并在执行中的下一批计算前中断排序或统计。排序以最多 512 项的小段排序和每 4096 项让出检查点的稳定归并进行；桶与曲线生成共用同步后端的生成器口径，每个 Worker 回合约 4ms 后让出事件循环。取消不会发布部分结果或半成品索引，释放片源会终止 Worker。解码帧与播放缓冲不跨此通道。分析面板按首次展开加载，纯绘图模型与偏好迁移分别位于 `src/ui/analysis/model.ts` 和 `preferences.ts`；关闭/销毁期间完成的 import 不会重新打开面板，工作区快照仍保存尚未加载面板的状态。

`src/ui/analysis/queries.ts` 独立持有每轨查询、覆盖缓存、100ms 手势节流和取消生命周期，所有请求仍调用 `session.queryAnalysis`。覆盖记录使用请求发出时的窗口与偏移；换片、实例重建、关闭或销毁时取消并作废在途请求，即使后端忽略取消也不会发布旧结果或旧错误。`test/unit/analysis-view-cache.test.ts` 覆盖这些竞态、节流尾查、构建中索引不可建立覆盖，以及放大时样本邻域和曲线网格的独立密度。

帧号状态按片源与实例保留已知总帧数所需的宽度；逐帧查询期间保留上一条确认的数字与按钮节点，新结果返回后原位更新，避免省略号、禁用态与悬停动效反复闪烁。换片、实例重建或移除轨道会作废旧排名，首次查询仍显示占位。分析浏览器回归会寻找工具条的一行/两行临界宽度，在真实双轨播放中观察查询等待和结果，断言数字持续可见、按钮不重建、帧号宽度与表头高度稳定；暂停后再用完整包表验证最终帧号，并继续验证点击编辑的尺寸契约。

时间轴选中颜色回归通过 Web Animations API 等待当前 CSS 过渡完成，再分别核对选中与悬停状态的 `--track-active` 最终颜色；两个动画帧仅用于布局稳定，不代表 240ms 颜色动画已经结束。恢复历史分页使用独立的 `.checkpoint-history-pages`，不复用服务器工作区分页控件的行为选择器。

本机检查点每用户最多 100 份、JSON UTF-8 估算大小合计 64 MiB。v2 迁移保留旧记录并建立轻量摘要索引；分页和用量查询不复制所有工作区文档。新增或更新超出预算时整个事务回滚，已有超限历史只允许不增大用量的更新；不自动删除用户工作。跨窗口并发保存、两类容量上限、旧库迁移、失败后记录保留与删除后恢复保存均有回归覆盖。

服务器工作区恢复必须完成记录绑定后才允许再次分享；会话画面结束 busy 并不代表工作区装配已经结束。分享浏览器用例延迟标注空间响应，验证这段间隙中 UI 和公开分享入口都拒绝操作，随后仍复用原工作区地址。

## 帧契约与 FATE 门禁

先同步 core、普通样片和 FATE 样本，再运行 `npm test` / `npm run build`。
`test/avc-geometry.test.ts` 和 `test/media-state.test.ts` 使用固定 FATE 样本。

```
node scripts/sync-fate-samples.mjs
npm run test:fate
npm run test:fate:browser
```

参考 `scripts/fate-reference.json` 固定逐帧 PTS、尺寸和 SDR RGB 分区指纹；
普通检查不调用本机 ffprobe 改写预期。`update-fate-reference.mjs` 仅用于人工
维护参考结果，记录生成工具版本，变更必须审阅。分区最大差 8 / 平均差 3
允许浏览器 YUV 转换舍入，不代表 HDR 色准或逐像素 bit-exact 验收。

`fate-expectations.json` 按片源和后端区分成功与预期拒绝；新失败令检查返回非零。
组合数量以当前参考和预期文件及执行报告为准，不能沿用历史验收计数。适用组合及浏览器本地/HTTP 重开必须通过；明确的 container 能力拒绝按预期校验，不作为已知失败豁免。CI 将此步骤作为阻塞门禁；
独立性能报告保持非阻塞。报告仍写入 `.run/playback-reports/`。

### 静音轨道信息

`node scripts/check-track-metadata-browser.mjs chromium`（登记在 `ci-audio`）用真实 MP4、FLV、TS、Matroska/WebM 比较信息面板关闭/打开时的 HTTP Range 与本地 Blob offset/length 序列；视频执行相同完整遍历、往返 seek，音频保持静音。包含确认无音频、未支持编码、多声道、重复开关、中文/英文切换和实际面板截图；不得用媒体读取重试补全元数据。源逻辑测试另覆盖缺缓存、查询预算、取消和过期回包。

轨道信息是缓存证据，不是完整 ffprobe：仅检查已读的 FLV header/tag、MP4 moov、EBML Tracks 和 TS PAT/PMT（以及已有 AAC 配置）。每次查询最多 4 MiB、256 个不超过 64 KiB 的缓存 peek，2 秒软截止；顶层遍历和轨道数另有上限。TS 限制为启动 64 KiB 内完整且 CRC 有效的单节 PAT/PMT，未知私有流不推断为无音频。EBML 不扫描 Cluster；超预算、缓存空洞、复杂或缺失元数据保留“尚未确认”。只在信息面板请求时查询，最多每秒一次；正常视频读取带来新证据后可更新，关闭/换片/释放会取消旧查询。不会创建 AudioContext/AudioDecoder、额外元数据 worker 或修改服务端索引及 WASM ABI。

## 历史证据的读取边界

2026-09-07 的 [FATE 审计原文](https://github.com/Nakiha/VoidPlayer-Web/blob/1d94ddb81be4800d60a852b4c210a494bfedead4/docs/fate-audit.md)描述的是修复前状态，其后续任务列表与探索性非阻塞配置已被当前帧契约及门禁替代。FATE 包含故意损坏的输入，不应将全部文件必须可播放当作目标；首帧、帧数或时间推进也不能替代逐帧尺寸、PTS、像素和定位验证。

历史帧契约验收见 [frame-contract-acceptance.json](frame-contract-acceptance.json)，其中包含未达门槛的性能结果。界面重做基准保留在 [2026-09-06 原始报告](../.design/2026-09-06/)，均不代表当前版本验收。

2026-09-12 本机编码矩阵的原始产物位于 `artifacts/local-codecs-2026-09-12/`（`report.json`、`chromium-4k-recheck.json`、`exact-recheck/report.json`）；这些产物未提交，当前 checkout 无法直接复核。历史记录中的载入/定位通过不等于首次播放全部通过，后续 4K 软件复测也不能抹去首次失败或推广为稳定性能保证。需要重新取证时使用 `scripts/check-local-codec-matrix.mjs`，按其 `CODEC_FILES`、`CODEC_BROWSER`、`CODEC_MODE` 和 `CODEC_REPEATS` 配置明确输入与环境。

配对 HTTPS 对照在隔离目录构建固定 PR base，并把 feature 的三个公共测试脚本同步到 baseline；两边的应用代码保持各自版本。执行前仍强制检查脚本、媒体及 WASM 的字节一致，报告保存实际 harness SHA-256，采用 baseline-feature-feature-baseline 次序。`perf-https-pair` 在自己的套件中为 required：启动或测量失败使套件 `passed=false`。CI job 保留性能测量的 informational 定位，但显式输出失败与原始证据，不能用绿色外层 job 推断无回归。

### 有限 fMP4 分区

`node scripts/make-analysis-fmp4-fixtures.ts` 生成三 codec 的 byte-identical fragment remux 与真实视频复制/AAC traf 片源。`test/bitstream-analysis-fmp4.test.ts` 覆盖 payload/config、独立 codec/VTM 答案、真实播放 AU、跨非关键片 range、whole drain、取消、实际 Blob IO、媒体库缓存重启/补缺与 edit-list/raw ticks。`test/mp4-fragments.test.ts` 校验 addressing/defaults、64 位时间、合法 CTO 及越界/截断/时间断裂等拒绝边界。

`ci-analysis-matrix-fmp4` 在 WebKit/Chromium 各自独立 job 执行 12 个组合，保留既有每操作上限和 600 秒 case watchdog；加严跨片 seek 后的实际 presented token/遮罩精确匹配，并明确断言 VVC 的实际软件路径。原普通 MP4 与两 FLV 分区继续独立运行。


## Canonical execution and compatibility paths

The manifest's `implementation` (or `script` when no forwarding alias exists) is the canonical executable. `command` invokes it exactly once; the validator rejects executing a forwarding alias or duplicating the entry. The existing `script` path is retained only as a documented compatibility alias and remains a thin import/export forwarding to that implementation. CLI arguments, engines, inputs, preparation, budgets, gate flags and reports remain unchanged. Direct legacy paths are deprecated for new automation; use stable case IDs through `scripts/run-tests.mjs`.

The fixed-baseline comparison in `docs/evidence/test-entry-migration.json` records all migrated owners. The coverage contract preserves the original catalog and argument lists, allowing only the alias-to-implementation path substitution. This stage retains compatibility files while npm aliases are migrated separately; it does not claim the remaining npm preparation/list duplication is already resolved.

### 媒体与 Worker 的翻译依赖边界

`node-i18n-build` 使用 `scripts/testing/i18n-architecture.mjs` 检查 media、presenter、FFmpeg/packet Worker 与实际 `src/thumbnails/pixel-worker.ts` 根入口。必检根入口或递归依赖缺失必须报出路径并失败。扫描相对运行时 import、re-export 和字符串字面量 dynamic import；type-only import/export 与包依赖不递归。Worker URL 单独列为根入口，计算式 import、require 和未列出的 Worker URL 不属于这个扫描器的覆盖范围。临时工程负例验证缺失入口、缩略图直接/间接引入翻译依赖均被拒绝；现有 progress callback 限制保持。

### 服务端索引数据库 RPC

`server/frame-index-protocol.ts` 绑定六个数据库操作的字段与结果，`FrameIndexJobs.call` 从操作名推导返回值，Worker 使用 `frameIndexReply` 检查响应。HTTP JSON 和磁盘索引的既有运行时校验仍在入口执行；数据库 Worker 消息布局、transfer、超时、并发与关闭策略保持。`test/helpers/frame-index-protocol-types.ts` 的负例随 build 和 `node-frame-index-worker` 编译，拒绝未知操作、缺失/错误字段及请求/响应错配；这些测试不在媒体逐帧路径增加校验或复制。

### 可丢弃像素缩略图 Worker

`src/thumbnails/tasks.ts` 每个像素候选拥有一个一次性 browser Worker。正常结果、`error`、`messageerror`、`postMessage` 抛错或候选到期均走单次结束：解除三个事件属性与到期回调，终止该 Worker，随后仅释放候选自己的帧和预算、清除 in-flight。失败不会标记 completed，也不触碰播放原帧或下一任务；已捕获的迟到回调不能再次提交或清理。既有 hold deadline、队列上限和复制/transfer 路径保持。

`node-thumbnail-offer` 从实际 offer/task 入口验证这些分支、成功回包、到期计时器清理与恢复任务。受控 browser-like Worker 使用真实 `structuredClone` transfer，验证播放像素数组仍完整；测试主动派发 `messageerror`，并不声称复现浏览器底层损坏消息。浏览器缩略图套件继续验证实际编码、存储与显示；此一次性客户端不增加 Node Worker 适配层。

### npm compatibility and retired forwarding paths

Every `test`/`test:*` npm command now delegates to the catalog runner. The 48 migrated legacy commands are declared by stable case IDs in `manifest.json` `npmCommands`; engine alternatives share the canonical owner, and literal legacy arguments (including package paths and required hardware flags) remain argument arrays, never shell commands. The two chained HDR commands stop after an earlier stage fails. Manual/diagnostic execution remains explicit and its failing exit is blocking when directly invoked through npm; these customized aliases cannot count toward CI matrix coverage. Use `node scripts/run-tests.mjs --list --alias <name>` to inspect the exact plan.

Unreferenced thin forwarding paths listed in `docs/evidence/retired-test-entrypoints.json` are retired: use their npm alias or `node scripts/run-tests.mjs --case <id>`. Their case IDs and canonical implementations remain, and `retiredAlias` is accepted only with the checked-in matching retirement record and an absent forwarding file. Documented/imported/workflow-used forwarding entries remain compatible. A legacy top-level test glob is not the complete unit suite; `npm test` discovers every canonical unit case, including retired aliases, exactly once.

Release aliases keep the browser default-archive `-` token. Explicit archives bypass only the latest-release fixture; default archive selection still requires that metadata. HEVC alias `--engine` selects only that engine's local/remote cases and conflicts or unsupported engines fail before execution.

## 模块边界与目录维护

`node-module-boundaries` 随 fast、contract、source 执行，构建也运行同一边界扫描。检查覆盖生产目录中的静态与类型导入、重新导出、字面量动态加载和 Worker URL；不存在的相对依赖会直接失败。前后端不能互相引用，共享层不能引用任何宿主，外部包仅准入 Mediabunny。计算式加载仅保留登记的资源加载入口；新增入口需明确其职责。负例覆盖间接越界、类型引用、Worker 缺失、计算式加载和未归属的顶层模块。

共享层另以 `tsconfig.shared.json` 在无 DOM 类型环境编译，真实编译负例证明 window、document、IndexedDB、VideoFrame 不可进入共享代码。标准 Fetch/Blob、AbortSignal 与 WebAssembly 可由两种宿主使用。共享源码及其类型配置参与准备构建指纹、前端来源摘要和发布源码包，移动公共实现后不能复用过期构建。
