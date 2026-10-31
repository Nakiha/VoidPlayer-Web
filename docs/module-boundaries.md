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
