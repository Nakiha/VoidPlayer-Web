# 画质评分收敛验收

本轮从 main `d495ec517938862e6b5dac99d6f6657e87d3ee95` 开始，承接 #112。
目标是实际媒体上的完整、可持续使用流程；合入数量和局部测试绿色不代表完成。
原 roadmap 的研究、额外平台与分布式目标保留，不能混作基础闭环的完成条件。

## 当前验收状态（2026-10-30）

代码候选 `9c384dee798ecbf6b015aeb74baa006c0d5b5de7` 已分阶段推送，尚未合入 main。
三个感知评分器均使用既有分析 WASM；没有新增第三个 core、avfilter 或生产评分 CLI。
本地实际闭环、双浏览器、生命周期与播放回归完成。三平台发布门槛独立以
[PR #161 的精确提交检查](https://github.com/Nakiha/VoidPlayer-Web/pull/161/checks)
为准；本地完成门槛不替代未完成或失败的远端检查。
此处是当前状态；后续各阶段段落保留当时的失败、限制和待验收记录。

最终代码干净 macOS ARM64 包：
`voidplayer-1.0.0-preview.9c384dee-darwin-arm64-2026-10-29T21-24-39-105Z.tar.gz`。
SHA-256：`c7d97449b51159997ffca1908d01fabd756d141a948da82fb74c797496536f33`。
空 PATH/无关 cwd 的真实解压程序通过发现与准备、PSNR/SSIM/网格、VMAF/CAMBI/XPSNR、
官方分数/五尺度热图、共享证据、持久幂等及显式重执行；独立包契约同时通过
升级/备份/恢复、SQLite互斥、HTTP/Range/取消、身份及工作区保留。
最终 contract 43/43，Node 与 Bun 同组真实 HTTP 各53/53，播放基准12/12。

## 启动时基线（修复前）

- 构建（含共享层、模块边界和类型检查）通过；fast 82/82、contract 43/43。
- 本机旧播放 core 不匹配 release lock。已从 PR #160 的固定 CI run
  `40893147329` 取得 `release-core`，经现有来源和文件 hash 验证后同步。
  相同的无浏览器 single FLV/FLV、range MP4/FLV 两例由失败变为 2/2 通过。
  旧产物失败不能据此归为 main 源码回退。
- MP4 质量索引将每个原始 tick 时间要求为整数微秒；实测 24/30/60、
  24000/1001、30000/1001 的帧时长均被拒绝。精确时基应保留，显示时间不能成为身份。
- VMAF/XPSNR 每任务预留 8 MiB、历史总预留 64 MiB，且没有回收流程；
  第九个新任务会被拒绝。CAMBI 同样存在终身历史容量限制。
- 当前原生评分依赖只支持 Linux x64；VMAF/XPSNR 连续序列最多 32 帧。
  当前测试不证明常见帧率、实际片段长度、连续批次均可使用。

## 架构决策顺序

1. 保留播放 WASM core 和分析 WASM core 的职责边界。评分输入必须是完整解码
   的原始像素，不能使用省重建块数据或呈现截图。
2. 优先验证在现有分析产物中提供独立评分入口。后台解码使用播放产物的独立
   实例，评分不访问当前播放实例。码流分析不因加入评分入口而执行评分。
3. 在原生扩平台或新增第三份 WASM 产物之前，完成固定算法的 WASM 构建、
   数值对照、体积和内存测量。不能把未经实测的性能推测当作增加部署体系的理由。
4. 现有原生程序暂保留作数值对照与旧结果解释；迁移未验证前不删除结果、
   回执或共享证据，也不改变旧结果中的执行器身份。

### 评分不经 avfilter

选帧、对应关系和时钟由共享业务层负责；保留有理数源 ticks/timebase，
不能把取整后的微秒当作跨源帧匹配依据。独立解码实例以输入 token 关联
输出，按已验证的呈现次序交给评分器。评分器只能接收像素、几何、位深、
stride、明确 ROI 与连续序号，不参与 seek、PTS 修正或帧率转换。

PSNR 直接计算像素误差，分块/区间汇总 SSE 与样本数后再计算 dB；SSIM
保留明确窗口语义。VMAF 使用 libvmaf C API，选定连续片段共用一次上下文
与最终 flush，不用逐帧或任意分段的独立 VMAF 均值替代。裁剪区域 VMAF
必须独立重算并记录裁剪条件，不能将整帧分数解释为局部热图。

### 早期 WASM 实验记录（不替代产品验收）

固定 libvmaf `17a67b238ce0539bdeafdc95961abac64fa16ea8`，直接使用
`vmaf_init` / `vmaf_read_pictures` / score API；单线程、内存输入、
`FILESYSTEM=0`，不使用 FFmpeg avfilter。现有 5 组 VMAF、14 组 CAMBI
原始像素夹具与同源码、关闭汇编的 macOS 原生库比较：CAMBI 分数最大差异0，
VMAF 最大绝对差异约 `5.8331101e-6`。最初试探性 `1e-7` 断言未通过，
保留该结果；没有据此降低产品已有容差。正式容差及差异来源仍需验证。

实验产物 783824 字节，gzip 181625 字节；包含上游全部内置整数模型，
不是集成到分析 core 后的增量体积。该实验尚未验证热图字节、长序列、
浏览器、资源回收或产品 API，不能据此声明评分迁移已经完成。

## 本地基础闭环完成门槛

- [x] 普通 HTTP Agent 从空缓存检索、准备、选定来源/参考关系，完成 FR/NR
  评分并创建可复核候选；GUI 与 Agent 使用同一事实与规则。
- [x] 真实 H.264/HEVC 8/10-bit 素材覆盖常见整数与分数帧率、重排和多个 GOP；
  原始 ticks、AU 身份和精确对应关系贯穿测量、附件与原帧查看。
- [x] 处理实际片段长度，输入、解码、评分和结果均有背压与可观测预算；
  不通过把整片放进内存或拼接独立时域评分来移除 32 帧限制。
- [x] 连续提交跨越旧容量上限，正常完成、失败、取消和重启后均可继续；
  明确结果保留/回收与请求回执的不同寿命，不误重算、不默删共享证据。
- [x] 关闭 GUI 不取消后台任务；重连恢复任务与候选；播放 A 时处理 B/C
  不改变 A 的播放头、来源或视图。
- [x] 固定官方数值对照、真实媒体 HTTP、双浏览器复核和适用独立包检查通过；
  播放相关变动按原规则运行基准，保留失败与未验证范围。
- [x] 实际修改涉及的长行代码整理为可读函数；已经重复的生命周期逻辑按
  真实共有行为合并，禁止再复制一整套任务服务来增加指标。
- [x] #112 与子项只呈现当前能力、剩余阻塞、对应验收证据；历史流水另存，
  不保留互相矛盾的“尚未实现”和“已合入”作为当前状态。

每批只处理以上流程的具体阻塞，记录失败输入、修复和复验结果。未达到门槛
继续标为未完成；不通过新增指标、堆叠状态文档或改小验收范围来关闭任务。

## 阶段一：分析 core 评分接入

当前实现、输入域和已通过的验收见 [analysis-wasm-scoring.md](analysis-wasm-scoring.md)。
本阶段 build、fast 82/82、contract 43/43、core 35/35、HTTP 13/13 通过；
其中 HTTP 包含三组192帧多GOP片段、两组固定ROI及20次连续任务。
上游修改分为评分 ABI 与512槽身份表两个提交，均已推送。
上述完成门槛仍按整轮任务保留，不能把阶段完成当作最终收敛。

## 阶段二：评分界面与浏览器闭环

实际对照播放器和评分页后，修复了六套流程堆在同页、客户端标识与原始
执行数据抢占主界面、复选框继承文本框尺寸、说明仍引用旧原生入口的问题。
沿用播放器的颜色、表面、分段按钮和焦点规则；各流程独立显示，切换保留
草稿与冻结请求，刷新恢复所选流程。结果摘要直接显示服务端官方 pool，
完整 JSON 保留在详情中，不从四舍五入的逐帧值重新计算。

- WebKit、Chromium 管理页回归通过：明暗主题、390/1280 像素六流程布局、
  草稿保留、键盘切换、刷新恢复；切换流程没有提交或取消评分请求。
- Chromium 8 位、WebKit 10 位真实分析 WASM VMAF：丢失响应后的幂等重试、
  服务端结果、候选发布、独立原帧窗口及另一页面的播放隔离通过。
- WebKit 8 位参考关系→计划→区间评分→候选→原始像素复核通过；
  Chromium 8 位单帧 GUI/Agent、窗口关闭、取消后 Worker 退出与播放隔离通过。
- build、contract 43/43 和清单检查通过。
- 本机截图：`.run/quality-convergence/ui-audit/`；浏览器自动化结果图：
  `.run/native-vmaf/browser-chromium-8/vmaf-result.png`。

仍需处理其他评分的长序列和生命周期、遗留原生测试与独立发布检查。
表单中的计划身份与候选策略仍偏技术，后续应通过已有关系/计划选择串联；
不能把本批布局修复解释为整轮产品验收完成。

## 阶段三：独立发布与旧契约清理

CI 首轮失败已经本机复现：独立包仍断言 CAMBI 不可用，附件测试仍按旧
128 KiB 构造超额输入，MP4 与前向解码边界测试仍要求旧整数微秒/32 帧限制。
修正测试时保留负向覆盖：缺少分析产物时 capability 必须明确不可用；
附件超当前共享预算仍拒绝且原记录不变；原始 ticks 不随微秒投影改变；
实际解码512 AU/侧后，下一 AU 必须拒绝。

- Bun 附件真实 HTTP 3/3、MP4/前向边界与相关契约22/22通过。
- 官方对照加入 MP4 CAMBI 重排输入，分析 core 39/39通过。
- macOS ARM64 原生打包及完整独立包检查通过：空 PATH、无关工作目录、
  搬迁、缺失前端资源、持久数据恢复和协议行为均覆盖。
- 打包程序真实分析评分矩阵通过：VMAF 11组（FLV、MP4和双向混合；
  H2648/HEVC8/10），CAMBI 5组（含MP4重排）；逐帧/池化与独立官方对照，
  CAMBI五层热图逐帧字节 hash，均从真实解压程序读取。
- 编译包 single/range/VMAF 的实际取消、物理退出、显式完整重算和回执复用通过。
- 原 native-vmaf/native-cambi 发布命令保留为同一分析 WASM 验收入口；
  不再安装 Linux CLI 才允许包内评分。XPSNR 遗留迁移仍未完成。

本机证据：`.run/analysis-quality-release/analysis-quality.json`、
`.run/reexecution/compiled/reexecution.json`。全量 unit 的首轮仍在运行；
已发现的两处旧边界断言均按以上实际边界重测通过。

## 阶段四：任务历史容量和结果回收

单帧、区间、参考计划和媒体准备任务不再用终身任务数量限制新工作。
执行中预留最坏输出；确认停止后按保留的 UTF-8 输入、结果、执行契约与
小额凭据开销结算。启动时迁移旧预留，保留原任务、摘要和幂等键。
区间预留随采样点数量增长；调度与恢复仅加载未终止记录。

单帧任务接入任务中心的显式结果回收。结果摘要与原始回执保留，结果入口
明确不可用；正在执行、被区间引用或被当前/历史标注引用的结果拒绝回收。
无自动淘汰，也不会因回收而隐式重算。字节预算仍是硬限制，历史记录没有
被伪装成可无限保存。

- 29/29 单元测试通过，包括超过旧 1,000 次单帧/准备任务上限、实际结果
  填满字节预算、释放后继续提交、重启后的摘要/回执和队列/物理退出约束。
- H2648、HEVC8/10 三组真实 HTTP 评分、回收、异身份拒绝、共享证据保护、
  重启后结果可用性与幂等回执通过。
- build（含边界、共享层与类型检查）通过。
- 全量 unit 首轮 220/222；仅前述已修复的 MP4/前向旧边界断言失败，
  两组已分别用真实解码重新验证通过。后续修改按受影响用例继续验证。

## 阶段五：按帧声明精确时间偏移

参考关系支持精确分数偏移；GUI 可输入整帧数及帧率分子/分母，API 保留
原整数微秒写法并校验显示投影。匹配、变换区间重叠检查均用精确分数，
不依赖四舍五入后的 PTS。旧请求身份不变，等值分数规范化；已保存关系
重新选择、冻结提交/重试和任务结果保留精确偏移。

- 单元8/8：等值身份、投影冲突、无效时基、亚微秒重叠与边界。
- 真实 MP4 29.97 fps：一帧1001/30000秒偏移精确匹配7对，尾端缺洞保留；
  33367微秒偏移明确无法匹配。实际区间7对评分及每对原AU核对通过，
  区间引用的单帧结果回收被拒绝。
- 其余分析 HTTP 13项通过（5种帧率、ROI、CAMBI热图、批量回收、
  H2648/HEVC8/10各192帧连续解码）；新增偏移用例单独修正预期的
  blocked状态后通过。没有把无匹配计划误报成可执行。
- WebKit8真实GUI/Agent参考关系→计划→评分→候选/原像素回归通过，
  包含新的帧率偏移表单、冻结重试及独立播放。build通过。
- MP4测试重定时也同步movie/track duration，保持容器时钟自洽。

## 阶段六：CAMBI 连续区间与取消收尾

CAMBI 区间复用连续解码器，每个 GOP 解码一次；逐帧热图写入有背压，
完整排空与末次源核验前不公开临时结果。取消时即使 Worker 已退出，
父进程写入尚未结束也必须保留计算名额。准备元数据不再每帧完整重写。
长期存储中的 GOP 见证必须完整，不能把流式中间状态当作最终证据。

选择上限提升至1024帧，同时保留热图、累计像素、源读取、结果字节与
截止时间限制。超过32帧的重执行选择表使用完整摘要与首末帧绑定；
192帧确认请求低于8 KiB。重执行成本区分解码堆与分析堆，按共享窗口
核算依赖输入；末次索引核验也进入实际工作量。

- Node、Bun 真实分析 HTTP 各18/18：H2648、HEVC8/10各192帧，逐帧/池化
  CAMBI 与官方对照，五层热图全部 hash 相同；边界帧实际下载字节一致。
- 实际取消、写入未完成时的容量占用、临时结果不可见、显式完整重算、
  幂等回执与原任务不变通过。末帧候选证据与已共享结果保留通过。
- GOP见证负向测试覆盖不完整排空、重复输出、token/PTS/DTS/包长度/
  hash/错误标志/阶段变更和目标帧缺失；4/4单元测试通过。
- build通过。WebKit播放基准首轮11/12，双轨VVC＋HEVC第三次换片出现
  Worker异常；按相同顺序独立复跑12/12通过。首轮异常未稳定复现，保留
  两次记录供后续排查，不能把首轮记录覆盖成通过。

本机证据：`.run/quality-convergence/cambi-stream-bench.json`、
`.run/quality-convergence/cambi-stream-bench-repeat.json`。
遗留原生测试迁移与 XPSNR 旧执行路径仍未完成，不能据此关闭整轮收敛。

## 阶段七：把工程验收迁到真实分析 Worker

VMAF/CAMBI 原有 HTTP、生命周期和浏览器用例不再等待原生 supervisor。
故障注入改为持有真实 Worker 消息、终止真实 Worker、破坏实际热图及产物、
杀掉真实宿主服务。准备好的 PSNR/SSIM 在最终核验失败或宿主中断后保留，
没有准备完成的分数不伪装成部分成功。重启不自动重算，回执事务崩溃测试
仍验证“提交前无后继、提交后只恢复同一后继”。

迁移时修复两个实现问题：最后一次来源核验期间分析产物发生变化，必须
再次核对并拒绝提交；CAMBI 缺产物返回503，实际评分阶段正确显示运行中。
能力说明只声称产物 hash 已校验，像素 ABI 在执行时验证，不再冒称已运行
原生自检。旧测试命令保留兼容入口，取消自动安装原生 VMAF 组件。

官方 CLI 只用于显式生成独立对照，常规测试按输入原始像素 SHA 查找固定
结果；新增同源 VMAF 对照。容差保持官方对照清单原有值：VMAF 1e-5、CAMBI
1e-6；热图下载后的长度和逐帧 hash 必须完全一致。测试没有用产品 WASM
重新计算自己的期望值。纯 VMAF/CAMBI 用例注册到三种宿主平台并要求既有
analysis-core，仍包含旧 XPSNR 的混合套件暂留原平台范围。

- Node 生命周期34/34，Bun六组实际HTTP/生命周期/重执行85/85通过；
  新增CAMBI末次产物变更用例另行验证。
- Node官方core/HTTP首轮90/95，失败均为旧缺产物配置或错误沿用CAMBI容差
  到VMAF；按固定官方容差修正后5/5复测通过。完整core59项均通过。
- 相关任务中心、Agent HTTP、单帧/区间/VMAF重执行17项通过；一个原有
  平台专属用例跳过。XPSNR混合用例尚待迁移，不计入本阶段通过数。
- contract43/43、build通过；CAMBI重执行WebKit与Chromium实际界面均通过，
  包含双窗口、未知回执恢复、候选原帧/五层热图与独立播放。
- WebKit HEVC10 的 MP4→MP4、MP4→FLV、FLV→MP4 三组实际VMAF流程通过。
  首次运行被同时重建dist打断，第三组旧资源404；固定产物后完整重跑3/3。
  CAMBI末次产物变更负向用例在Node和Bun各自通过。

XPSNR旧原生路径和最终发布矩阵尚未收完，本阶段不关闭roadmap。

## Stage 8 — XPSNR joins the existing analysis artifact

The analysis source pin is now `19e755f65003750873f88587369f3a1f340e14c1`.
Its scalar pixel-only XPSNR adapter follows FFmpeg revision
`8998a1a670c81a04d144c36f9e2d3aa680c10720` and records the upstream filter and
adapter hashes. No avfilter, frame synchronization, demuxing, PTS rewrite,
native executable, or third WASM artifact is used for product scoring.
The host supplies ordered reference/distorted planes and the exact frame rate;
one clip context retains temporal history through final pooling.

XPSNR now uses the same source identity, complete-GOP streaming, fixed even ROI,
rational cadence, physical Worker exit and final source/artifact verification
as VMAF. The selected interval can contain up to 1024 frames. Frame and pooled
scores retain full precision with explicit positive infinity; the old rounded
CLI format remains readable as historical evidence. Equivalent rational frame
rates normalize to one recipe. Comparison pages verify original clocks, and
long-clip evidence retains digest-bound first/selected/last witnesses. Fixed a
shared API defect that had restricted VMAF evidence retrieval to two-digit frame
indices. Final verification accounting stores only costs, not another copy of
the sequence.

Independent upstream validation: 20 raw clips cover 8/10-bit, 24/29.97/60 fps,
identical/near/noisy signals and 1080p/4K; four 4096-frame runs verify bounded
heap. Web fixtures contain 68 separately generated official CLI clips, including
192-frame reordered GOPs and cropped regions. Four-decimal CLI output is
compared with an explicit 0.000051 dB tolerance; expected values never come from
the product WASM. The fixture generator is an explicit maintainer tool.

Validation during integration: Node HTTP/reexecution 35/35; real Worker
lifecycle regression across VMAF/CAMBI/XPSNR 56/56; Bun XPSNR HTTP/lifecycle and
all-metric reexecution 57/57; XPSNR unit/contract 16/16. WebKit 10-bit submission,
response-loss replay, candidate evidence, isolated viewer and actor fencing
passed. A macOS ARM64 standalone preview passed 11 XPSNR container/codec cases
with empty PATH and an unrelated working directory. Final clean packaging and
cross-platform CI remain subsequent release gates. Historical Linux-native
fixture generators and evidence are retained until the engineering cleanup
stage; they are no longer installed by the test wrappers or production service.

Stage 8 final follow-up: WebKit multi-version comparison passed 41 assertions,
including candidate-viewer return, exact pinned pages, identity fencing and
explicit owner restoration. Return links now select the XPSNR panel, with a
fallback for older addressed comparison URLs. The test restores HttpOnly
identity only after draining prior responses, avoiding an old response replacing
the requested test identity. The cold HTTP Agent workflow now runs VMAF and
XPSNR on every platform without native fixtures or skips: Node 9/9 passed.
The full contract run was 42/43 because the release matrix still expected only
the playback fixture for comparison; that assertion now requires both artifacts
and its 20-test file passes. A final XPSNR HTTP run was 22/23 when formatting
changed the producer source hash between scoring and final verification; the
expected identity refusal was reproduced as a partial result, and the affected
case passed with stable files. No changed-source result was published.
Upstream PR 14 CI passed both analysis and playback/packet-ABI jobs at 19e755f.

## 阶段九：删除停用执行器与真实持久容量

生产入口及独立包删除原生 VMAF/XPSNR 组件加载 Worker、CLI/supervisor 启动器和
临时原始片段执行路径；三个评分服务直接使用共用 ScoringWorkerOwner。
仅保留旧进程身份核验/回收和旧证据解析。旧配置字段接受但运行时忽略。
Agent 的能力、操作目录、渐进指南及三个旧文档 URL 统一指向当前分析 WASM，
消除 Linux 专用/32帧/不支持ROI等过期准入描述。

评分存储的终态结算改为实际 UTF-8 输入/冻结计划/任务正文/重执行及发布回执/
结果/热图，加每条1024字节标量余量；逻辑载荷预算不等同 SQLite页/WAL占用。
终态立即结算，释放结果后仍保留并计入回执，发布部分成功的记录也计费。
删除已无调用者、会枚举全历史重试链的 links 方法；任务中心继续按指定任务有界查询。

本地验证：构建、模块边界、共享层编译通过；契约43/43；快速81/82，唯一失败
为 Agent 测试仍期待 Linux native host，更新此过期断言后该文件及CAMBI契约11/11。
真实评分HTTP89/89（包含三指标、ROI/有理帧率/长片段及重执行）；三指标物理
Worker生命周期56/56。存储与契约定向22/22；额外HTTP20次连续提交验证最后一个
任务无需下次提交即结算、结果释放保留实际回执占用，通过。
真实WebKit重执行流程35项通过，使用分析Worker的实际配套结果持久化后失败，
旧原生SIGKILL假设移除；真正Worker故障/取消/退出仍由生命周期测试覆盖。
Bun生命周期及最终新独立包验收继续执行，不能由上述Node结果推断。

## 阶段十：界面行为与老播放器回归

新增评分页面保持老播放器的深色层级、按钮和输入控件风格，计划凭据改为紧凑
字段组；增加参考关系入口、中文/英文可读字段标签，修正XPSNR旧原生/32帧文案。
后台请求字段与冻结请求不变。隐藏评分页停止周期观察，保留表单与待确认请求；
VMAF/XPSNR/CAMBI追加历史页后暂停首页自动覆盖，显式刷新才返回首批历史。

独立截图复核保存于 `.run/quality-convergence/ui-audit/xpsnr-stage10-after.png`。
实际XPSNR浏览器WebKit10/Chromium8均通过，增加两轮观察期内隐藏面板零轮询、
九条真实任务跨页保留断言。WebKit HEVC10的MP4/MP4、MP4/FLV、FLV/MP4
三条发现→准备→对应计划→评分→共享证据→用户围栏完整流程通过。
完整老播放器WebKit UI套件通过（94.8秒），快速82/82、构建与翻译覆盖检查通过。

键盘提示框CI失败新增确定性负例：同一事件轮次focus后scroll会在0毫秒显示
定时器触发前清掉anchor。旧实现真实WebKit稳定超时，移除“提示框已显示”前提后，
WebKit/Chromium完整i18n、焦点滚动、弹窗、文件重连、播放独立性均通过。
阶段九补充：Bun真实生命周期与存储67/67通过。

## 阶段十一：移除原始文件旁路与最终交付检查

VMAF/CAMBI解码辅助器不再接受原生执行契约或输出目录，也不再包含写YUV分支。
只对送入评分的实际源行计算hash和累计字节；旧证据仍由历史契约解析，不进入
新执行分支。CAMBI/XPSNR服务及解码辅助器的长行展开为可读代码，未新增任务服务。
此轮真实Node HTTP53/53、相关契约10/10、构建/边界/共享类型检查通过；
Bun同组53/53通过。最终WebKit播放基准12/12通过，原阈值未改变，报告位于
`.run/quality-convergence/final-playback-bench.json`；不据本机结果抹除历史云端负例。

#112收敛前的完整原文保存在 [历史快照](history/roadmap-112-before-convergence.md)，
含各批合入、失败、限制与未验证声明。远端overview改为当前能力与候选状态，
保留原架构、依赖、验收和后置计算节点目标，不把未合入的候选写成main能力。
最终干净包、三平台和完整CI结果以PR #161的精确提交检查为准；此处阶段日志
只记录当时已执行证据，不将待运行检查写成通过。


## 阶段十二：核对收敛状态与完整保留历史

#113–#123 的当前状态已逐项核对，区分 main 已有能力、PR #161 的候选修复与
尚未完成的原范围。旧正文完整保留在历史折叠区，不删除原要求、失败记录或
扩大保证；子项保持开放。#112不再用不断叠加的旧进度充当当前能力说明。
最终交付记录明确代码提交、干净包和实际验证平台；未运行检查不写成通过。

最后复查发现 CAMBI 已不写原始 YUV，但仍保留旧 native 的整片 raw 加六份
FSIZE 预留。四帧640×352的热图为2,400,640字节，加32MiB结果上限应预留
35,955,072字节，旧逻辑只算输出就预留201,326,592字节。新增负例在旧实现
确定性失败；新预算只计五尺度实际热图与有界结果，累计像素工作另行限额。
新结果标记 `streamed-heatmap-and-result-v1`；旧结果/预算不重写。
Node/Bun真实HTTP各18/18通过，包括8/10-bit四帧在40MiB预算下完成且官方
热图hash不变；存储预算差一字节、热图和累计像素超额继续拒绝。
CAMBI真实生命周期/重执行20/20、定向契约及构建通过。


## 最终交付索引

- Web PR：[#161](https://github.com/Nakiha/VoidPlayer-Web/pull/161)；core PR：
  [#14](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/pull/14)。两者没有自动合入。
- 上游代码 `19e755f65003750873f88587369f3a1f340e14c1` 的 analysis 和
  playback/packet ABI 两项检查通过；Web固定该已推送产物来源。
- Web最终代码 `9c384de` 的本机干净包通过完整 installed quality 和 release
  契约；contract再次43/43。CAMBI最终预算变更单独通过Node/Bun HTTP各18/18、
  物理生命周期/重执行20/20。早先更大矩阵及失败信息见相应阶段。
- 三平台与完整远端矩阵必须核对PR当前提交，不能沿用已取消或较旧提交的绿色
  状态。检查运行中的状态不写入静态完成声明，最终结果随PR检查和交付说明提供。
- #112和11个子项保留完整原要求与历史记录；本轮不关闭HDR/VFR、自动对齐、
  主观校准、其他NR模型和分布式等后续范围。


## 阶段十四：Windows 崩溃恢复与三平台验收调度

精确提交2e4be84的Windows日志出现4个同根失败：测试假设自杀SIGKILL必返回
POSIX signalCode，而Windows返回非零exitCode和null signalCode。真实进程
仍被强制结束。共享断言按平台核验非零退出或SIGKILL；事务前后marker、回滚、
重启后interrupted、原键重放及唯一后继的真实数据库断言均保留，CAMBI也补齐
同样退出核验。不把普通成功退出作为故障、不跳过Windows用例。
Node/Bun真实进程重执行各20/20、本地构建和发布流水线契约20/20通过。

同次Windows Node阶段实际耗时约14分钟，原先它与38项Bun套件及包内验收
共用20分钟总限时。扩展原Linux独立运行时job为三平台×Node/Bun矩阵，包内
验收单独执行；每个平台仍运行Node24项/Bun38项，单项及job限时不扩大。
六个运行时组合与三个包都必须成功，release-set才可汇总。删去已经无效的
Linux原生组件“安装”空步骤，以及被完整TAP日志替代的测量单例诊断重跑。

2e4be84的云端配对播放报告配置有效但16/16未达阈值：baseline/feature各8次。
单轨速度分别0.702–0.741× / 0.737–0.752×，双轨0.460–0.475× /
0.458–0.472×且两边都有stall；本机12/12不能替代此结果，不声称根因已修。
[原始CI报告](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40958151136/job/123744275115)
保留于PR，下载副本在 `.run/quality-convergence/final-paired-performance.zip`。

## 阶段十五：同步 VMAF 界面断言与 CI 取证完整性

69dcf5b 的三平台独立包、六个运行时组合、完整 HEVC 时间轴及其余功能检查
通过；标注/缓存综合套件66/70，四个失败来自 Chromium/WebKit × 8/10-bit
VMAF 浏览器测试还匹配旧提示 `neither spatial heatmaps`。实际任务已完成，
当前界面明确说整帧/区域分数不是热图或人工缺陷判断。测试同步同一语义，
不删除解释性提示断言；四组重新跑完提交、冻结重放、候选、独立原帧与播放
隔离，均通过。发布流水线契约20/20通过，产品评分和UI实现未变。

失败取证同时发现混合绝对/tmp截图和工作区路径的artifact只有截图，没有
列出的.run报告目录。按 [upload-artifact v4 的隐藏文件规则](https://github.com/actions/upload-artifact/blob/v4/README.md#uploading-hidden-files)
为这个明确列举测试报告的artifact启用include-hidden-files，并由契约锁定；
不扩展到整个工作区。原始失败日志保存于
`.run/quality-convergence/cache-failure-69.log`，旧artifact截图保留于同目录ZIP。


## 阶段十六：给完整 XPSNR 序列验收独立执行边界

b85c9a2 的 Windows Node 套件23/24通过；XPSNR HTTP文件前22个子用例
通过，最后一个HEVC10连续192帧已完成两次评分，在比较尾页读取时撞到整个
文件180秒总限时。此前增加的六个有理时钟/ROI/长序列用例与17个基础HTTP
用例共用旧总限时，成为随机器波动出现的边界失败。

将六个序列用例原样迁移到独立媒体测试文件，并同时登记Node/Bun和三平台
清单；基础17项和序列6项全部保留，评分、证据、比较与末帧断言不删减。
两组仍各受180秒文件限时，子用例及20分钟job限时不扩大。运行时清单因此
变为Node25项/Bun39项，发布契约锁定两组都必须执行。
本机两组Node/Bun各23/23、完整contract43/43和构建通过。最终Windows
结果继续以当前PR提交的CI为准，历史超时不是通过记录。
[原始失败日志](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40966392542/job/123772157072)。


## 阶段十七：清除渐进发现入口的过期准入说明

最终逐入口核对发现，专门评分指南已更新，但媒体发现字典、源准备指南和
任务目录仍宣称Linux原生组件/整数微秒时钟，恢复提示也仍写Native XPSNR。
新增契约在旧内容上确定性失败（explicitly installed Linux x64 component）。
当前入口统一说明既有分析WASM、原始ticks/timebase有理比较、微秒投影、
指标各自的ROI/区间准入；对应计划的机器可读说明也不再暗示按舍入微秒匹配。
缺组件恢复仍保留原指标及对应capability链接，历史schema/结果字段不重命名。
可信MP4文档移除与顶部更新相矛盾的旧时钟要求，并明确标记初始验收历史。

Agent HTTP8/8、实际无浏览器工作流9/9、快速82/82、XPSNR基础HTTP Node/Bun
各17/17、构建、共享类型及模块边界通过。改动是公开能力/恢复说明与错误文案，
不改变评分算法、帧选择或历史记录；最终完整CI继续验证当前提交。


## 阶段十八：消除包内验收的嵌套总限时

8dfc4f6的Windows包内基础发现/MP4、VMAF/CAMBI官方分数与五尺度热图、
XPSNR各容器矩阵全部通过后，重执行仍在运行时被旧release-quality的120秒
总限时截断。它串行嵌入三个已各自登记为180/180/120秒的验收脚本，却没有
应用这些边界。独立日志已证明这是外层调度截止，不能记作完整包验收通过。

注册入口release-quality改为只跑基础组；analysis-quality、XPSNR和重执行
在三平台发布CI中各执行一次，也加入完整release套件。四项仍全部required，
原120/180/180/120秒单项限时和20分钟job限时保留。兼容直接调用
check-quality-release.mjs默认仍运行完整流程，--base-only仅供登记入口拆组。
发布契约校验四项均在每个平台必跑、预算不变，无删减断言或静默跳过。
使用9c384de的已验证干净macOS包复验新调度4/4通过，完整contract43/43、
发布流水线契约20/20通过。当前产品提交的三平台结论仍由最终CI提供。
[原始Windows截止日志](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40969990215/job/123784984672)。


## 阶段十九：原生帧协议矩阵复用受控浏览器页面

fd73779的评分/缓存综合套件69/70；唯一失败是WebKit原生帧协议矩阵在
反复创建上下文后，后续空白测试页goto等待load超过30秒，尚未进入该项
解码断言。原始日志没有给出浏览器底层根因，不能将其声明为已诊断的引擎
缺陷。同次独立多页面暂停帧诊断已通过（52.7秒）。完整本地npm test222/222、
三平台包、六组运行时、媒体Node和完整HEVC时间轴均已通过。

协议矩阵使用一个明确拥有的context/page，只导航一次。每项仍新建实际
解码器、源帧和presenter并显式释放；相邻项及最终检查canvas已清空。全部
条码、AU、重排/排空、负/重复时钟、多图像与场编码断言保留，不重试或延长
超时。context与Vite由共同cleanup管理，失败也逐项释放并保留原错误。
Chromium/WebKit各16项完成；WebKit H264/HEVC8/10实际执行，Chromium
仍仅允许原有明确的HEVC不可用结果。完整contract43/43通过。Linux结果
须由当前提交CI再次确认；并未据本机通过推断浏览器底层根因已修。
[原始失败日志](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40980442675/job/123819068459)，
本地副本`.run/quality-convergence/cache-failure-fd73779.log`。


## 阶段二十：移除 GitHub CI 性能测量

按用户要求，云端共享 runner 不再承担性能验收。删除 PR base/候选配对
HTTPS 性能 job、独立播放基准步骤、FLV 性能摘要和对应 CI 套件入口；
删除已无调用的虚拟 runner 性能豁免策略。旧性能报告仍是历史负面证据，
本次改变验收职责，不将旧结果改写为性能修复或通过。

FLV、Range、参考 FLV、HDR、分析矩阵在 GitHub Actions 中不调用基准，
改用已有严格呈现证明，验证实际帧推进、源/帧身份、播放错误和暂停稳定性。
HTTPS 功能流程继续三轮双轨真实播放、队列容量、Worker 释放及资源回收检查，
不输出速度或性能结论。功能等待期限和原逐帧/seek/尾帧断言保留。
本机基准命令与阈值保留；VOIDPLAYER_FUNCTIONAL_ONLY=1 可复现 CI 功能模式。

本机新功能路径7/7浏览器用例通过（双引擎FLV/启动、Range、参考FLV、HDR），
Chromium/WebKit MP4分析矩阵2/2（合计24组合）通过；报告无benchmark结果，
严格呈现和暂停证明存在。完整contract43/43、定向契约92/92、构建通过。
可信HTTPS证书功能路径及三平台完整验收仍由本提交CI给出实际结论。


## 阶段二十一：音频测试拦截请求有明确的生命周期

阶段二十CI的音频套件12/13通过，TS本地输入在Playwright route.fetch读取
插桩Worker时ECONNRESET，异步路由异常逃逸为未处理拒绝，未给出音频数值
或输出断言失败。原始报告保存在`.run/quality-convergence/stage20-audio.zip`。
底层连接重置原因尚未证实；本次修正测试资源所有权，不声明播放器故障已修。

页面关闭与服务清理前等待已接管的路由结束；路由异常进入失败证据并继续
使测试失败。清理逐项执行，保留最初异常。仍通过服务读取原Worker响应，
保留原响应头、插桩、音频输出、同步停止与零额外媒体IO全部断言。
原实现本机完整音频13/13通过；修正后FLV及TS本地输入2/2通过。停止为
追求每次提交的全量CI绿色重复扩大复测范围，后续CI职责整改独立进行。
