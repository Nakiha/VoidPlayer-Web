# 验证说明

套件与稳定 case ID 以 `scripts/testing/manifest.json` 为准，统一入口为 `scripts/run-tests.mjs`。`package.json` 保留原有单项命令。不要把某次历史测试数量或构建成功当作当前兼容性结论。

## 统一套件与单项筛选

| 入口 | 范围与准备 | CI 对应 |
| --- | --- | --- |
| `npm run test:fast` | 明确登记的轻量 Node 逻辑与测试基础设施契约；不需要媒体、core 或浏览器 | 本地快速反馈；完整 Node 检查由 playback job 运行 |
| `npm run test:source` | 所有不依赖媒体、core、浏览器、外部工具或构建的 Node 逻辑测试；新增适用用例必须登记 | 独立 `source-logic` job，不等待解码器构建 |
| `npm run test:contract` | 清单、覆盖下限、独立结果、生命周期、发布依赖等契约 | identity / playback job；release identity 在安装依赖前也检查清单 |
| `npm run test:suite -- unit` | 全部 Node 测试，包括真实 WASM 与媒体断言；准备完整媒体环境 | playback job 的 `unit` |
| `npm run test:browser:all` | 自动化浏览器检查及内部矩阵；Chromium/WebKit、媒体/core/FFmpeg，默认构建一次 | `ci-audio`、`ci-playback`、`ci-cache`、`ci-flv`、`ci-fate`、`ci-analysis-browser`、`uncovered`、`flv-startup` 与 HEVC 四格矩阵 |
| `npm run test:media` | 真实媒体 Node / 浏览器检查；包括特殊的可信 HTTPS 功能用例 | playback / hevc-browser job；可信 HTTPS 仅在一次性 CI 主机执行 |
| `npm run test:suite -- release` | 固定 core 来源、原生归档、归档浏览器及三平台汇总；需先生成对应产物 | decoder / native-release / release-set；打包及草稿操作仍由 workflow 管理 |
| `npm run test:perf` | 索引构建、争用和可信 HTTPS 播放性能；所有结果显式 informational | `ci-perf`，保留 `continue-on-error`；可信 HTTPS 仅在一次性 CI 主机执行 |

`browser` 是自动化浏览器套件。需要 Windows 可见桌面的 Chrome/Edge 色彩与 WebGPU 检查属于清单中的 `manual-regression`，仍使用原有专用命令；外部服务、用户指定媒体的诊断/实验/基准属于显式工具分类，不会自动变成发布门禁。清单记录限制和理由，不能把 `npm test` 当作 fast，也不能把旧 `test:browser` 当作完整浏览器套件。

FLV 浏览器回归固定 640×480 视口，两种引擎均解码原始尺寸的输入。Chromium 的隔离 headless 进程显式启用 SwiftShader WebGL，避免 GPU 黑名单把整帧 YUV 转换送进逐像素 CPU 兜底；这不代表物理 GPU 或大视口性能验收。普通本地命令仍按原有全部性能阈值必过。GitHub 虚拟 runner 显式设置 `VOIDPLAYER_FLV_VIRTUAL_PERF=report`，只在 Linux headless Chromium、未验证物理硬件、已知 WebCodecs/WASM 与 browser-managed/WebGL 渲染路径中把 `below-realtime` 和 `A:presentation-stall` 留作非阻断性能报告；基准的阈值、`passed:false` 和失败原因不变，负面结果写入 job summary。没有采样/帧、错误、延迟、同步偏差与暂停后冒帧等失败仍阻断，seek、逐帧、尾帧与 Range 原有断言也保留。每个输入的完整结果保存到 `.run/playback-reports/flv/<engine>/` 并随 CI 报告上传。0.6.0 预检的 [1080p HEVC 负面记录](evidence/release-0.6.0/flv-legacy-hevc-ci.json)为 0.366×，[AV1 负面记录](evidence/release-0.6.0/flv-private-av1-ci.json)为 0.8998×，不能把功能门禁通过解释成实时播放达标。

HEVC 时间线检查保留每个输入两轮各 600 帧、每帧源尺寸截图、帧身份和 seek/逐帧/尾帧断言。Linux Chromium 每次全尺寸截图实测可耗时约 0.6–1.4 秒，因此 Chromium 单项总预算为 30 分钟，CI job 留出 35 分钟；这不是实时播放性能阈值。每 100 帧以及打开、seek、重开边界记录进度和呈现/截图/读回耗时；页面连续 180 秒没有进度则立即失败并输出最后阶段，关闭页面与浏览器。播放基准的帧率、延迟与停顿阈值不变。

```sh
npm run test:manifest
npm run test:suite -- browser --list
npm run test:suite -- browser --engine webkit --list
npm run test:suite -- --case browser-menu-webkit,browser-settings-chromium
npm run test:suite -- browser --case hevc-timeline-webkit-remote
npm run test:suite -- ci-native-console --platform win32 --list
```

`--case` 使用精确 ID，可逗号分隔；与套件、引擎、输入筛选取交集。带内部多引擎/输入循环的脚本作为一个 case 整体执行，筛选不会改写它的内部覆盖。`--platform` 仅用于枚举，不允许在另一平台伪执行。`--list` 输出适用 case、命令、引擎、输入、平台、夹具、外部工具、超时、产物目录、required 属性及不适用理由；空选择不算通过。参数拼写错误直接失败。缺少夹具、工具、浏览器或原生包是失败，不是自动跳过。

清单中 `fixtures.*.prepare` 给出准备命令；suite 不隐式下载、更换参考结果或生成缺失媒体。CI 每个 job 只准备一次可复用媒体/core，并继续负责下载、系统依赖、浏览器和平台矩阵。只有内部断言专用的可写夹具仍由各 case 自行生成。

### 解码 Worker 的消息契约

`src/worker-protocol.ts` 定义 FFmpeg 与 packet Worker 的命令、请求、响应和渐进索引事件。
`WorkerRpc` 位于 `src/worker-rpc.ts`；FFmpeg 的旧导出保留兼容。调用者只传命令和对应参数，
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

### 迁移覆盖对照与兼容期

`test/testing-coverage-baseline.json` 保存迁移时已有 case × engine × platform × input、执行命令、required 属性与 CI 归属下限；`test/test-manifest.test.mjs` 检查每格仍存在。`uncovered` 保留原有 20 格，并补齐此前遗漏的 16 格；CI 按 Chromium/WebKit 拆分执行。FLV startup 两引擎、HEVC 的两引擎 × 本地/远程（各两次重开）、FATE 内部矩阵和原生 Node/Bun 三平台验证都保留。完整 Node 验证仍由 `unit` 运行；`source` 提前独立验证无需媒体的逻辑；断言、媒体和参考结果不变。新增 case 必须显式登记，删除矩阵项或 required 属性会使契约失败。

契约测试解析发布与身份工作流中的 suite/case 选择和引擎/输入矩阵，要求每个 required 浏览器组合都被实际选择；移除 job、漏掉矩阵引擎或新用例未接入 CI 会失败。

CI 细分套件是统一清单的标签，本地执行相同标签会枚举相同的平台适用 case；不是第二份脚本列表。发布依赖测试继续确保所有 required job 成功才能汇总和创建草稿。`ci-native-http` / `ci-identity-http` 使用隔离数据模拟远程 HTTP 入口；`ci-native-https` 与 `ci-https` 涉及临时证书信任，入口要求 `CI=true` 的一次性主机，普通本地运行会明确失败而不会修改信任。

旧 npm 命令和脚本路径保持兼容，包括它们的既有默认引擎、参数和构建行为。例如 `npm run test:browser` 仍只运行原来的基础 UI 检查；连续执行旧带 build 的命令仍会重复构建，需要完整或组合检查时使用新套件入口。浏览器领域实现归入 `scripts/testing/browser/{ui,annotations,media,workspace}/`；127 个 Node 文件分批归入 `test/{unit,contract,media}/`，可复用模块归入 `test/helpers/`。顶层旧脚本和 Node 文件保留薄入口，清单的 `implementation` 记录实际文件。只选择旧入口或实际文件中的一处执行，不能同时枚举两处导致重复用例；`npm test` 继续枚举旧顶层入口，Bun 和单文件命令也保持兼容。契约检查旧入口指向、唯一实现归属，以及漏登记或悬空实现。开发、夹具、诊断、性能和发布工具分列于 `scripts/tools/`，入口与保留专用工具见 [脚本职责索引](../scripts/README.md)。详细覆盖对照见 [迁移验收](testing-coverage.md)。

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

`BASE_URL` 选择服务地址，`BENCH_REPEATS` 默认 3，`BENCH_DURATION_MS` 默认 8000。`--headless` 为离屏自动化运行。场景和阈值分别以 `scripts/bench-playback.mjs`、`src/benchmark.ts` 为准。

应用内“设置 → 色彩与解码 → 播放流畅度”的检查、Agent `benchmark_review` 和脚本共用同一个实现。它检查呈现帧、速度、等待、卡顿、同步和暂停后的旧帧；失败场景使脚本返回非零退出码。

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

After syncing the pinned core and generating `standard-h264.flv`, run `node --test test/flv-background.test.ts` and `npm run test:flv:startup`. The fixture appends a sparse 256 MiB audio tail and blocks reads beyond the initial 64 KiB. The first decoded/drawn frame must arrive while the tail remains blocked. After release, the worker uploads the complete index, a second opening reuses it without rescanning the tail, and playback plus administrator UI/WebMCP clearing are checked. Run `node scripts/check-flv-startup-browser.mjs webkit` for WebKit.

FLV startup reads the configuration and first video packet, then flushes the decoder to display that frame. The rest is scanned from the saved tag offset after the first frame; seeking outside the indexed prefix waits for completion. Duration is provisional until then, exposed as `indexState` in session metadata and the inspector. Cache lookup/upload is optional and never blocks the first frame.

Media indexes are stored in `library.sqlite` schema 7, keyed by media ID/version, kind, stream, schema, and indexer build. The schema migrates older FLV rows into identity-keyed manifests and batches; downgrading to an older schema requires restoring the prior database backup or rebuilding the library index. Only version-pinned library URLs use the cache API. FLV client uploads validate bounded packet offsets, codec configuration, and timing. FFmpeg fallback indexes are built on the server for versioned library media and streamed as validated record batches. MPEG-TS scan progress is reported before batches; the demux scan reaches EOF before the complete record set is persisted and transferred. While batches import, `indexState: building` means index finality has not arrived, not that scanning is still in progress. The complete document remains available for compatibility. Missing/changed files and removed/relocated roots invalidate caches, while offline storage preserves them. FLV uploads are capped at 32 MiB; FFmpeg record streams are capped at 2 million records/128 MiB, and total live cache data is capped at 256 MiB with least-recently-used eviction. Clearing increments an epoch so an earlier in-flight upload cannot undo the clear. SQLite may retain reusable free pages after deletion.

Administrators can list/search and clear individual versions or all caches under **帧索引缓存**. `list_frame_indexes` and `clear_frame_indexes` are registered through WebMCP in both the player and administration page and share the same client functions and server authorization.


暂停续播回归：`test/session.test.ts` 验证双轨连续暂停/恢复不重新 seek 或创建迭代器；定位、替换及释放会销毁原队列。`test/playback.test.ts` 验证暂停期间未完成解码最多归还当前一帧、不继续拉取，且未显示的帧不会被丢弃。播放队列仍按 4 帧 / 64 MiB 双重背压限制，允许单帧超预算以保证进展；原生帧按 allocationSize 估算像素存储，格式不可见时才按 RGBA 估算。该值不包含解码器内部参考帧、Mediabunny 预解码队列或 GPU 的全部开销。暂停保留这些有界解码资源以便快速续播，移除轨道才完全释放。

`check-http-playback.mjs --functional-only` 在真实 MP4/WebCodecs 上验证暂停无时间推进、快速反复续播不重新 configure 解码器，并继续执行原有双轨内存与资源释放检查。性能基准仍独立记录，避免把续播改善等同于持续解码达到实时。

失败诊断：`test/media-diagnostics.test.ts` 覆盖带 CRC 的 PAT/PMT、跨包 PSI、连续计数缺口、188/192/204 字节 TS 包，以及 AVS3 (0xD4)、HEVC (0x24)、私有 PES (0x06) 不误识别。只有所有打开路径都失败且不是网络/资源错误时，才额外探测至多 64 KiB、远程读取至多等待 1.5 秒。诊断报告 PMT 声明的编码，不把声明当作码流有效性证明；探测失败保留原错误，不扩大下载范围。


FLV 尾部恢复：`test/flv-recovery.test.ts` 和 `test/flv.test.ts` 验证首帧优先后，尾部截断不再使后台索引失败。只将末尾未完成标签排除出索引；非零 stream ID、错误 PreviousTagSize 等依然失败，配置头或起始关键帧缺失不能冒充可播放文件。时长来自完整包的时间戳，UI 明示“尾部不完整”；不把源文件绝对时间戳当作可播放时长。共享 FLV 帧索引格式升级为 schema 2 以保存 truncatedAt，旧格式缓存读取时自动失效，无媒体库数据库迁移。

真实 HEVC/私有 VVC/AVC 回归在完整码流后追加残缺视频标签，验证连续取帧、前后定位、尾帧及警告。首帧浏览器夹具包含被阻塞的大尾部和最终残缺标签，验证后台恢复、播放基准、警告显示与服务器缓存复用。缺失包可能是其他完整包的参考帧，因此恢复不保证任意损坏流都能输出每一帧；解码失败保留上下文并停止重复调用失败的解码器。worker 原始异常堆栈进入现有本地诊断日志，不额外上传。


FLV 同编码配置/分辨率切换：索引记录每段配置和所属视频包，新配置从关键帧开始；解码或跨段定位时切换对应配置并在段末 drain，避免丢失旧段 B 帧。WASM 复用模块，通过既有 vp_packet_open 重建上下文；WebCodecs 重新 configure。`test/flv-resolution.test.ts` 生成真实 H.264/HEVC 双分辨率文件，验证顺序帧、来回定位和缓存序列化；浏览器夹具验证实际播放跨过切换点及 UI 尺寸。尺寸由 session 在显示帧时更新，不由后台预读提前改变。不支持中途更换视频编码种类；配置切换缺少关键帧仍明确报错。


HEVC 竖屏：从 hvcC 的 SPS 数组读取编码尺寸、按色度采样单位计算的 conformance window 和 VUI SAR；配置 WebCodecs codedWidth/codedHeight 与 displayAspect，切换配置时同步更新。coded 与 SPS 不一致、visible 缺失/更小/错位、宽高互换时拒绝原生首帧并走软件回退，不能仅交换画布宽高；浏览器 visible 完全包含 SPS 可见区时只做 VideoFrame 元数据收窄（同一底层资源，无像素拷贝）并记 `hevc-visible-rect-repaired` 后继续 WebCodecs，像素区域一致时才可通过 VideoFrame 显示元数据修正比例。SPS 读取有边界/数量限制，多个不同尺寸 SPS 不猜测当前生效者。`test/hevc-geometry.test.ts` 包括 736→720 的 4:2:0 裁剪、720×1272→1270 收窄修复/拒绝分支与真实竖屏/非方形 SAR。

首帧与关闭重开：原生片源保留一份首帧引用，frameAt(0) 返回独立 clone，dispose 释放缓存及活跃 sink 迭代器。添加片源不会重复解码已经在会话时间 0 的其他轨道。浏览器回归使用带预滚的 H.264 / HEVC MP4，重复定位 0 不重新 configure 解码器，双轨打开/播放/关闭循环后检查所有主线程 VideoDecoder 都已关闭，并验证竖屏上屏与采样尺寸。

软件解码预滚：逐个探测负时间前缀，仅将返回时间不匹配的不可输出包移出显示索引，原始包仍留在 core 中用于解码参考。最多探测 128 个，非负时间包及其他错误不跳过。`test/preroll.test.ts` 使用真实 HEVC open-GOP 裁切文件验证首次及重复定位；浏览器回归同时覆盖原生与可用的软件回退路径。

HDR 上屏一致性：自有色彩模式明确拒绝 HLG/PQ；浏览器色彩模式下，原生 HDR 资源经 sRGB Canvas 2D 路径呈现，避免 external texture 缺少 tone mapping。首帧、播放、定位应使用相同路径。以实际资源 transfer 为准，不用容器标签覆盖可能已经转换的资源。具体准入、回退与日志以 [色彩链路契约](color-pipeline.md) 为准，相关检查不认证 HDR 显示输出。

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
