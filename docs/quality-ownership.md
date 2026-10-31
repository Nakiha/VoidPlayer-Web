# 评分应用、提交与观察的所有权

本契约在 main `6ac3602`（#164）之后收束应用装配、父子关闭和前端恢复。
HTTP 路径、持久 schema、历史指纹、WASM 算法、评分支持域及显式发布语义保持。
执行与资源上限继续遵守 [analysis WASM 架构](analysis-wasm-scoring.md) 和
[评分资源管理](quality-resources.md)。

## 应用装配与关闭

`server/quality-application.ts` 是评分服务的创建、依赖注入、恢复和关闭入口。
`runtime.ts` 显式创建一次并等待 `ready`，随后才开放 HTTP；嵌入式
`createMediaServer` 在装配 HTTP 时使用已传入的实例，或为媒体库装配一次。
创建服务器时传入的媒体库仍由调用者关闭，关闭一个 HTTP 监听器不接管它。
HTTP 装配显式登记本地码流分析读者；监听器关闭和应用关闭复用同一停止回执。
即使调用者先关闭外部媒体库、或分析仍在停止中，也不会提前释放共享索引。

`MediaLibraryIndex` 拥有目录、媒体版本、索引/缓存与共享索引存储。
兼容的 `quality*` 属性只转发到已装配实例；读属性不会打开数据库、
创建调度器或启动恢复，未装配时明确拒绝。执行器只接收索引数据库位置、
准入能力和 core 路径。任务中心的读取投影与取消命令分开，重算服务接收
所需的命令/查询依赖，不从媒体库寻找整套业务。

关闭有三个阶段：

1. 同步启动所有独立执行者和协调器的停止请求，拒绝新工作，等待真实 Worker、
   文件 IO、恢复和已开始的协调工作结束。停止执行期间保留数据库可读。
2. range 等父协调器读取子任务终态并落库后，再释放各评分服务的存储。
3. 外部管理端也确认结束后，释放共享媒体索引和目录锁。

各服务 `stopExecution()` 与 `close()` 分别拥有前两阶段，重复调用复用原结果。
一个 owner 失败仍让其他独立 owner 收到停止请求；不能证明执行结束时保留
依赖存储/锁并汇总错误，不能通过忽略错误或提前释放锁宣称关闭成功。
启动失败沿相同所有权回滚，同时保留原始失败和清理失败。

## 冻结提交

`FrozenSubmissionJournal` 独占浏览器提交的不确定性；PSNR、VMAF、XPSNR、
CAMBI 和显式完整重算均使用同一协议。领域适配保留原存储键/记录格式，
不将 CAMBI 的单源、range 的父任务或重算谱系改成相同的业务模型。

- body/key 在 POST 前持久保存。同 owner/key 的重复调用合并；原键重试使用
  原冻结正文，不从当前表单重建。保存失败不得发送。
- 没有发送标记的旧记录按结果未知解释。POST 前先写入“已尝试”，并撤销
  上一轮明确拒绝标记；一轮重试丢回执后不能继续沿用旧的可清除结论。
- 曾尝试且未确认时，后续 4xx（包括身份冲突）不能证明之前没有受理。
  未知记录不自动清除；首次明确拒绝按领域原规则处理：temporal/CAMBI
  解锁，PSNR 保留原键恢复入口，重算标记后仅允许用户明确清除。
- 只有完整校验的回执能确认原提交，包括 actor、key、任务 ID 和输入。
  PSNR 使用服务端同源的 v1 规范化投影比较默认预算，冻结的线上正文不变；
  旧指纹不变。HTTP 成功后校验失败仍未知，不能当成明确 HTTP 拒绝。
- 有效迟到回执可以确认自己的持久记录，但不能覆盖新 key，也不能导航或
  改写已切换/关闭的视图。同一 actor 下的提交按钮仍跟随已确认记录恢复，
  不因选择变化卡在冻结态。离开页面只停止观察，不隐式取消后台任务。

## 观察与证据装配

`QualityObservationScope` 独占 actor/selection 代次、取消控制器和命名请求槽。
同范围的普通刷新合并完整“读取到发布”过程；一秒轮询不能让超过一秒的
正常历史响应永久失效。换身份作废全部观察，换任务只作废选中任务相关读；
替换某个翻页请求只作废该槽。能力说明在身份确认后读取，随身份更新，
不会因切换任务被取消；不再保留另一个绕过视图检查的布尔开关。
请求槽的有效期只决定该次回复能否发布。已提交到 DOM 的历史按钮持有
actor 观察代次，不持有某次 history 请求槽；点击时建立新的 selection 观察。
VMAF/XPSNR/range 的历史和逐帧翻页以游标及替换/追加意图区分请求；
显式翻页暂停首页轮询，显式刷新才返回首页。旧请求即使忽略取消也不能清空
已追加页；换身份、离开面板后的旧控件不能恢复操作。
旧回复和旧 finally 即使忽略 abort，也不能
发布结果或解除新请求的忙碌状态。

领域控制器保留表单、指标格式、CAMBI 暂存/部分结果、range 覆盖、XPSNR
版本比较和显式取消/发布。旧的重复 controller/epoch/token/busy 状态已从
被迁移的流程删除；公共对象不接管任务执行。

`candidateAnnotations` 有界读取全部候选并检查 annotation 身份。控制器
先完成所有记录和链接装配，再检查当前观察、原子替换 DOM、提交发布版本。
第 N 条读取失败不留下半套链接，也不把版本记成已展示；下一次刷新可重试。
逐帧分页同样先装配完整片段，再推进 cursor，失败不能跳过一页。

## 数据目录不属于验收产物

`clean.mjs` 的 evidence 集合只来自统一测试清单声明的输出，不将未知
`.run/*` 当垃圾。当前配置数据目录及其父路径、历史数据库文件、嵌套数据
和 `.voidplayer-user-data` 标记均阻止清理候选被删除。运行时为数据目录写
标记，旧目录仍可凭持久数据库识别。默认 dry-run；本轮未清理真实用户数据。

## 回归入口

新增断言接入已有清单 case，没有增加 CI job、性能门禁、自动重试或超时。

- `service-shutdown.test.ts`：真实 SQLite、运行中 range/子 Worker、受控延迟
  退出、独立失败、原锁保留、父子终态及同目录重开。
- `clean.test.mjs`：隔离仓库内的自定义数据目录、清单输出冲突、嵌套数据库、
  标记与配置父路径保护；不触碰真实数据。
- `quality-workflow.test.ts` / `quality-reexecution.test.ts`：受控 Promise 指定
  丢回执、身份冲突、慢列表、旧视图、迟到确认、存储失败和第 N 条读取失败。
- VMAF/XPSNR 浏览器入口调用 `quality-recovery.mjs`：真实 HTTP/持久任务及
  四组异常恢复，最终阶段排空观察读者并检查全部页面错误。
- CAMBI/range 翻页夹具保留原响应，只对目标读故意忽略 abort，以验证旧回复
  确实抵达后仍不能污染新视图；生产读取继续正常取消，没有放宽原断言。

本轮不是 roadmap 全部研究项完成的声明。跨平台结果以 PR 的实际 CI 为准；
本机包验收只证明本机平台。研究/主观质量验证、新输入域和远端执行仍按原计划
独立管理，当前状态以 #112 为唯一汇总入口。

## 工作区打开交接

保存绑定代次与打开意图代次分别管理。一次服务端打开在身份确认、文档读取、
会话恢复和最终名称/URL 绑定间持有同一个 `WorkspaceOpenOperation`。
文件导入在读取文件前就取得新意图，恢复/直接导入也沿用相同入口；旧读取即使
成功返回也不能再调用恢复，迟到错误不覆盖当前状态。身份切走再切回同一 actor
仍使旧意图失效，页面关闭同样失效。

本次恢复成功后只能通过自己的 operation 执行 detach，撤销旧保存绑定而不使
自己的最终绑定失效。外部 detach 则同时撤销旧打开。导入取消仍保留原绑定，
不把未知的旧打开继续当成用户当前意图；共享空间恢复失败仍显示本次错误。

## 执行终态与取消清理

`openMediaPlan` 拥有已取得但尚未通过 adapter reference admission 的源。
该准入拒绝时先释放源，再传播取消或原错误；取消不能跳过释放，也不能触发
另一条解码路径。成功迟到的源仍由 `abortableLoad` 释放，不能两层重复释放。

`ScoringWorkerOwner` 的截止时间覆盖解码、打分、源复核及最后的异步组件核验。
`work` 返回后须再次检查合成 signal 和单调时钟，超时/外部取消/关闭均否决
成功；事件循环延迟定时器也不能接受已超过总时限的结果。否决仍等待原 work、
Worker 和 IO 真实排空，停止不确定时继续保留资源预留。
三个真实 WASM 执行器的 lifecycle 回归在最后一次组件核验停住、触发原 deadline、
再恢复核验，要求目标指标失败且物理退出后才能重新获取准入；VMAF/XPSNR
保留已完成的 PSNR/SSIM 伴随结果并按原规则返回 partial，CAMBI 丢弃暂存。

对应计划面板的关系/计划历史按钮同样持有独立 actor 票据；详情与逐行分页
由 selection/request 票据控制，不再维护第二套 viewGeneration。提交 journal
直接发送并确认其解析后的冻结正文；旧字符串存储格式仅在 codec 中转换，
迟到回执仍可结算原 actor/key，但不能导航到已被用户切走的计划。

冷启动标注链接先等待页面初始身份就绪，再读取标注并接受工作区打开意图；
不能让快速的标注 GET 抢在身份确认之前启动渐进恢复。身份随后确认同一 cookie
不会把自己刚接受的恢复误判为旧 actor 的操作。真实浏览器回归故意延迟初始
health 回复，要求标注恢复等待，随后原帧正常就绪。

## 迁移后的现行接口

WASM runner 的运行回调只表达当前使用的 Worker 阶段、进度、冻结执行见证、
伴随结果和 CAMBI `streamFrame` 背压；不再提供原生进程 `process` 或旧 `frame`
回调。历史 job 的进程字段、旧进程恢复/停止和真实服务事务崩溃测试继续保留。
VMAF/XPSNR 仍各自拥有算法适配，CAMBI 不合并成双源时域模型。

区间关系查询、结果归档与完成结果核验共用 `matchesChild` 的基础父子归属、
原 actor/client/key/request、预算截短和规范化输入检查；完成结果另行检查
attempt/digest、来源见证和数值，不能用基础关联替代结果验证。

元数据图表只按当前 `prefs.layoutMode` 与公共时间分组/几何显示，退役的严格
配对布局策略及无效单元宽度参数不再存在。重复时间戳、缺失 DTS、未配对样本
和桶/原始样本覆盖继续由当前查询、分组和图表模型回归验证。

## 双源时域评分的唯一执行协议

`TemporalScoringService` 统一 VMAF/XPSNR 的冻结合同、准入后状态推进、attempt、进度、伴随结果事务、取消/关闭/停止不确定性、最终结果事务与读取摘要核验。指标适配器保留 prepared 准入、数值结果、证据与候选策略；原表名、schema、指纹和事务边界不变。

`TemporalScoringRunner` 统一 preflight/重执行 preflight、decode-and-score、两次组件终验、来源终验和累计索引预算合并。整个流程沿用一个 `ScoringWorkerOwner` 准入与 deadline，只有真实 Worker/IO 退出才交回资源。VMAF 模型和 recipe、XPSNR filter/recipe/reference-first/逐平面池化/Infinity 仍由各自适配和数值核心拥有。CAMBI 的单源、渐进热图及 stop-and-keep 不进入这个双源协议。

## 质量域内部能力与共同事实

`shared/analysis/quality/temporal-contract.ts` 拥有共同的 `TemporalPrepared`、
`TemporalPlanSnapshot`、序列帧、指标执行状态和时序见证，并统一生成完整/首选末帧压缩见证。共同资源与保留默认值在中立合同中，
两指标分别采用，几何与帧数准入仍由各指标明确声明。VMAF/XPSNR 提供各自
限制和错误构造；模型、reference-first、逐平面/Infinity、cadence 准入与数值结果
仍在对应指标适配。历史 VMAF 类型名保留兼容，新公共事实消费者直接使用中立入口。
XPSNR 不再导入 VMAF，也不从其常量继承支持域。

`candidate-publication.ts` 只借用 `TemporalScoringService` 已打开的数据库，统一
冻结 publication、提交标注、记录 createdIds 和原 ID 重放。指标 service 先确认
actor、校验 policy，并提供延迟执行的选帧/证据适配。已有 publication 先核对冻结
policy，再重放原 candidate/operation/ref；不会调用选帧或提前读取私有评分结果。
冻结 publication、标注事务与确认回写保持独立，不增加跨库事务。数据库 schema、
表名、旧 publication 正文和幂等标注回执继续兼容。该模块没有数据库/Worker/计时器、
admission 或关闭链路的所有权。

`prepared-facts.ts` 在指标自己的 sequence/cadence/geometry 检查之后，统一核验
ROI、bit depth、SSIM、来源/index/picture/decode 身份以及冻结工作和结果预算。
这不是评分准入，也不替代指标各自的支持域、时序与数值核验。

`QualityResultCommands` 是结果释放的应用命令入口，由 `QualityApplication`
显式装配，依赖 `quality-service-ports.ts` 中的窄命令与保留查询。它协调 actor 读取、
range 引用、annotation evidence 引用，再交给实际结果 owner。range 继续拥有
原持久归档意图和子结果回收；任务中心仍是有界读模型。任务 HTTP handler 只接收
查询/取消与释放能力，保留身份、请求校验和响应映射；不再获得具体评分服务、
媒体库或完整配置类型。释放命令不创建资源，没有新增关闭步骤。

边界检查以具名调用者限制 publication、prepared 核验、temporal service/runner
和结果释放实现的访问，包括类型、re-export 和动态 import。外部模块不能直接
导入这些实现；公开 metric service、`QualityApplication` 和窄端口是稳定入口。
`test/contract/module-boundaries.test.mjs` 的隔离负例验证非法引用确实失败。

### 本轮工程化计量

基线 `2c1fbc2`，计入全部改动的 server/shared 生产源码与新增 helper；
[逐文件账目](evidence/quality-domain-convergence.json) 保留两种计量，测试、脚本与文档不计入生产源码。
语法 token 用 TypeScript AST 的叶子 token 计数，排除 EOF、注释和空白，避免 regex/template 的裸 scanner 误计。

| 验收项 | 结果 |
| --- | --- |
| 冻结/提交确认/重放协议 | 2 → 1 |
| prepared 共同事实核验 | 2 → 1，指标 cadence/几何准入独立 |
| 时序见证构造与压缩 | 2 → 1 |
| 生产语法 token | 29,375 → 29,318，净减 57 |
| 去空白 UTF-8 字节 | 118,075 → 121,318，增加 3,243；不宣称字节缩减 |
| 质量管理 UI 归组 | 13 个文件迁入 `src/admin/quality/`，瘦身记 0 |
| 资源生命周期 | 新增数据库/Worker/订阅/计时器/许可/关闭步骤均为 0 |

本轮净减少采用语法 token 口径，幅度很小；主要收益是协议份数减少、共同事实有中立入口、外部依赖变窄。
目录迁移及其 import 路径修订单独审查，不把路径变化、格式或新增注释计算为实现瘦身。

本机验收：`npm run build`（包含宿主/共享/独立环境检查）、
`npm run format:check -- --base 2c1fbc2`、fast 88/88、contract 47/47 全部通过。
真实 Node HTTP/WASM 覆盖 VMAF/XPSNR 原数值与支持域矩阵、两指标物理退出生命周期、
任务中心，以及 ROI/有理时钟/192 帧完整序列和末帧证据。两指标的真实标注事务提交后
故意抛错，再重启并移除私有结果，原冻结请求恢复相同 candidate/operation/ref，
createdIds 补确认，标注 revision 保持 1，评分执行次数为 0；改 policy 仍拒绝。

8 组真实浏览器 case 全部通过：VMAF 8-bit 与 XPSNR 8-bit 各 Chromium/WebKit，
以及 WebKit XPSNR comparison、CAMBI 8-bit、Task center 和 admin。它们验证迁移后的
质量工作台装配、观察/分页恢复、结果释放、候选和资源设置。13 个移动模块逐一与基线
正文对照，除相对模块路径外一致；i18n scope 与测试 hook 同步迁移，目录内部访问负例通过。
本轮没有修改播放/解码路径，也没有新增性能结论；跨平台结果仍以 CI 为准。
