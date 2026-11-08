# AGENTS.md

VoidPlayer Web 用于在浏览器中同步播放多路视频，逐帧对比不同编码或处理结果，并在具体帧上标注问题。

## 开发入口

- 使用 Node.js 24+ 和 `npm ci`。按[开发说明](README.md)准备本机配置与媒体目录。`npm run dev` 启动 Vite 和媒体 API；`npm run serve` 提供已发布的完整版前端。
- 播放和分析是两个独立 core。用 `bash scripts/sync-wasm-core.sh` 和 `bash scripts/sync-analysis-core.sh` 同步上游产物，来源目录可分别用 `WASM_CORE_DIR` 和 `ANALYSIS_CORE_DIR` 指定。产物位于被 Git 忽略的 `public/vendor/voidplayer-core/` 和 `public/vendor/voidplayer-analysis/`。WASM 构建与裁剪在上游仓库进行。
- Sites 使用 `npm run dev:sites` 或 `npm run build:sites`。能力由 `src/services/build-profile.ts` 在构建时确定；勿按请求失败或 URL 参数切换模式。Sites 不调用媒体 API，不装配服务器身份、媒体库、分享、日志上传、stdio 页面桥或 PWA。须支持无跨源隔离的本地单线程路径。详见 [Sites 分发](deploy/sites.md)。
- 默认在 `src/`、`server/`、`shared/` 查实现，在 `test/`、`scripts/` 的代码文件中查回归。按需查大 JSON 样本和 `docs/evidence/`。从[文档导航](docs/README.md)找契约；历史报告仅代表对应修订与环境。

## 容器与解码

- 本地文件和媒体库 URL 共用容器选择策略。JS 解封装后，WebCodecs 与 FFmpeg WASM 解码器使用同一套压缩包、时间戳和索引。切换解码器不改变解封装器。
- JS 路径拒绝流布局、缺少必需的媒体库索引或读取失败时，保留原失败原因，不转交已裁掉的 FFmpeg 解封装器重试。扩展支持前，分别核对容器准入条件和解码能力，见 [JS 容器契约](docs/js-container-migration.md)。

## 改动前按职责查阅

| 工作流 | 实现入口 | 契约 |
| --- | --- | --- |
| 页面与会话 | 播放器由 `src/bootstrap.ts` 载入 `src/main.ts`；UI 与页面 Agent 共用 `src/session.ts`，会话协调在 `src/session/`；管理页入口为 `src/admin/main.ts` | [模块边界](docs/module-boundaries.md)、[失败隔离](docs/failure-isolation.md) |
| 打开、解码、索引与音频 | `src/media/contract.ts` 定义帧与源，`src/media/source.ts` 路由打开；容器与索引公共实现在 `shared/media/`，浏览器适配在 `src/media/`。`server/frame-index-build-worker.ts` 按索引类型分派服务端构建任务 | [JS 容器](docs/js-container-migration.md)、[统一索引](docs/unified-indexing.md)、[顺带音频](docs/opportunistic-audio.md) |
| 呈现、视口与缩略图 | `src/presentation/presenter.ts` 决定上屏；`shared/presentation/viewport.ts` 管几何，`src/ui/viewport-gestures.ts` 接手势，`src/thumbnails/` 管浏览器缩略图 | [色彩与帧资源](docs/color-pipeline.md)、[HDR](docs/hdr-support.md) |
| 元数据与深度码流分析 | `shared/analysis/` 管包统计与码流计算；`src/analysis/`、`server/analysis/bitstream/` 拥有各自宿主资源；`src/ui/analysis/` 管面板、图表与画面覆盖层 | [码流分析](docs/bitstream-analysis.md)、[执行边界](docs/analysis-execution.md)、[会话所有权](docs/session-bitstream-ownership.md)、[本地 Worker 生命周期](docs/local-analysis-worker-lifecycle.md) |
| 标注、工作区与身份 | `shared/review/` 管标注规则和工作区格式；`src/review/` 接浏览器持久化与分享；`server/annotations.ts`、`server/workspaces.ts` 接服务端存储 | [工作区格式](docs/workspace-format.md)、[身份与分享](docs/identity-and-sharing.md) |
| 媒体库、文件与索引查询 | `server/library.ts` 管媒体库；`server/routes/` 管 HTTP 路由；`src/services/` 和 `src/ui/library-browser.ts` 接浏览器 | [文件管理](docs/library-file-management.md)、[媒体库索引](docs/media-library-evolution.md)、[只读媒体查询](docs/media-query.md) |
| HTTP Agent 与本机页面桥 | 服务端路由与 `shared/service/` 共用协议；`server/bridge/` 与 `src/agent/page-bridge.ts` 连接获授权的页面会话 | [HTTP 接口](docs/agent-http.md)、[本机 stdio 桥](docs/local-mcp-page-bridge.md) |
| 界面、文案与诊断 | `src/ui/`、`src/admin/`、`src/themes/` 管界面；`locales/` 管消息；浏览器与服务端日志分别在 `src/logging/`、`server/logging/` | [主题约定](src/themes/README.md)、[本地化](docs/localization.md)、[服务端日志](docs/server-logging.md) |

## 实现约束

- **宿主与依赖。** 浏览器和服务端都可引用 `shared/`，彼此禁止引用，包括类型。共享层仅使用准入的可移植 API；浏览器禁止 Node 内建依赖。media、analysis、session 不反向依赖 UI 或应用入口，media、analysis 也不依赖 session 或具体 presenter。静态运行时依赖不得成环；纯类型和 Worker URL 分别检查。Node Worker 测试适配只放在 `test/helpers/`；新增全局能力须有契约和负例。
- **打开与释放。** 依据 `MediaOpenError.stage` 决定回退，禁止用整体 try/catch 重试另一条路径。已取得但未交付的源由打开流程清理。取消或关闭须等待真实 Worker/IO 退出；停止状态不确定时保留存储所有权。媒体库须登记全部索引数据库读取者，最后一个退出后才释放数据库。后台深度分析使用独立 Worker，不改变播放状态。
- **呈现与色彩。** 解码后端只交付帧，消费者显式 `close()`。视频只经 presenter 用 WebGPU 上屏；GPU 不可用时明确报告呈现失败。2D 色彩中转不得充当显示后端。缩小用 LINEAR、放大用 NEAREST，不放大 CSS 中间位图。修改色彩行为须同步[色彩契约](docs/color-pipeline.md)，区分源标签与实际输出，不按片源叠加 HDR/SDR 修正。
- **取像素与缩略图。** 对当前画面取像素或生成标注预览时，按需调用 `presenter.captureFrame`。媒体库封面从独立持有的首帧生成 RGB 小图，不随播放通道变化。两条路径都不逐帧刷新隐藏画布。
- **标注与工作区。** 矢量几何使用源帧坐标，可延伸到视频外；`strokeWidth` 是不随缩放的 CSS 像素。保持网格、视频、标注、半透明 UI 的从底到顶顺序，勿给标注 SVG 加视频边界裁剪。UI 与页面 Agent 共用 `session.updateMark`。工作区格式要兼容旧文件；布局保存片源栏导航与搜索状态，文件不嵌入视频。片源不可用时保留已有标注。
- **持久命令与事件。** HTTP 与浏览器适配器复用 `shared/review/` 规则。持久命令不依赖页面、已载入轨道、暂停状态或 GUI 确认。标注写入、幂等回执与操作事件同事务；事件消费不阻塞写入，过期游标须明确要求快照重同步。GUI 观察后台变更，不自动 seek、打开媒体或抢焦点。
- **身份与日志。** actor 仅表示自述归属。管理端以 `observeIdentity` / `confirmedActor` 为准；跨窗通知触发服务确认，期间撤销旧观察，同一 actor 确认后也要恢复。迟到回复不得导航旧视图。浏览器诊断存本地 IndexedDB，只由用户在日志面板主动上传。服务端运行日志与上传报告各自遵守配额和保留规则。
- **stdio 桥。** 临时宿主页与已有页面配对均以真实映射 peer 判定本机；顶层页面须由用户点击授予范围，凭据仅存内存。Origin、epoch、配对码和客户声明名均不能代替授权。仅开放共享白名单与会话 facade，不透传任意脚本、路径或全部工具，不上传 File 或日志，不自动连接。撤销后废弃排队命令；已派发且回执未知时不假定回滚，不换键重试。以 document、epoch、correlation 排除迟到消息。stdin 关闭要实际释放自有资源，stdout 仅输出协议帧；分别验证 modern/legacy 生命周期。

## 界面与代码格式

- 沿用主题色与背景层次。未经用户明确要求，不新增边框，也不用 inset shadow 模拟实线边框。
- UI 文案使用稳定消息 ID 和中文默认文案；新增受管模块须在 `locales/scope.json` 分类。变更消息后运行 `npm run i18n:extract`、审阅英文翻译，再运行 `npm run i18n:compile` 和 `npm run i18n:check`。协议值、持久键、用户内容和原始诊断保留原值。
- 按[紧凑格式](docs/code-format.md)使用 2 空格、LF、单引号和分号，行长目标约 140 字符。短声明和简单 guard 可单行；副作用与生命周期操作清楚分行。只调整相关代码，格式迁移单独审查。`npm run format:check -- --base origin/main` 检查改动行的基础卫生；测试不得用源码空格断言行为。

## 按改动选择验证

统一入口是 `scripts/run-tests.mjs`。[测试清单](scripts/testing/manifest.json)登记 case、矩阵、素材与工具，[验证说明](docs/testing.md)列出准备步骤和 CI 范围。用 `npm run test:suite -- browser --list` 查可运行项，再以 `--case <id>` 选择。Node 用例在 `test/{unit,contract,media}/`，浏览器用例在 `scripts/testing/browser/`；从清单找实际实现，避免重复执行旧入口。

| 改动范围 | 验证 |
| --- | --- |
| 基础逻辑、宿主边界、构建 | `npm run test:fast` 无需媒体、core 或浏览器；测试基础设施用 `npm run test:contract`。`npm run build` 包含本地化、模块边界、共享层、浏览器与服务端类型检查，再生成完整版前端。 |
| 媒体打开、播放、解码 | 载入改动运行对应媒体回归；完整 Node 套件 `npm test` 含真实媒体与 WASM。播放或解码路径改动还必须跑播放基准：在提供本次构建的服务上运行 `node scripts/bench-playback.mjs webkit`，默认有窗口，可加 `--headless`。性能只在本机同条件比较，云端 CI 不设性能门禁。 |
| 视图尺寸、轨道操作、片源 UI | 准备样片、core 与 Playwright WebKit，运行 `npm run test:browser`（默认基础 WebKit UI）。呈现改动运行 `npm run test:presentation:browser`；完整自动化浏览器套件用 `npm run test:browser:all`。 |
| 标注、媒体库、工作区 | 按职责选 `npm run test:annotations:rendering`、`npm run test:annotations:browser`、`npm run test:library:browser`、`npm run test:saved-workspaces:browser`。UI 控件变更时同步维护对应浏览器操作与断言。 |
| Sites 或两种分发共用的本地流程 | `npm run test:sites:browser`（WebKit）、`npm run test:sites:browser -- chromium`。用纯静态服务验证隔离与无隔离场景以及零媒体 API 请求；托管环境的能力另在实际站点验收。 |

新增测试须登记清单，优先扩充已有职责用例。同一 PR 说明行为缺口、独立预期、测试层级与运行成本，包含新增循环和素材。修 bug 保留修复前失败、修复后通过或等价故障注入证据；迁移用行为映射核对覆盖。成本摘要只作诊断。专项夹具、诊断与基准见[脚本索引](scripts/README.md)。

## 发布与本地数据

- 完整版 `npm run build` 生成候选 `dist/`；更新运行中的服务使用 `npm run publish:frontend -- dist`，按[前端发布说明](deploy/operations.md#只发布前端)选择目标服务的配置。Sites 独立输出到 `artifacts/sites/`，`npm run package:sites` 只生成静态分发包。
- 日常 PR/main 走[常规检查](.github/workflows/checks.yml)。[发布工作流](.github/workflows/release-preview.yml)由手动运行或版本标签触发；播放和分析分别由 `scripts/release-core.json`、`scripts/release-analysis.json` 锁定。更新锁前先推送上游源码，不引用本地未提交改动或浮动版本。
- `scripts/package-release.mjs` 校验两套 core 的来源和哈希后打包；`npm run test:release` 校验解压产物，无需真实片源。正式标签须匹配包版本和发布说明，经 Linux x64、Windows x64、macOS ARM64 原生包与汇总校验后生成未公开的 Release 草稿；手动分支运行产出预览 artifact。
- 清理可再生成产物先运行 `npm run clean` 预览；`npm run clean -- --apply` 才删除。可用 `--keep-days=N`（默认 14 天）和 `--only=media,logs` 缩小范围。仅清理仓库内、Git 忽略且明确归类的产物；保护配置的数据目录、历史数据库、`.voidplayer-user-data`、`.run/data`、`.run/identity-private`、`logs/`、`artifacts/latest-release.json` 和文档引用的取证产物。未知 `.run/` 目录不纳入清理。
