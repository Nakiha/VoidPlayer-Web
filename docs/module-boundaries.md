# 可执行的模块边界

`npm run check:boundaries` 检查源码依赖、Worker/资产地址、模块归属和浏览器 harness 导入；`test/contract/module-boundaries.test.mjs` 用隔离最小项目验证正例与负例。

- `src`、`server`、`shared` 的宿主边界包括类型、re-export、import type、require 和字面量动态 import。浏览器禁止 Node 内建模块，包含 `node:` 与裸内建名/子路径。
- `media`、`analysis`、`session` 不导入 UI、管理面板或应用入口；`media`、`analysis` 也不反向依赖 session 或具体 presenter。服务客户端继续禁止依赖 UI。既有解码路由 facade 和码流契约方向检查保留。
- 所有静态可解析的运行时 import、re-export、require、字面量动态 import 组成有向图，循环报告完整路径。纯类型边与 Worker/资产 URL 不属于同一执行上下文，不参与循环；混合类型/值导入仍参与。计算型加载沿原来的逐文件登记，不能通过动态拼接绕过宿主检查。

环境分别编译：`check:shared` 使用 ES2023 与标准 Web API 类型，`types: []`；边界检查按实际解析到的全局声明收紧到 `sharedWebGlobals` 白名单。URL、字节编码、Abort、计时、fetch、压缩流、crypto、Blob 和 structuredClone 等可移植 API 可用；`VideoDecoderConfig` 仅为描述数据的类型。DOM 页面、Worker 宿主、存储和 codec 构造器不可用，局部同名变量不误报。Node 的 process/Buffer 等由独立编译拒绝。

`check:environments` 分别使用 `tsconfig.browser.json`（DOM + vite/client，无 Node 类型）和 `tsconfig.server.json`（ES2023 + Node，无页面 DOM）。整个项目另保留编译以覆盖测试。`erasableSyntaxOnly` 拒绝 Node strip-only 不支持的参数属性等语法，避免“tsc 通过但 Node 无法加载”。

浏览器 Worker 只实现浏览器消息协议。真实 Node WASM 回归由 `test/helpers/browser-worker-host.ts` / `browser-worker-entry.mjs` 提供 Worker 及消息宿主，测试显式安装或注入；生产目录不加载 Node 测试适配。RPC 对注入的事件发射器只使用窄结构端口，不导入 Node 类型。

解码侧通过 `media/policy/frame-resources.ts` 读取当前消费者需求。页面装配把 GPU 资源需求查询传入该端口，低层诊断自行装配；解码模块不观察具体 presenter 的模块全局状态。需求在每次拉帧时读取，浏览器色彩模式仍保留 native resource，平面 copyTo 仍在已有取帧背压内。

`shared/color/yuv-planes.ts` 拥有布局、校验、采样和可见 chroma 边界。YUV 颜色转换、HDR 参考转换与帧描述单向依赖该模块；`yuv-color.ts` 保留原导出兼容，不再与 HDR 转换形成运行时环。

本轮评估了 ReviewSession 和分析面板。工作区恢复仍跨统一 run 队列、配置 lease、源与轨道提交/回滚；分析面板已经有 queries、inspection 和 settled demand owner，统一在 abort 时释放订阅与观察器。这次没有发现可与现有状态完整分离、同时降低协议份数的额外提取，不按文件长度拆 facade 或搬走闭包函数。

质量评分域使用具名公开能力：指标 `service.ts` 保留 policy、准入与证据，应用通过
`QualityApplication` 装配，跨服务命令通过 `quality-service-ports.ts` 取得窄能力。
`candidate-publication.ts`、`prepared-facts.ts`、`temporal-service.ts`、
`temporal-runner.ts` 和 `result-commands.ts` 只允许登记的装配/指标调用者访问。
这也约束类型、re-export、require 和字面量动态 import；旧 `vmaf/runner.ts`
只允许兼容 Hooks 的纯类型转发。中立 `temporal-contract.ts` 不得依赖具体指标，
XPSNR 也不得借 VMAF 取得共同合同或限制。所有权见 [质量域](quality-ownership.md)。

管理端质量工作台集中在 `src/admin/quality/`。目录外只访问 `workspace.ts`、
`resources.ts` 和任务中心复用的 `reexecution.ts`；temporal、指标面板、navigation、
fields 和 summary 是工作台内部实现。边界负例覆盖外部类型引用、re-export 和动态加载。
归组同步更新直接/动态导入及浏览器测试 hook 路径；发布入口仍为原 `src/admin/main.ts`，
本次移动的模块没有 Worker 入口或资产 URL，不需要新增发布清单例外。

## 媒体基础合同的归属

`src/media/contract.ts` 是浏览器 `DecodedFrame`、`MediaSource`、`MediaMeta` 和
`MediaInfoChange` 的稳定入口；它只含类型/接口和纯类型依赖，不创建状态或资源，
也不依赖打开、解码、状态更新或 presenter 实现。具体后端创建/关闭自己的资源，
消费者显式 `close()` 帧和 `dispose()` 源，presenter 决定上屏与按需 capture。
`source.ts` 继续拥有打开和失败阶段路由，原类型名只保留兼容转发；生产类型消费者
全部直达合同。media/analysis 不得反向引用打开入口，包含纯类型、动态加载与 URL。

共享源色彩为 `shared/color/color-info.ts`，帧时间与基础媒体描述为
`shared/media/types.ts`，请求/实际呈现事实为 `shared/presentation/presentation-info.ts`。
`shared/review/model.ts` 保留 Slot/Mark、评审校验与多轨步进，历史媒体类型名只做纯类型兼容转发。
shared media/color 禁止引用 review，浏览器 media 禁止经 review/model 取得基础事实。
现有 native-presented 评审交接协议不属于这些基础媒体类型，保持独立归属。

文件整体进入 MEMFS 的 512 MiB 上限归 `src/media/policy/fallback-budget.ts`，
只允许媒体实现引用；评审模型不再执行或转发解码预算。数值、准入条件、失败阶段、
后端选择和资源关闭顺序保持原语义。`.d.mts` 与普通源码一并迁移并检查。
这些主要是编译期依赖与职责的调整，不据此宣称运行时性能提升。

## 审计逐项结算

| 审计建议 | 本轮落点与防回退手段 |
| --- | --- |
| 保留 src/server/shared 外层分工 | 原宿主/编译/运行时循环门禁保留 |
| 候选冻结、提交确认、原 ID 重放 2 → 1 | candidate-publication；真实提交后丢回复、重启且结果不可读仍恢复原 ID，无评分重执行 |
| prepared 共同事实核验 2 → 1 | prepared-facts；指标自己的 cadence、几何及数值准入保留 |
| 共同序列事实从 VMAF 独立 | temporal-contract；XPSNR 禁止引用 VMAF，完整/压缩见证只有一份构造 |
| 结果释放从 HTTP 收回命令 | QualityResultCommands + 窄端口；range/evidence 保留规则由应用协调，原结果 owner 执行 |
| 质量管理 UI 13 文件归组 | admin/quality；公开 workspace/resources/reexecution，其余内部引用负例拒绝 |
| 浏览器媒体合同独立 | media/contract；后端不能引用 source 打开入口，合同不能持有运行时状态 |
| review 基础媒体/色彩/预算归位 | media/types、color-info、presentation-info、fallback-budget；反向依赖负例拒绝 |
| 目录移动与源码变化分账 | 质量域账见 quality-ownership；媒体合同搬移计零瘦身，单列完整源码净变化 |
| 数据库/Worker/许可所有权 | 沿用已有 owner，无新增资源、注册表或关闭链路 |
| ReviewSession、分析面板按状态 owner 评估 | 沿用审计结论与原有状态 owner；不按文件长度继续拆分 |

指标 service 目录与现有服务端 quality 浅层归属继续保留。审计没有要求全面重排 UI，
也不引入 controllers/services/repositories 模板或每目录全量 index 导出。

媒体阶段以 `c9f1682d` 为基线，逐文件账见
[媒体合同验收记录](evidence/media-contract-ownership.json)。生产源码 AST token 增加 163，
去空白 UTF-8 字节增加 1,330；合同搬移计零瘦身。与初始 `2c1fbc2` 比较，完整审计
两阶段合计 token 增加 106、去空白字节增加 4,731；质量阶段单独的净减 57 没有用来
掩盖整个 PR 的增加。主要收益是重复协议减少与合同依赖方向固定。

打开入口消费者 34 → 4、引用边 35 → 4、其中纯类型边 31 → 0；保留的四条都是真正
打开媒体的调用。底层 media/color 到 review/model 的引用 12 → 0。包括新增 helper
在内不增加资源 owner；媒体阶段 47 个已有生产模块的编译后执行体逐一比对一致，
唯一迁移的运行时声明是数值不变的回退预算常量，导入边另外核对。

媒体阶段本机验证：build（包含 i18n、宿主依赖、共享层与两宿主独立编译）、
改动行格式、56 个模块边界测试、fast 88/88、contract 47/47、真实媒体 Node 3/3 通过。
8 个媒体浏览器 case 通过：Chromium/WebKit 基础交互、双引擎 presentation 像素/
capture/旋转与回退、WebKit 色彩设置、FLV、Range、HDR 播放、原生 YUV 生命周期。
quality 阶段的数值、冻结恢复与 8 个浏览器 case 记录继续保留在质量所有权文档。

按播放/解码文件改动要求，另以隔离临时 HTTP 服务运行原
`node scripts/bench-playback.mjs webkit --headless`：默认 4 场景 × 3 次、每次最多 8 秒，
12/12 通过，沿用原阈值。场景覆盖 HEVC 4K、VVC WASM、VVC+HEVC 4K 和 MPEG-2 TS+H264。
这是本机 headless 实测，不代表物理屏幕扫描输出、跨机器性能达标或提速比较。
