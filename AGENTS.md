# AGENTS.md

VoidPlayer Web：浏览器内的视频评审工具。WebCodecs 优先、自建裁剪版 FFmpeg WASM 解码后端
（FFV1 / MPEG-2 / H.266 / 浏览器不支持的 profile 组合；与 JS 容器层正交）。

## 结构

- `src/main.ts` 页面入口；`src/session.ts` 是 UI 与页面 Agent 共用的浏览器会话 facade；`src/session/` 保存播放、色彩、元数据分析与深度码流任务的会话协调。无宿主依赖的标注构造、编辑和持久命令规则在 `shared/review/`；HTTP 与浏览器适配器调用同一套规则。
- `shared/`：无宿主依赖的公共实现。`media/{containers,codecs,indexing,io}/` 保存容器解析、压缩包身份、索引与字节读取；`analysis/metadata/` 保存包统计、滑窗、排序与查询；`analysis/bitstream/` 保存深度码流契约、NALU/GOP、执行器与缓存；`review/`、`presentation/viewport.ts`、`color/`、`thumbnails/`、`service/` 保存相应纯逻辑和数据契约。
- `src/media/`：`source.ts` 为 WebCodecs 入口；`decoding/` 保存 FFmpeg/packet/FLV/JS 容器后端及 Worker，`indexing/` 保存浏览器索引客户端与 IndexedDB 适配，`audio/` 只观察已有缓存，`policy/` 保存解码选择，`io/` 保存同步 Range 桥接，`workers/` 保存 RPC 与协议。
- `src/presentation/presenter.ts` 唯一决定帧如何上屏；同目录保存 WebGPU/WebGL、HDR 与 YUV 呈现。`shared/presentation/viewport.ts` 保存纯几何与状态，DOM 接线在 `src/ui/view-bindings.ts` 和 `src/ui/viewport-gestures.ts`。
- `src/analysis/{metadata,bitstream}/` 保存浏览器分析适配、Worker 与服务；`src/ui/analysis/` 保存面板与图表，`chart-overlay.ts` 为图表覆盖层，`picture-overlay/` 为源画面宏块/QP 覆盖层；`src/session/{metadata-analysis,bitstream-analysis}.ts` 协调会话行为。
- `src/review/` 保存评审与工作区浏览器客户端；`src/services/` 保存媒体库、连接、身份和文件客户端；`src/logging/` 保存本地诊断；面板与交互位于 `src/ui/`，管理页面位于 `src/admin/`。
- `server/`：Node 服务，`runtime.ts` / `app.ts` 负责入口装配，`quality-application.ts` 显式创建、恢复与关闭评分应用；媒体库不通过属性读取创建评分服务；路由在 `routes/`，深度分析服务在 `analysis/bitstream/`，配置与运行入口在 `config.ts` / `runtime.ts`。共享代码统一从 `shared/` 引入，禁止服务端与浏览器层互相引用（包括类型）。
- `shared/analysis/quality/` 保存无宿主评分与对应计划契约，`server/analysis/{quality,vmaf,xpsnr,cambi}/` 保存文件/Worker/持久任务适配，`src/analysis/quality/`、`src/admin/quality*.ts` 保存客户端与观察。支持域和迁移规则见下表，不按类名推断执行后端。
- `scripts/dev.ts` 同进程启动 Vite 和媒体 API；`scripts/service.mjs` 管理 macOS 用户服务；`deploy/` 为便携运行与自动用户使用说明。
- `test/{unit,contract,media}/`：node:test，无浏览器依赖；`helpers/` 为可复用模块，顶层旧文件为兼容入口。WASM 用例在 Node worker_threads 里跑真实 core。
- `scripts/testing/`：统一清单、构建、生命周期与报告接入；`browser/{ui,annotations,media,workspace}/` 保存领域浏览器用例，顶层 `check-*-browser.mjs` 保留兼容入口。
- `scripts/tools/{development,fixtures,diagnostics,perf,release}/`：已归类工具实现，旧入口保留兼容；专用工具与职责索引见 `scripts/README.md`。
- `scripts/`：`sync-wasm-core.sh`（从 VoidPlayer-FFmpeg-Build 产物同步 core，可用
  `WASM_CORE_DIR` 覆盖）、`sync-samples.sh`（样片进 `fixtures/video/`，可用
  `VOIDPLAYER_SAMPLES` 覆盖）、`bench-playback.mjs`（Playwright 离屏播放基准）。
- `public/vendor/voidplayer-core/`：gitignored 的 core 产物，由 sync 脚本填充。

## 硬约束

- 浏览器、服务端与共享层禁止反向引用，包括类型。GUI 与页面 Agent 经 `session.ts` 操作浏览器会话；持久命令共用 `shared/` 规则与服务端适配，不依赖已加载轨道、暂停/播放或 GUI 确认。GUI 只观察后台变化，不自动 seek、打开媒体或抢焦点。
- `QualityApplication` 显式装配、恢复与关闭评分服务；getter 不创建资源。`QualityAdmission` 唯一管理实例/算法/内存/读取/线程预留；父协调器不得外层获取共享许可。取消、关闭、deadline 和结果回收都要等真实 Worker/IO 退出；停止不确定时保留许可及相关存储所有权。降限不强杀既有工作。
- 产品只有播放 core 与分析 core。后台解码使用播放产物的独立 Worker；VMAF/CAMBI/XPSNR 使用既有分析 core 像素 API，不经 avfilter/framesync、评分 CLI 或原始 YUV 临时文件，不引入仅 Linux 可用的生产组件。WASM 构建/裁剪属于 `VoidPlayer-FFmpeg-Build` 的 `wasm` 分支，本仓只消费固定产物与 release lock。
- 宿主拥有原始有理数源时钟、AU/token、选择顺序、ROI 和完整排空，评分器只接收像素与明确序号。不得按取整微秒/nearest/来源标签猜帧，或拼接稀疏抽样冒充连续时序。参考关系不认证内容；引用完整性未认证、concealment 检测不可用。元数据就绪不代表评分准入，读取/评分/viewer 不隐式建索引。
- 源/容器/几何/色彩/时序能力必须遵守对应专项契约，不从另一指标继承准入。MP4 保留真实 sample/table/ticks 见证，不伪造 FLV tag 或读费用；普通播放 token 不充当质量缓存身份。旧前向模式与支持重排的 packet identity 模式不能混用。
- 数值核心与持久任务能力分开发现。PSNR/SSIM 保留输入域、有效覆盖与工作预算；SSIM 不混称高斯变种。VMAF/XPSNR 只消费已提交对应计划；XPSNR 保留 reference-first 单片段状态、官方逐平面池化及 Infinity，版本排序不代表感知优劣。
- CAMBI 保留单源准入、五尺度热图、流式暂存及 stop-and-keep 策略；暂存不可发布或冒充已核验快照，普通取消仍丢弃未完成暂存。完整重算重新处理全部输入，失败/取消/重启不能删除独立冻结执行见证。区域统计不是裁剪重算或目标跟踪。
- 提交正文/键先冻结；未知提交只用原 actor/body/key 或原 plan digest/policy 回放。新计算与原提交重放分开；显式重执行必须核验物理停止和冻结条件、确认全量成本、原子创建唯一后继，不复用分数或自动发布/重建索引/换模型。持久任务与回执同事务，旧指纹/附件/候选不改写成新执行身份。
- 区间归档先持久提交意图，再回收未固定子结果；跨库中断保留 pending，仅由原 actor/ID 显式重放结算。保留输入、摘要、coverage、子 attempt/digest、历史证据和冻结发布回执；归档不派生新策略。对应计划执行意图与最终 range ID 预留纳入原配额，下游提交期间不持有外层事务或许可。
- `FrozenSubmissionJournal` 拥有提交不确定性，`QualityObservationScope` 拥有 actor/selection/request 观察。请求票据仅围栏回复发布，已渲染控件使用 actor 票据，操作选中对象时建立 selection 票据；迟到确认不导航旧视图。管理端身份统一用 `observeIdentity` / `confirmedActor`，跨窗通知只触发服务确认，确认期间撤销旧观察，同一 actor 确认后也要恢复，不能各面板再写 storage/health 恢复。
- 日志仅存本地 IndexedDB，上传只由用户在日志面板显式触发。媒体打开按 `MediaOpenError.stage` 决定回退，不新增整体 try/catch 换路径；已取得但未交付的源由打开流程负责清理。
- 帧资源显式 `close()`，解码后端不直接画 canvas，全部经过 presenter。色彩修改同步 `docs/color-pipeline.md`，区分源标签与实际输出，不按片源叠加 HDR/SDR 修正。取像素/缩略图只用 presenter 按需 capture，不依赖每帧更新隐藏 canvas。
- 标注是源帧坐标的矢量对象，可延伸到视频外；`strokeWidth` 为不随缩放的 CSS 像素。网格 < 视频 < 标注 < 半透明 UI，不给标注 SVG 加视频边界裁剪。UI/Agent 共用 `session.updateMark` 和持久标注命令；缩小 LINEAR、放大 NEAREST，不放大 CSS 中间位图。
- HTTP 标注、幂等回执与操作事件同事务；事件消费不阻塞写入，过期游标明确要求快照重同步。任务中心在 SQL 筛选后检查独立快照预算，禁止各取首页伪全量筛选；冻结分页失效须重取，详情关联核对原 actor/receipt/input/attempt/digest；actor 是自述归属，不是认证。
- 本机 stdio 页面桥必须遵守专项授权契约：只用真实映射 peer 判定本机，顶层页面点击授予范围，凭据仅存内存，不把 Origin/epoch/声明名当认证。仅共享白名单与现有 facade，不透传全工具/任意脚本路径、不上传 File/日志、不自动连接。授权失效废弃排队命令，已派发回执未知不假回滚或换键；迟到消息按 document/epoch/correlation 围栏。关闭 stdin 真实释放自有资源，stdout 仅协议帧，modern/legacy 生命周期分别验证。

## 格式与层内边界

- [紧凑格式](docs/code-format.md)：2 空格、LF、单引号、分号，目标约 140 字符；短变量组、数据声明、getter、转发方法及简单 guard 允许单行，副作用和生命周期操作清楚分行。不因触碰文件就整文件重排，格式迁移须明确选择范围并单独审查。`npm run format:check -- --base origin/main` 只查改动行的基础卫生，不强制完整布局；不要用源码空格断言行为。
- [模块边界](docs/module-boundaries.md)：浏览器禁止 Node 内建依赖；media/analysis/session 不反向依赖 UI 或入口，media/analysis 不依赖 session 或具体 presenter；静态运行时依赖禁止循环，纯类型和 Worker URL 单独处理。
- `check:shared` 不带 Node 类型，只允许明确的可移植 Web API；`check:environments` 分别编译浏览器与服务端。Node Worker 测试兼容只由 `test/helpers/browser-worker-*` 提供。新增全局环境能力须明确契约和负例。
- 默认在 `src server shared` 查实现、在 `test scripts` 的代码文件中查回归。大 JSON 样本和 `docs/evidence` 只在需要对应证据时检索。

## 按工作流查阅契约

修改相关模块前先读对应文档；具体支持域、版本和数值上限以负责该行为的契约及共享常量为准，不在本文件复制另一套版本表。

| 工作流 | 实现入口与契约 |
| --- | --- |
| 源平面 PSNR / SSIM | `shared/analysis/quality/{psnr,ssim,frame-pair}.ts`；[PSNR](docs/source-plane-psnr.md)、[单帧桥](docs/source-frame-pair-psnr.md)、[SSIM](docs/source-plane-ssim.md) |
| 前向 / 重排帧身份 | [有界前向](docs/forward-frame-quality.md)、[闭合 GOP token](docs/reordered-frame-quality.md) |
| 媒体库与显式准备 | `server/discovery/`、`shared/media/{discovery,probe}.ts`；[发现](docs/library-discovery.md)、[严格 MP4](docs/trusted-mp4-quality.md)、[暂停原生 FLV](docs/paused-native-quality.md) |
| 单帧任务与观察 | `server/analysis/quality/job-*.ts`、`src/analysis/quality/job-observer.ts`、`src/admin/quality.ts`；[文件适配](docs/source-library-psnr.md)、[持久任务](docs/source-psnr-jobs.md)、[GUI/Agent](docs/psnr-task-workflow.md) |
| 对应计划与区间 | `shared/analysis/quality/{correspondence,ranges}.ts`、服务端同名服务；[参考时钟](docs/reference-clock-plans.md)、[区间/聚合/归档](docs/bounded-quality-ranges.md) |
| 空间候选与证据 | `shared/review/quality-evidence.ts`、`src/ui/quality-roi.ts`；[ROI 候选](docs/quality-roi-candidates.md)、[证据挂接](docs/annotation-psnr-evidence.md)、[只读原帧](docs/annotation-psnr-pair-view.md) |
| WASM 评分 | [架构与支持域](docs/analysis-wasm-scoring.md)、[VMAF](docs/native-vmaf.md)、[CAMBI](docs/native-cambi.md)、[XPSNR](docs/native-xpsnr.md)、[版本比较](docs/xpsnr-comparison.md)；`Native*` 与旧 wire 名为历史兼容，不代表生产原生执行器 |
| 所有权与持久生命周期 | `temporal-service.ts` / `quality-temporal.ts` 统一 VMAF/XPSNR 生命周期，CAMBI 保留单源策略；[所有权](docs/quality-ownership.md)、[显式重执行及存储迁移](docs/explicit-quality-reexecution.md) |
| 任务与资源 | `server/tasks/`、`shared/service/tasks.ts`、`server/quality-admission.ts`；[任务中心](docs/unified-task-center.md)、[资源管理](docs/quality-resources.md)；查询快照与历史字节保留分别拥有预算 |
| HTTP Agent / 页面桥 | [HTTP 入口](docs/agent-http.md)、[渐进评分工作流](docs/agent-quality-workflow.md)、[本机 stdio 桥](docs/local-mcp-page-bridge.md) |
| 当前支持与历史证据 | [文档导航](docs/README.md)、[阶段实测与失败](docs/quality-convergence.md)；roadmap 当前状态以 #112 为汇总，历史失败不改写 |

## 验证

云端 CI 不设置性能门禁；性能仅在本机同条件下实测，不据功能绿色宣称跨机器性能达标。

```sh
npm run check:boundaries # 宿主依赖、模块归属与 Worker 入口
npm run check:shared     # 可移植 Web API、无 Node 类型的共享层编译
npm run check:environments # 浏览器与服务端分别编译
npm run format:check     # 改动行的 LF、缩进 Tab 和尾随空白（只读）
npm run test:fast        # 无媒体/core/浏览器依赖的快速逻辑与基础设施契约
npm run test:contract    # 清单、生命周期、发布与执行报告契约
npm run test:browser:all # 完整自动化浏览器套件（单次构建，独立结果）
npm run test:suite -- browser --list # 统一清单与矩阵枚举
npm test                 # 单元 + Node 内真实 WASM 解码
npm run build            # tsc --noEmit && vite build
npm run fixtures:flv     # 从 QA 样片生成 FLV 回归素材（需要 ffmpeg/ffprobe）
npm run fixtures:hlg     # 从 H.265 样片合成 HLG 回归样片（QA 稀疏检出不含此文件，CI 必跑）
npm run test:hlg:browser # HLG 完整帧、尾帧、seek/逐帧与像素身份（需要 ffprobe）
npm run test:annotations:rendering # DPR 2 双轨连续缩放、最终像素、图层与工具条约束
npm run test:annotations:browser # 标注交互与实际采样像素回归
npm run test:range:browser # MP4/VVC 和 FFmpeg Range、seek、播放基准
npm run test:flv:browser # FLV WebKit 解码、Range、seek 和播放回归
npm run test:saved-workspaces:browser # 双窗口冲突、副本、管理与服务重启还原
npm run test:admin:browser # 管理配置/日志、主动测速取消与亮暗响应式布局
npm run test:library:browser # 目录分页、搜索、离线恢复与版本引用（WebKit）
npm run test:release:browser -- /path/to/package.tar.gz webkit # 只从原生包运行浏览器回归，不重新构建
npm run test:browser     # 兼容入口：仅基础 WebKit UI 回归，非完整浏览器套件
npm run test:presentation:browser # 直接上传、按需源像素、旋转与无 WebGL 回退
npm run test:webgpu:browser -- chrome msedge # 有窗口的 Windows Chrome/Edge 呈现回归
npm run test:color:windows # 默认资源契约、彩色色块、H264/HEVC/10-bit 与独立 FFmpeg 平面对照
npm run repro:color:native # 独立浏览器原生/内存帧及 GPU 导入入口诊断，不代表验收通过
npm run test:connection:browser # HTTP 引导、Windows/macOS 步骤与公开证书下载
node scripts/bench-playback.mjs webkit    # 需要先起 npm run serve
```

改动播放/解码路径后必须跑 bench；改动载入路径后跑测试即可。
源画布按需由 presenter.captureFrame 生成；取像素/缩略图不得依赖隐藏画布在每帧更新。
改动视图尺寸调度、轨道操作或片源 UI 后跑 test:browser；需先同步样片/core 并安装 Playwright WebKit。

本地会产生大量可再生成产物（`.run/` 的历史验收证据与测试素材、`artifacts/` 的历史打包产物）。
用 `npm run clean` 先看各分类体积（默认 dry-run），`npm run clean -- --apply` 才删除；
`--keep-days=N` 控制保留窗口（默认 14 天），`--only=media,logs` 限定分类。
脚本只删「位于仓库内 + 被 git 忽略 + 不在保护清单」的路径，`.run/data`（服务端 SQLite）、
`.run/identity-private`、`logs/`、`artifacts/latest-release.json` 与文档引用的取证报告永不删除。未知 `.run` 目录不属于清理集合；验收输出按统一清单声明，配置数据目录、历史数据库与 `.voidplayer-user-data` 标记另行保护。

套件注册与 CI 选例共用 `scripts/testing/manifest.json`，执行入口为 `scripts/run-tests.mjs`；新增测试必须登记。完整说明见 `docs/testing.md`。旧 npm 命令和脚本路径保留兼容。

## 独立发布

- 日常 PR/main 检查走 `.github/workflows/checks.yml`；正式打包由手动或版本标签触发 `.github/workflows/release-preview.yml`：固定解码器源码/工具链后准备共享 core，再在 Linux x64、Windows x64、macOS ARM64 原生 runner 打包和测试。
- `scripts/release-core.json` 固定上游修订，更新前先推送解码器源码；不要引用本地未提交改动或浮动版本。
- `scripts/package-release.mjs` 生成独立程序、资源、来源清单与校验和；`npm run test:release` 校验解压产物，无需真实片源。手动全量验证的分支运行上传预览 artifact；版本标签需匹配包版本和发布说明，经三平台汇总校验后生成 Release 草稿，不自动公开发布。`node --test test/release-pipeline.test.mjs` 验证版本、产物汇总和草稿重跑边界。
