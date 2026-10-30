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
- `server/`：Node 服务，`app.ts` 负责装配；路由在 `routes/`，深度分析服务在 `analysis/bitstream/`，配置与运行入口在 `config.ts` / `runtime.ts`。共享代码统一从 `shared/` 引入，禁止服务端与浏览器层互相引用（包括类型）。
- `shared/analysis/quality/`：无宿主依赖的源平面度量核心。PSNR 的输入域、ROI、色彩前提和工作预算见 `docs/source-plane-psnr.md`；内部单帧桥及受信任的宿主输入边界见 `docs/source-frame-pair-psnr.md`；浏览器适配位于 `src/analysis/quality/`。数值核心与任务能力分别发现；持久任务已提供单帧 PSNR、可选 SSIM/grid 与 GUI/Agent 闭环，不代表序列或全部 #121 完成。
- 普通依赖帧的有界前向测量见 `docs/forward-frame-quality.md`：目标显式携带闭合起点，每侧至多 32 个连续 AU，唯一严格前向 PTS=DTS；每次送包后、下个输入前必须恰好一帧，最终 drain 不得残留。不是按 PTS 搜索输出或宣称 packet opaque ABI，旧前向模式仍拒绝重排/延迟输出；固定 packet identity ABI1 的闭合 GOP 模式见 `docs/reordered-frame-quality.md`，以 opaque 输入 token 绑定全部输出与 drain，不按 PTS 归属 AU，仍限每侧32 AU。依赖窗口进入请求幂等、完整 provenance/预算、持久附件及只读原帧复核；旧 isolated-key 请求保持兼容。
- 可选 SSIM 伴随 PSNR 的语义与预算见 `docs/source-plane-ssim.md`，数值/结构校验在 `shared/analysis/quality/ssim*.ts`。固定 FFmpeg 均匀 8×8、步长 4 变种，不得混称高斯 SSIM；有效窗口的各平面覆盖须保留。共用同次可信解码、持久任务/附件和原帧查看；不得扩大源/几何支持。
- `server/analysis/quality/`：媒体库到一次性 PSNR HTTP 调用的文件、缓存、Node/Bun Worker 适配，见 `docs/source-library-psnr.md`。可信 producer evidence 只能由服务端完成扫描后提交；评分不得重建索引。实例质量准入排斥索引构建/上传和码流工作，物理退出前不能释放许可。一次性请求与持久任务的连接/取消契约分开。
- 持久单帧 PSNR 位于同目录 `job-{request,store,service,routes}.ts`，见 `docs/source-psnr-jobs.md`。提交幂等与终态/结果使用事务；运行由服务持有，观察断线不取消，取消须等待物理退出。独占锁后恢复 interrupted，无自动重试/共享/建索引；`quality.jobs` 仅声明显式单帧 PSNR，不代表 #121 全部完成。
- 单帧 PSNR GUI 任务编排位于 `src/admin/quality.ts`、观察/幂等适配位于 `src/analysis/quality/job-observer.ts` 与 `src/services/quality-jobs.ts`，见 `docs/psnr-task-workflow.md`。只读取可信缓存候选，不借播放游标/CSS，不自动建索引；关闭观察不取消持久执行，身份/client/标注空间迟到回复必须围栏。
- 已完成 PSNR 结果与现有共享标注的显式挂接见 `docs/annotation-psnr-evidence.md`，契约位于 `shared/review/quality-evidence.ts`。GUI/Agent 共用持久命令，普通编辑不得丢附件，导入/复制只保留历史事实并降权。普通证据工作区/评审为 v2，测量候选为 v3，无附件保持 v1；标注数据库为 v5，旧版本须拒绝。
- 共享附件的显式只读原帧对/ROI 查看见 `docs/annotation-psnr-pair-view.md`。独立快照会话通过原缓存/AU 解码但不计算分数；历史附件、缓存变化和不支持的几何必须拒绝，不得借普通播放器自动建索引。
- `scripts/dev.ts` 同进程启动 Vite 和媒体 API；`scripts/service.mjs` 管理 macOS 用户服务；`deploy/` 为便携运行与自动用户使用说明。
- `test/{unit,contract,media}/`：node:test，无浏览器依赖；`helpers/` 为可复用模块，顶层旧文件为兼容入口。WASM 用例在 Node worker_threads 里跑真实 core。
- `scripts/testing/`：统一清单、构建、生命周期与报告接入；`browser/{ui,annotations,media,workspace}/` 保存领域浏览器用例，顶层 `check-*-browser.mjs` 保留兼容入口。
- `scripts/tools/{development,fixtures,diagnostics,perf,release}/`：已归类工具实现，旧入口保留兼容；专用工具与职责索引见 `scripts/README.md`。
- `scripts/`：`sync-wasm-core.sh`（从 VoidPlayer-FFmpeg-Build 产物同步 core，可用
  `WASM_CORE_DIR` 覆盖）、`sync-samples.sh`（样片进 `fixtures/video/`，可用
  `VOIDPLAYER_SAMPLES` 覆盖）、`bench-playback.mjs`（Playwright 离屏播放基准）。
- `public/vendor/voidplayer-core/`：gitignored 的 core 产物，由 sync 脚本填充。

## 硬约束

- 显式参考关系与有理数源时钟对应计划见 `docs/reference-clock-plans.md`；共享契约/原始 AU 解释在 `shared/analysis/quality/correspondence.ts`，持久适配在 `server/analysis/quality/correspondence-*.ts`。关系声明不认证内容；分段半开 offset 仅精确唯一 PTS 匹配，不 nearest、不补洞。规划只读固定可信 cache build，独立预算、队列/历史、单槽 Worker 物理退出；显式稳定回执提交原 range，无外层持锁、无重启重算或自动候选。GUI/HTTP 共用规则，迟到响应须按 actor/view 围栏。

- 有界区间/抽样任务见 `docs/bounded-quality-ranges.md`；共享计划/聚合/策略在 `shared/analysis/quality/ranges.ts`，服务在 `server/analysis/quality/range-*.ts`。显式 AU 表与 all/stride 不自动对齐；coverage 区分未映射、未采样、不支持及未评分缺口。父协调器调用持久子任务且不得外层获取共享许可；实际 Worker 退出才释放容量。PSNR 汇总 SSE/count，SSIM 按平面窗口加权。候选须显式阈值/top-N/间距/文字/严重度，先冻结 IDs 再重放原子命令，不是人工判断。GUI 只被动查看，原帧链接走已有只读 viewer。

- 色彩链路契约见 `docs/color-pipeline.md`；修改色彩处理必须同步该文档，区分源标签与实际输出资源，禁止按片源堆叠 HDR/SDR 修正。

- UI 与 Agent 必须共用领域规则，不允许各自实现。浏览器视图操作经 `session.ts`；持久业务命令使用 `shared/` 契约与服务端适配器，不得依赖已加载轨道、暂停/播放状态或 GUI 确认。GUI 观察业务变化，不自动定位、抢焦点或打开媒体。
- 日志只留本地（IndexedDB），上传仅由用户在日志面板显式触发。
- 管理端身份观察统一使用 `src/services/identity.ts` 的 `observeIdentity` / `confirmedActor`；跨窗通知只触发服务确认，确认期间撤销旧观察，最新确认即使返回同一 actor 也须恢复。不得再给每个评分面板各写一套 storage/health 恢复逻辑。
- 解码路径选择按失败阶段决定（`MediaOpenError.stage`），不要新增“整体 try/catch 换路径”。
- 帧资源必须显式 `close()`；解码后端不直接画 canvas（必须经过 `src/presentation/presenter.ts`）。
- WASM core 的构建和裁剪在 `VoidPlayer-FFmpeg-Build` 仓库（分支 `wasm`），本仓库只消费产物。
- 标注坐标相对源帧，可延伸到视频外的对应视口；线宽 `strokeWidth` 存 CSS 像素，不随缩放变化。网格 < 视频 < 标注 < 半透明 UI；不要在标注 SVG 上加视频边界裁剪。
- 标注以矢量对象保存；页面 UI/Agent 编辑共用 `session.updateMark`，共享编辑逻辑在 `shared/review/marks.ts`，持久写入共用 `shared/review/annotation-command.ts`。采样策略由 presenter / presentation-surface 负责，缩小 LINEAR、放大 NEAREST，不放大 CSS 的中间位图。
- HTTP Agent 的入口与恢复约定见 `docs/agent-http.md`。持久标注、幂等回执和操作事件必须在同一事务提交；事件消费不能阻塞写入，过期游标必须明确要求快照重同步。

## 验证

```sh
npm run check:boundaries # 宿主依赖、模块归属与 Worker 入口
npm run check:shared     # 无 DOM 类型的共享层编译
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
`.run/identity-private`、`logs/`、`artifacts/latest-release.json` 与文档引用的取证报告永不删除。

套件注册与 CI 选例共用 `scripts/testing/manifest.json`，执行入口为 `scripts/run-tests.mjs`；新增测试必须登记。完整说明见 `docs/testing.md`。旧 npm 命令和脚本路径保留兼容。

## 独立发布

- 日常 PR/main 检查走 `.github/workflows/checks.yml`；正式打包由手动或版本标签触发 `.github/workflows/release-preview.yml`：固定解码器源码/工具链后准备共享 core，再在 Linux x64、Windows x64、macOS ARM64 原生 runner 打包和测试。
- `scripts/release-core.json` 固定上游修订，更新前先推送解码器源码；不要引用本地未提交改动或浮动版本。
- `scripts/package-release.mjs` 生成独立程序、资源、来源清单与校验和；`npm run test:release` 校验解压产物，无需真实片源。手动全量验证的分支运行上传预览 artifact；版本标签需匹配包版本和发布说明，经三平台汇总校验后生成 Release 草稿，不自动公开发布。`node --test test/release-pipeline.test.mjs` 验证版本、产物汇总和草稿重跑边界。

播放器独立 ROI 与原子测量候选见 `docs/quality-roi-candidates.md`，入口 `src/ui/quality-roi.ts`。普通播放 token 不可充当质量缓存身份；工具从加载媒体显式选择 AU，由独立 Worker 核验并通过 presenter 呈现后选 ROI，不能按 PTS 猜帧或隐式建索引。GUI/Agent 共用 `create-quality-candidate`，结果派生锚点/ROI、显式文字/严重度、未人工判断状态；事务/回执优先/actor 围栏不得省略。

可选暂停原生 FLV 入口与显式有界缓存准备见 `docs/paused-native-quality.md`。`native-picture-identity.ts` 只关联同 epoch 已受理单图输入与原生输出，`session.captureNativePresented` 只读取 presenter 成功提交的原始 VideoSample；不得借来源标签或旧 token/PTS 搜索冒用身份。`bindNativePresentedFrame` 精确连接当前可信 cache/AU/配置/包与几何。普通显式 AU 入口继续独立；WASM 与其他容器不继承此新能力。`psnr-index` 是显式30秒/64MiB来源/128MiB实际读/包和索引限额的独立操作，读取/评分永不隐式建索引；取消须先关闭真实文件和 Worker 才放容量，完成竞争可留下有效缓存，需重读。新测试登记现有完整CI，不改门禁分层。

媒体库技术发现与显式准备见 `docs/library-discovery.md`；共享字段/过滤/请求规范在 `shared/media/discovery.ts`，生产无解码 probe 在 `shared/media/probe.ts`，服务适配在 `server/discovery/`。发现只读复用有界缓存或已有 probe，不隐式读取媒体、建索引或提升评分准入；parser-local stream/clock 不能冒用质量 AU/namespace/build。准备任务与评分共享实例执行准入，取消必须等待 IO/DB 关闭和 Worker 物理退出；观察断线不取消后台工作。

评分执行架构和支持范围统一见 `docs/analysis-wasm-scoring.md`；分阶段实测与历史失败见 `docs/quality-convergence.md`。产品只有播放 core 与分析 core：后台解码使用播放产物的独立 Worker，VMAF/CAMBI/XPSNR 使用既有分析 core 的像素 API，不经 avfilter/framesync，不启动评分 CLI，不生成原始 YUV 临时文件。构建/算法/模型/ABI 由上游固定产物与本仓 release lock 约束，禁止引入仅 Linux 可用的生产评分组件。

VMAF/XPSNR 公共持久生命周期在 `server/analysis/quality/temporal-service.ts`，公共面板观察器在 `src/admin/quality-temporal.ts`；修正队列/回执/恢复/取消/关闭/分页/身份围栏应在公共层处理，算法、准入与证据策略仍由各指标实现。VMAF 的持久服务/GUI 在 `server/analysis/vmaf/`、`src/admin/quality-vmaf.ts`，请求/回执与数值语义见 `docs/native-vmaf.md`。CAMBI 服务/GUI 在 `server/analysis/cambi/`、`src/admin/quality-cambi.ts`，单源五尺度热图/候选及独立源快照见 `docs/native-cambi.md`。这些文件名、`Native*` 类名和旧 wire/schema 字段为兼容历史而保留，不代表生产原生执行器；旧结果与进程恢复只能按原 provenance 解释，不能改写为 WASM 身份。

宿主控制精确源时钟、AU/token、选择顺序、ROI 和完整排空；评分器仅接收像素与明确序号。VMAF/XPSNR 只消费已提交对应计划，不能拼接稀疏抽样冒充时序。CAMBI 不要求参考计划，按自己的单源/容器契约独立准入；五尺度热图区域统计不是小裁剪重算或目标跟踪。普通附件、候选回执、版本/历史兼容及原帧复核围栏不得丢失。关闭观察不取消后台执行，真实 Worker/IO 退出后才放容量；无法确认退出时保留相关存储所有权。
可信非分片 MP4 评分链路见 `docs/trusted-mp4-quality.md`。严格表读取在 `shared/media/indexing/mp4-quality-index.ts`，显式准备沿用 A 的任务、事务 cache 与共享物理退出准入。MP4 namespace/producer/result v2 与旧 FLV v1 并存；源适配读取真实 sample payload，不伪造/计费 FLV tag。时钟身份保留原始 ticks/timebase，跨源对应和节奏使用有理数精确比较；整数微秒仅用于传输/显示投影，不能用其取整值做匹配、修 POC 或 nearest。只读 viewer 使用已有可信 cache；VMAF 可复用严格 MP4/FLV 适配，但仍限连续等间距整帧 limited BT.709 SDR，MP4/混合结果及序列关联使用 v2，逐点保留 track/sample/ticks/table 见证。FLV v1 指纹/回执不变，执行器与原见证的支持范围不自动扩大；CAMBI 单独校验严格 MP4 avc1 H2648 / hvc1 HEVC8/10、精确恒定时钟与整帧 SDR，使用单源 v2 sample/table/producer 证据；不能从 VMAF/元数据就绪继承准入。

普通 HTTP Agent 渐进任务/操作发现见 `docs/agent-quality-workflow.md`。`shared/service/agent-operations.ts` 复用领域常量，JSON 与嵌入式 Markdown 共用描述，不增加第二套 validator；元数据可读不等于质量准入。`examples/http-quality.mjs` 只能使用公开 HTTP，默认只读，各类写入分别显式授权，不保存凭据；未知 POST 仅原 actor/body/key 或原 plan digest/policy 回放，不能换 key 猜重试，不静默配对或发布。

临时本机 stdio MCP 页面桥见 `docs/local-mcp-page-bridge.md`。`scripts/mcp-page-bridge.ts` 默认托管自己的 loopback 页面；显式 `--existing-origin` 复用已打开普通本机同源页面，使用独立 CLI/文档/授权内存凭据、无授权能力的公开单次匹配码、有界待授权池和固定最长到期。普通页面仅顶层文档可安装授权 UI；仅 view/annotate 不能透出完整会话回执，源名需 read。protocol gateway 后必须使用真实映射 peer 检查本机，不能信内部 loopback socket。页面显式用户点击授予 read/view/annotate 范围，随机 document/grant capability 仅存当前进程/页面内存，不能把声明名、Origin 或 epoch 当认证。只复用共享白名单 schema 与现有 Agent/session facade，不全工具透传、不接受任意脚本/媒体路径、不上传 File/日志，不自动连接或跟随标签。失去授权即废弃排队命令，已派发操作可能完成且回执未知，不能假回滚或自动换 key 重放。迟到消息按 document/epoch/correlation 围栏；关闭 stdin 后真实关闭自有 host/资源，不影响独立 HTTP 后台任务。现代与 legacy MCP 生命周期须分别按官方规范验证，stdout 只能写协议帧。

统一任务中心见 `docs/unified-task-center.md`。`shared/service/tasks.ts` 是 GUI/HTTP 共用严格筛选契约；`server/tasks/` 从原七个存储投影当前 actor 的摘要；在 SQL 中应用筛选后检查快照预算，超出需缩小筛选，不允许各取首页后伪全量筛选。短期冻结快照分页须明确失效重取，不将状态变化混入原快照；真实阶段/未知进度和结果回收分别保留。详情关联须核对原 actor/receipt/input/attempt/digest，取消只委托原服务并保留物理退出准入。不得借任务中心自动评分、重试、发布、建索引或移动播放头；actor 是自述归属，不是认证。

XPSNR 契约与对照见 `docs/native-xpsnr.md`；共享规则在 `shared/analysis/quality/xpsnr.ts`，服务/GUI 在 `server/analysis/xpsnr/`、`src/admin/quality-xpsnr.ts`。固定标量算法直接编入分析 WASM；参考输入在前、单片段时域状态、官方逐平面池化及 Infinity 语义不得替代。版本比较只接纳同一冻结参考片段、raw SHA 与 recipe/component，不认证内容或感知优越；候选是时间测量，不能伪空间热图。数值 CLI 仅为维护者生成独立对照的工具，不是部署依赖。
显式评分重新执行见 `docs/explicit-quality-reexecution.md`。原提交重放与新计算必须分开；single/range/VMAF/XPSNR 仅已物理停止的 failed/interrupted/cancelled/partial 可只读核验冻结条件并明确确认全量成本，原子创建一个带 retryOf 的新任务。每 job 仍只有原 attempt，旧结果/候选不变、不复用分数或自动发布。条件/执行器见证缺失须 blocked/new intent，不重建索引/C 计划或自动换模型。四种评分数据库 v2 的新 job 与回执同事务；未知提交只原 actor/body/key 回放，重启不自动重算。

CAMBI 显式重算复用 `reexecution.ts` / 原服务同库 `ReexecutionLedger`，见 `docs/explicit-quality-reexecution.md` 的单源扩展。仅物理停止 failed/interrupted/cancelled 且有完整冻结单源执行见证允许预检/确认全部费用/创建唯一后继，不新增 partial，不借 C/reference/model。见证先于原始解码保存，失败/取消/重启清理未完成分数热图不清理见证；源/cache/producer/core、实际 AU 选择排序、固定组件/recipe 漂移或旧无见证任务需新意图。原 actor/body/key 回执优先，事务前后崩溃不得产生无回执后继，取消实际退出前不得放准入；三遍执行 witness 与独立预检、累计索引/源读取/五尺度预算分别计量。GUI/CAMBI/任务中心/HTTPAgent 共用确认和追溯，不修改旧任务/附件/候选，不自动发布或准备索引。

XPSNR 版本比较 GUI 见 `docs/xpsnr-comparison.md`。复用既有 compare/result/frames/candidates，只读 2–4 完成任务；按共同参考呈现位置和精确见证分页，不按 AU 排序或近似 PTS 拼接。恢复固定 job/attempt/digest/domain，缺失或变化拒绝且清空旧分数；不得追最新结果、隐式评分/重算/发布或移动播放。官方 Y/U/V/minimum 与 Infinity 保留，排序不等于主观优劣。
