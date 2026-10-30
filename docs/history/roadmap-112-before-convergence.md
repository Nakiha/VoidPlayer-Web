# #112 收敛前的原始进度记录

取自 https://github.com/Nakiha/VoidPlayer-Web/issues/112 ，最后更新 2026-10-29T17:44:48Z。
本文是历史快照，不描述当前可用能力。当前实现和验收见 ../quality-convergence.md。
原有失败、未验证范围与每次合入证据均原样保留。

目标：Agent 可以独立从媒体库找片、读取可解释的元数据/索引、选择参考对或 NR 单源、提交评分并创建带证据的标注；GUI 能收到操作、进度和结果，用户可以查看与管理。

<!-- voidplayer-pr160-progress:start -->
## PR #160：已有本机页面临时授权独立 stdio Agent 已合入（2026-10-29）

[PR #160](https://github.com/Nakiha/VoidPlayer-Web/pull/160) 已合入 main [d495ec517938862e6b5dac99d6f6657e87d3ee95](https://github.com/Nakiha/VoidPlayer-Web/commit/d495ec517938862e6b5dac99d6f6657e87d3ee95)。已审 head `efb2824023d506f50cb511b682f9a053ddc71127` 是 main 祖先；合入 tree `bd506d1ba7b8b38464cc31e080128781aeb92f9f` 与已审候选一致。

- 用户可在早已打开、持有本地 File/轨道/ROI 的普通 VoidPlayer 页面显式连接独立 stdio Agent：CLI 使用 `--existing-origin <准确 loopback origin>` 发起有界请求，在指定顶层页面输入公开单次匹配信息、核对准确页面/工作区和自述客户端，再分别授予 read/view/annotate。保留原 File、轨道和已有标注；复用五项白名单、session facade、epoch/correlation 与未知写回执，不重开页面或重选 File。
- 匹配信息本身没有授权能力；独立 CLI/文档/grant 凭据仅存内存。配对90秒单次消费、文档池有界、授权最长15分钟；撤销、到期、重载、换源/身份、关页或 EOF 使旧授权失效。仅 view/annotate 返回最小回执，不能借视图操作读取完整状态。保持准确 Host/Origin、真实 peer 与顶层文档限制；CLI 退出仅断桥，原服务与后台评分继续。
- 精确候选的 [PR full](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40893147329) 与 [identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40893147297) 成功：38项检查为37成功、1项预期非tag跳过；普通独立产品及增量复核通过。已有页面真实独立 stdio/GUI 46项、旧桥38项、协议/Agent/实际 HTTP 评分22项通过，H2648/HEVC8/HEVC10 后台评分在桥接 EOF 后仍完成；父独立 Chromium/WebKit 顶栏各3项通过，保留固定视口、无溢出、可达及稳定性检查。

本包已有页面 stdio 闭环的直接支持证据限 Linux Chromium/Node 源码入口；macOS/WebKit/Bun/原生发布包的该入口未据三平台常规 CI 冒称独立认证。更多宿主/工具覆盖、安装产品化、其他 NR/指标评估与后置分布式算力继续按 roadmap 推进；#112/#117 及更广验收保持开放。盲测仍暂停，云端播放性能仍为信息项，历史负结果保留；未发布版本或标签，未跟踪 main CI。见[固定合入指南](https://github.com/Nakiha/VoidPlayer-Web/blob/d495ec517938862e6b5dac99d6f6657e87d3ee95/docs/local-mcp-page-bridge.md)。
<!-- voidplayer-pr160-progress:end -->

<!-- voidplayer-pr159-progress:start -->
## PR #159：XPSNR 同参考版本比较 GUI 已合入（2026-10-29）

[PR #159](https://github.com/Nakiha/VoidPlayer-Web/pull/159) 已合入 main [ae0743b177e086f2429e3acce7f80e868bf93e5d](https://github.com/Nakiha/VoidPlayer-Web/commit/ae0743b177e086f2429e3acce7f80e868bf93e5d)。已审 head `6f6548f92b383502292a29eacd6e423ce71a8516` 是 main 祖先；合入 tree `c22278b5fabb6012efe34da5e9607cf44aad3ced` 与候选一致。

- 比较同一冻结参考片段的2–4个已完成版本，展示官方 Y/U/V 池化、minimum 和明确的客观排序；按共同参考呈现顺序分页显示逐帧 XPSNR、伴随 PSNR、已请求 SSIM 与两侧实际 AU/PTS。Infinity 与未请求 SSIM 分别显示，不混成总分或按相近时间拼接。
- 选择按 actor 保存；刷新、分页和原帧返回均重核 job/attempt/digest/domain。缺少选中版本、回收/变化结果、缺帧或无效已请求 SSIM 拒绝整组并清空旧分数。可进入原任务、已有候选与独立原帧 viewer，再返回固定比较上下文；不自动计算、重算或发布候选，不移动当前播放。
- 精确候选的 [PR full](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40838201743) 与 [identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40838201646) 成功，38个检查为37成功、1项预期 tag-only 跳过；正常代码审查完成。见[比较与查看契约](https://github.com/Nakiha/VoidPlayer-Web/blob/6f6548f92b383502292a29eacd6e423ce71a8516/docs/xpsnr-comparison.md)。

原生计算仍限现有可选 Linux x64 固定组件及严格 FLV/MP4、连续短序列、同几何/位深、整帧 limited BT.709 SDR 支持域。参考关系不等于内容认证；reference integrity 未认证、concealment detection 不可用，既有 stat-witness 证据边界保留。未做主观盲测，不宣称感知优越或已认证主观排序。云端播放性能仅作信息诊断，历史原始结果保留。更多输入域、平台与无参考模型评估仍待，#112/#118 及原验收清单保持开放；未发布版本或标签。
<!-- voidplayer-pr159-progress:end -->

<!-- voidplayer-pr158-progress:start -->
### PR #158：CAMBI 显式重算与任务中心追溯已合入（2026-10-28 UTC）

[PR #158](https://github.com/Nakiha/VoidPlayer-Web/pull/158) 已合入 main `a5c8b09da44efe426c840304aefc5077123ee4f1`；精确候选 `f229a5415bd92b4a15eb9f1a558faf1b39599dd2`，tree `c318825a317bec2ae7e806b65fb7543627117552` 与普通独立复核、CI 测试合并及实际 main 一致，已核实候选为 main 祖先。

CAMBI 现在复用显式费用确认、原子回执和唯一后继：仅物理停止的 failed/interrupted/cancelled 且有完整执行见证的任务可从头新算，不新增 partial。单源见证保存 source/version、cache namespace/build、producer/core、实际 AU/configuration/PTS/解码排序与覆盖摘要、固定 native 组件及 recipe，不虚构参考源或 C 计划。缺少历史见证或来源/缓存/组件/选择漂移明确拒绝同条件重算，需新建意图；不自动建索引、复用旧分数或发布候选。

HTTP、Agent 自描述、CAMBI 页面和任务中心共用同一命令与追溯。原提交键仍只重放原任务；重算回执先于依赖来源/结果检查查询，双窗口及丢回执不分叉。旧证据与候选不替换，新候选仍需显式发布；关闭观察不取消工作，Worker/native/文件物理退出后才释放容量。预检单独计费，完整费用包括累计读盘/包数、三次执行见证读取、raw/五尺度总输出、内存/时间及持久元数据预留，沿用原预算。

最终 [full40722419215 attempt2](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40722419215/attempts/2) 成功（36 success、1正常非tag skip），[identity40722419187](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40722419187) 成功。源码160/160、媒体58/58、Linux Node24/24与Bun37/37、三平台独立包、required 浏览器与平台汇总通过。真实 CAMBI HTTP/生命周期、双引擎任务链及空 PATH installed compiled Bun 的 FLV8/10和严格 MP4三组合验证官方逐帧/池化分数、五尺度字节、取消物理退出、事务提交前后崩溃恢复、丢回执及显式新候选。

首轮远端 HEVC 时间轴在两轮各600帧检查后、末尾 seek 未收齐时触发30分钟总限时；只原样恢复该 job 及依赖汇总一次后成功（约906秒），其它成功结果沿用。没有删帧、放宽像素/Range/seek断言、增加预算或改 workflow；不称主机吞吐根因已修。合入前修正的旧能力断言和观察收尾保留严格错误报告及真实 CORS 负控，历史远端错误的全部因果仍未确证。

支持域仍为 Linux x64 固定组件、可信 FLV/Enhanced FLV 与严格 MP4、8/10-bit SDR 和原几何/有界选帧限制，不扩大 HDR、任意时钟/容器、GPU或分布式。未认证的是码流参考图片图谱完整性，concealment 检测不可用；候选 frame/scale/region/source/table/producer 引用继续严格核验。更多平台、其他 NR 指标和代表性误报/漏报评估仍待，#112/#121/#116 保持 open。云端播放性能仅信息项，既有未达标记录保留。未发布版本/标签，未跟踪 main CI。协议见[固定提交文档](https://github.com/Nakiha/VoidPlayer-Web/blob/a5c8b09da44efe426c840304aefc5077123ee4f1/docs/explicit-quality-reexecution.md#single-source-cambi-extension)。

下方旧批次记录保留当时边界；当前 CAMBI 显式重算能力以本节为准。
<!-- voidplayer-pr158-progress:end -->

<!-- voidplayer-pr157-progress:start -->
### PR #157：CAMBI 严格 MP4 完整闭环已合入（2026-10-28 UTC）

[PR #157](https://github.com/Nakiha/VoidPlayer-Web/pull/157) 已正常合入 main `cb3bad5ecbccaba56e4aef09fd7179d7535e3812`；精确候选 `3931fba55f89bc256351eb96db04cfee904db458`、tree `1ef7acef43b48cfd5c5fa05d3e88c95abffd1a0e` 与独立审查及实际合并一致。

本批补齐 CAMBI 的严格 MP4 单源支持：发现选片/显式准备 → 有界区间与 AU 抽样 → 持久任务 → 分数/覆盖/最差帧 → 官方五尺度与原始源帧查看 → 显式共享候选。GUI、HTTP/Agent 和任务中心消费同一事实，不要求 C 参考关系；不依赖扩展名或元数据可读性准入。复用已提交 MP4 producer/sample-table 和现有 packet-identity 解码，先显式按 decode-AU 抽样，再按精确 source PTS 写入 native 帧，保留非零时钟、重排/drain 与 sample/track/ticks/table 见证。MP4 result/attachment 使用 v2，旧 FLV v1 保持兼容。

仍限可安装 Linux x64 的固定 Netflix/vmaf v3.0.0 组件；严格自包含非 fragmented、单视频/单描述 MP4 avc1 H2648 或 hvc1 HEVC8/10，原始 limited BT.709 SDR YUV420、精确恒定时钟、方形像素、不裁剪/旋转及既有预算。没有扩大 HDR、任意 VFR/负 PTS 认证、其他容器、分布式或新模型。未认证的是码流参考图片图谱完整性，concealment 检测不可用；job/attempt/digest、完整 frame/scale/region/source/table/producer 和原始像素/热图 hash 仍严格核验，变化或缺失明确拒绝。分数与区域仍是未校准 banding 线索/真实热图统计，不是主观合格线或裁剪重算。

最终精确 head 的 [full40673199191](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40673199191) attempt1 成功（34 success、1预期 tag skip），[identity40673199186](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40673199186) 成功；三平台独立包、required 缓存/质量浏览器套件及平台汇总通过。本地 Node/Bun MP4 各7项、六条 Chromium/WebKit × 三种 codec/depth GUI、空 PATH compiled Bun 的 FLV8/10 与 MP4三组合、官方逐帧/池化和五尺度字节对照、来源/证据改变与取消物理退出均有实测。首轮打包检查的过时能力断言已修正并由最终三平台检查验证；没有降低断言/预算或改 CI 结构。

更多平台/容器、HDR、任意时钟/几何、其他代理指标迁移及更广代表性误报/漏报评估仍待。云端播放性能继续仅 informational，既有16/16未达标记录保留，不据功能绿色认定性能达标或感知优越；历史浏览器 watchdog/access-control 根因未全确证，不宣称本批根治。#116 与整体 roadmap 保持 open，未发布版本/标签，未跟踪 main CI。契约见[固定提交文档](https://github.com/Nakiha/VoidPlayer-Web/blob/cb3bad5ecbccaba56e4aef09fd7179d7535e3812/docs/native-cambi.md)。

下方 PR #149 记录保留其 FLV 首批合入当时的验收边界，当前 CAMBI 支持以本节及 #116 最新正文为准。
<!-- voidplayer-pr157-progress:end -->

<!-- voidplayer-pr149-progress:start -->
### PR #149：CAMBI 单源无参考筛查完整链路已合入（2026-10-28 UTC）

- [PR #149](https://github.com/Nakiha/VoidPlayer-Web/pull/149) 已合入 main `f88fb6375bb53fd51d83a36b24ec2cb759ccc7df`；候选 `13f41ade4a259a54e8915bb5a601a47183dfdf1a`，tree `e0cb24dc717de5a787f93b7b58014282a8c129a7` 与独立复核及实际合并一致。该完整功能包保留现有任务中心、XPSNR 与严格 MP4/mixed VMAF，没有另拆接口/按钮/文档 PR。
- #116 首批 CAMBI 已贯通：技术发现选单源 → 显式有界区间/抽样 → 持久评分 → 逐帧/覆盖/最差摘要 → 官方五尺度热图与原始源帧复核 → 显式共享空间候选。GUI/HTTP/Agent 共用事实，不要求参考关系、C 计划、打开页面或播放游标；关闭观察不取消后台任务。统一任务中心加入 `kind=cambi`/`metric=cambi`，按单源 ID/version 筛选、真实进度/结果回收、原服务取消及完整 ref 核验后的候选查看，查询不读热图像素。Agent 渐进入口为 `/api/agent/tasks/quality.cambi` 和 `/agent/quality/cambi.md`。
- 首批仍限可安装 Linux x64 固定官方 v3.0.0 组件、可信 FLV/Enhanced FLV H264/HEVC8/10 limited BT.709 SDR YUV420、明确几何与256区间 AU/32选定图片；不继承其他指标的 MP4 准入。五尺度真实灰度证据有帧身份/hash/布局/源坐标映射，区域统计不是裁剪重算或目标跟踪。高分表示更多 banding 线索，不是主观合格线；缺结果、未完成、unsupported 与零分分开，物理退出后才释放共享容量。
- 精确候选普通独立 review 无阻塞，[full40661810704](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40661810704) attempt1 成功（34 success、1预期 tag skip），[identity40661810716](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40661810716) 成功；全部36个 checks 无 pending/failure。源码159/159、媒体 Node58/58、三平台包与 required PR cache 通过。双引擎8/10 GUI、本地 compiled Bun 空 PATH 的官方 CAMBI逐帧/池化/五尺度字节对照及原有 FLV/MP4/mixed VMAF 回归有实测记录，见[固定提交技术说明](https://github.com/Nakiha/VoidPlayer-Web/blob/f88fb6375bb53fd51d83a36b24ec2cb759ccc7df/docs/native-cambi.md)。
- #116 的首批 CAMBI 功能已交付，但更多平台/容器、HDR、负 PTS/VFR 认证、其他代理指标迁移及更广误报/漏报评估仍待；#116 和整体 roadmap 保持 open。reference integrity 未认证、concealment detection unavailable。历史 access-control/watchdog 根因未全确证，不把新 CI 绿色称为根治；云端播放性能仅 informational，保留16/16未达标记录，不作为可靠合入强门槛或回归证据。不发布版本/标签，不继续跟踪 main CI。

以下早期阶段记录保留当时的验收边界；当前 CAMBI 状态以上述已合入批次及 #116 最新正文为准。
<!-- voidplayer-pr149-progress:end -->

<!-- voidplayer-pr144-progress:start -->
### PR #144：受限 WebCodecs 暂停帧直接 ROI 闭环（已合入；按用户要求暂停 main 跟踪，2026-10-26 UTC）

- [PR #144](https://github.com/Nakiha/VoidPlayer-Web/pull/144) 已合入 main `012fac08dafea5caf3acd0056a895535f69bd2b8`，parents 为原 `7c399ad05ad381c9df9e9713be98d5292ed9fd65` 与已审候选 `aefcdf2cb27bbc01c0416c2bec482440ae91cc3c`；tree `96ffd18b06f230b53295041c6f0ad7d963beb103` 与独立复核及候选一致。一个完整 Web 功能批次，无 core/fork 改动，未发布版本、标签或 Release。
- “测量暂停画面”读取实际成功呈现的原生 FLV 单图输入见证，经同 epoch 唯一受理记录、实际固定版本传输、配置完整字节、AU/包 offset/size/源 PTS/DTS 与可信 cache namespace/build 精确连接，进入已有独立原始帧 ROI → PSNR/可选 SSIM/grid → 原子共享未人工判断候选 → 原帧复核。不是 PTS 搜索、旧 token 升级或屏幕转换像素评分；手选 AU 和无 GUI HTTP Agent 入口继续独立可用。
- 缺缓存仅提供独立显式 `POST /api/media/{id}/psnr-index`：64MiB 来源、128MiB 实际读取、包/索引限额、256MiB heap、30秒执行取消 deadline。复用受控 Node/Bun Worker，真实文件关闭和 Worker 退出前不放准入；取消与 commit 竞争可留下有效缓存，需重读。只读发现/评分不自动建索引、不清除 untrusted 缓存；普通 FLV 载入的原索引策略不在本批重写。这不是 durable build 子任务或通用资源管理。
- 最终候选 [full40271207834 attempt1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40271207834) 成功（33 success、1预期tag skip），[identity40271207742](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40271207742) 成功；source145/145、媒体49/49、ci-cache19/19、新暂停帧 Chromium/WebKit 两项、既有标注/查看四组、三平台实际编译包和平台汇总通过。父任务完整与测试增量独立复核无阻断；同时间戳跨 reset 换像素、原始帧/FFprobe AU 对照及拒绝矩阵另有独立实证。
- 按用户 2026-10-26 的明确要求，暂停 main CI 跟踪、等待与主动修复，不取消远端运行、不改 workflow 或分支规则。最后观察：实际 main [identity40275336118](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40275336118) 成功；[full40275336113](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40275336113) 尚未终态（06:12 UTC 为30成功、1运行、1跳过，最终汇总尚未生成），之后未继续跟踪，不宣称合入后全绿。本批以已通过的最终精确 PR SHA 完整 CI 与独立审查完成交付；后续 PR 保留同样门槛。
- 仍限可信完整单配置 FLV/Enhanced FLV、实际平台支持的 H.264/HEVC 原始 VideoSample 及既有每侧32 AU/颜色/预算边界。WASM 播放、CPU转换资源、其他容器、未知/多图/字段/重复时钟/旧epoch、不支持 profile、非精确方形 SAR/crop/旋转均不自动升级。stat 不是内容认证，`referenceIntegrity=not-certified`、`concealmentDetection=unavailable` 保持；区间/更广容器/几何、VMAF/NR、无人值守评分发布和分布式未交付，整体 issue 保持 open、总验收不勾完。
- 性能仍未达标：新候选配对 configurationValid=true、16样本8失败（baseline/feature各4/8）、passed=false；小型720p同解码器成本门槛通过不替代完整性能验收。旧 observer 300秒挂起究竟在 numeric waiter 或 rAF 负控收尾仍未确定；测试现用宿主50ms读取同谓词与真实帧推进，保留750ms负控/恢复正控和300秒上限，不重试或吞错。独立复核曾有并发WebKit viewer加载超时、隔离通过，根因仍未证明；本轮CI成功不据此宣称历史根因已修复。见[契约与证据](https://github.com/Nakiha/VoidPlayer-Web/blob/012fac08dafea5caf3acd0056a895535f69bd2b8/docs/paused-native-quality.md)。
<!-- voidplayer-pr144-progress:end -->

**GUI 与 Agent 调用同一套业务能力。业务执行不依赖页面打开、当前播放位置、选中轨道或渲染确认；GUI 是业务状态的消费者和操作入口。** 本 issue 维护范围、顺序与依赖。首批基础链路、缓存查询、受限单帧 PSNR 的数值/一次性/持久任务链路及 GUI 发起/任务管理、结果挂现有标注、精确原帧对/ROI 只读查看及受限 PSNR 分块证据、显式可选 SSIM、有界前向及闭合 GOP 重排/延迟输出的完整测量/证据/查看批次已合入；自动评分造标注与更广算法/证据闭环仍待交付，当前进度与 PR 见文末。

## 架构前提

- 共享的是无宿主依赖的领域契约、校验和行为；浏览器 ReviewSession 与服务端 HTTP/MCP 是不同适配器。实施时同步 AGENTS.md/architecture 的相关表述，既不复制一套 Agent 业务，也不要求后台实例化 GUI。
- 持久业务状态、后台任务/执行状态与窗口播放/焦点/viewport 分开。任务通过明确来源版本、流/帧/区间和 ROI 定位，能力不受当前可见轨道数限制。
- 操作事件/修订快照同步给 GUI 与 Agent；GUI 断线、慢消费或渲染失败不阻塞后台工作。重连可恢复进度、结果与标注。
- 后台分析默认不抢焦点或跳转；需要在特定窗口展示/seek/focus 时使用独立视图命令。浏览器本地 File 仍受实际宿主生命周期约束，服务端媒体库任务完全独立。

## 推荐推进顺序

| 阶段 | 工作 | 完成门槛 |
| --- | --- | --- |
| 1 | #119 业务/GUI 解耦；#113 渐进式发现与指南 | 无浏览器业务入口与可恢复的 GUI 状态同步；真实能力可发现 |
| 2 | #120 自解释媒体信息与索引查询 | Agent 可搜索、筛选和理解来源/覆盖/时间轴 |
| 3 | #114 PSNR/SSIM；#121 持久评分服务；#115 证据标注 | 无 GUI 提交、可追溯、可管理并发，GUI 可复核的基础闭环 |
| 4 | #122 VMAF；#116 CAMBI/NR 区间筛查 | 明确的全参考与无参考后台评分能力 |
| 5 | #117 可选浏览器桥接；#118 进阶指标/模型评估 | 按需增强，不作为后台自主评分前提 |
| 后期 | #123 计算节点与内网 HTTP 拉取 | 单机闭环稳定后扩展集群算力，不阻塞基础版本 |

这是产品交付顺序；共享契约明确后可并行实现和局部验收，最终按完整可用户验收功能批次组织候选，接口、GUI、测试和文档同批收敛。不为开关、小接线或测试配置分别滚动开小 PR 等待全 CI；只有独立风险或紧急修复才拆分。

## 跟踪清单

- [ ] #119 refactor(agent): 解耦 GUI 状态的业务命令与操作事件同步
- [ ] #113 feat(agent): 渐进式能力发现、HTTP 任务指南与可恢复反馈
- [ ] #120 feat(library): 面向 Agent 的自解释媒体元数据、索引查询与选片
- [ ] #114 feat(quality): 可信帧对与 ROI 的 PSNR/SSIM 测量及分块证据
- [ ] #121 feat(quality): 持久评分任务、触发追溯与服务端并发管理
- [ ] #115 feat(review): 将画质测量与空间证据挂接到框选标注
- [ ] #122 feat(quality): 接入服务端全参考 VMAF 与可复现评分结果
- [ ] #116 feat(quality): CAMBI 色带检测、区间筛查与候选标注
- [ ] #117 feat(agent): 本机 MCP 桥接与浏览器会话连接
- [ ] #118 research(quality): 评估 XPSNR 与无参考感知模型的可选接入
- [ ] #123 feat(compute): 后期接入计算节点，以内网 HTTP 拉取扩展评分算力

## 关键依赖

- #119 与 #113 协同定义共享业务/能力边界；#120 提供媒体信息和索引语义。
- #114 负责真实像素及 PSNR/SSIM；#121 负责持久任务、触发历史、资源准入与后台管理，二者按契约对接。
- #115 关联来源/帧/ROI/算法条件与 job/result；#122、#116 复用同一任务及测量附件。
- #117 仅承接浏览器宿主和视图能力；#118 的研究不阻塞 VMAF，因为 VMAF 已有 #122 明确交付。
- #123 依赖 #121 的稳定执行器/任务协议；首期按完整评分任务分派到节点，不先做单视频跨节点切分。

## 端到端验收目标

- Agent 无需浏览器，从媒体库检索 → 获取可自解释技术信息/索引 → 确定来源与对齐方案 → 提交 FR/NR 评分 → 读取进度/历史/结果 → 留下可复核标注。
- GUI 正在播放 A 时，Agent 可分析 B/C，GUI 展示操作与结果而 A 的播放位置不变；GUI 完全关闭后后台作业仍继续，重新打开能恢复状态。
- 后台记录提交者/Agent 来源、输入版本、参数/模型、执行 attempt、进度、错误、结果、取消/重试及并发设置变更。幂等/缓存命中/共享计算保持各自归因。
- 自解释数据包含 schema/字段含义、单位、时间轴、粒度、来源与缺失/估计状态；相同文件名/时长不能自动证明是正确参考对。
- 并发、队列与内部线程/内存/GPU/输入读取预算联合生效，Agent 不能通过重复请求绕过上限。

## 后期算力与数据访问选择

测试集群内网带宽充足，#123 默认采用媒体服务器提供原始字节/Range、计算节点主动 HTTP 拉取、连续预取与有界缓存，支持边读边算。共享挂载和落盘缓存属于可选优化，由源服务器压力、重复读取和实际收益决定；首期不需要 NAS、对象存储或新的传输协议。

## 延续的工程边界

- 承接已完成的 #46、#56、#99；基线 main `b2b5da9924aa8f0c9f0948be5cc6168bd6a7a019`。播放与分析分离，来源身份准确，摘要/精确数据分开且资源有界。
- 本地文件不隐式上传，浏览器日志保持现有显式处理。后台任务业务记录不等于上传浏览器日志。
- 省重建码流结果不能冒充评分像素，SDR 截图不能冒充原始 HDR。缺陷候选、主观校准评分和实际空间证据分别表达。
- 本体 [PR #19](https://github.com/Nakiha/VoidPlayer/pull/19) / [PR #20](https://github.com/Nakiha/VoidPlayer/pull/20) 的五类代理指标、分块和标注可作参考；迁移仍需验证位深、精度及宿主支持。
- 各项独立验收，性能以同条件实测为准，不把“内网很快”当作源盘/HTTP/计算端无瓶颈的证明。

## 实施进度（更新至 2026-10-26，UTC）

<!-- voidplayer-pr142-progress:start -->
### PR #142 + core #13：闭合 GOP 重排/延迟输出的完整身份批次（已合入；Web合入后功能验证通过）

- [Web #142](https://github.com/Nakiha/VoidPlayer-Web/pull/142) 与 [core #13](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/pull/13) 已合入。GUI/HTTP Agent 从同一已有可信缓存明确选择目标 AU、实际源 PTS 与完整闭合窗口，提交同一持久任务，得到 PSNR/显式 SSIM/网格，显式挂已有标注并打开独立原帧/ROI 查看；不是只交付底层 ABI。普通播放不参与取帧，关窗不取消后台执行，不自动配对、建索引或造标注。
- 新模式 `decode:{mode:'packet-identity-gop-v1',startAu,endAu}` 的两端均包含，目标 AU 独立指定。实际闭合 IDR 起点到经字节验证的下个闭合 IDR 边界或完整来源 EOF，每侧最多32 AU；全部输入/输出（含目标之后及 drain）计费，整对输入最多64、输出最多64。固定 packet identity ABI1 将 opaque/token、上下文 generation、原输入时钟/字节数/负载 FNV 见证绑定到输出；从 token 选择目标，不按 PTS 猜归属。未知/重复/缺失/错误/字段输出拒绝，仍不认证引用图或内容。
- **零 CTS 不能证明立即输出。** 独立复核发现并修复了候选选择遗漏：完整有界 GOP 现在优先显式 token 模式，即使 PTS=DTS；真实 H.2648/HEVC10 两 AU 素材的整对4输出均可在 drain。旧明确提交的 isolated/forward 请求保留原归一化指纹、严格立即输出条件和计费，不在失败后暗中换模式。普通同步两侧完整 GOP 的16次输入/输出与旧 forward 的9次工作量明确区分。
- 来源仍限已注册媒体库、已有服务端 producer 见证的完整单配置无恢复缺口 FLV/Enhanced FLV、渐进 H.264/HEVC、明确颜色/色度位置的8/10-bit YUV420；唯一已知 PTS、严格递增已知 DTS、配置/每 AU/边界字节与源版本/cache namespace/build 均核验。stat-version 与 FNV 见证不是内容认证。16MiB读、8MiB包、32MiB保留帧、256MiB WASM、像素、30秒执行及128KiB结果/附件预算保留，取消/截止须等待真实 Worker 退出才释放容量，内核 IO 安全排空可能延后返回。
- 新 ABI 可核查 decoder 报告的 error flags，但**仍保证所选输入窗口的实际解码输出，不认证引用完整性或不存在 concealment**：持久 `dependency.guarantee` 继续为 `referenceIntegrity=not-certified`、`concealmentDetection=unavailable`。旧 H.264 缺参考 SSE64 反例仍保留，不能称所有缺依赖必拒。新窗口、完整 outputIdentity/drain、decoder/算法版本随 job/attempt/digest 和附件保存；普通编辑保全、导入降历史。只读查看重新核验完整窗口/像素身份，不查私有 job 或重评分；精确方形 SAR、crop/旋转等原几何门槛不放宽。
- core 已审源码 `56eec749fde60488e41fe4d5467f77fb112f093c`，tree `97ed4b355139f425a671b4d6d5b4aeabdbcc7d62`；[WASM CI40222262542](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/actions/runs/40222262542) 与 [analysis CI40222262527](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/actions/runs/40222262527) 均成功。ST/MT 各10素材/192原始像素逐字节输出/14 drain/62协议检查，另18故障注入；父任务联合独立复核无阻断。真实 fork 为 Nakiha/FFmpeg，本批无需修改它。
- Web 精确候选 `4550f2fac065f065b9ab7f6c6fec62ae63710b1d` / tree `e49236358ab305c690a5fd6fa546c5f33a6e6178` 通过最终独立复核；[full40227022897 attempt1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40227022897) 成功：33 success、1预期tag skip，[identity40227022911](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40227022911) 成功，无重跑。实际普通日志确认 source143/143、媒体49/49（新重排/延迟19项、旧forward9项及独立PSNR/SSIM对照）、Chromium/WebKit各6/6（新增四组GOP GUI内含零CTS真实提交/挂接/原始像素查看）、ci-cache13/13及原PSNR GUI四组、三平台compiled九素材和[release-set六资产1/1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40227022897/job/121278819474)。CI测试合并712370693e44a8b8c879b331f04a331037f44265的tree与候选一致。
- core 实际合入 `wasm` 提交 `29548b3180da687a3c915982fb38777a4ff34600`，parents 为原11c73368与固定56eec749，tree保持上述97ed；固定提交保留为祖先、Web pin 未改。core 两条测试 workflow 当前仅监听 PR，无 wasm-push 或 dispatch 触发器，因此**该合入提交没有远端 post-merge 测试 run**，不把候选成功冒充合入后CI。Web 实际 main `63515a647c9e9ccc0e12fdf30da17ecbabd6c65c`，parents 为原c09cff68与4550f2fa，tree保持e492；[main full40229935586](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40229935586) 与 [main identity40229935628](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40229935628) 均已成功：full attempt1 于2026-10-25 21:04 UTC完成，32 success、2预期skip（push无PR-base配对性能、无tag发布草稿），identity成功，无失败/超时/重跑。
- 实际 Web main 普通日志再次确认 source143/143、[媒体49/49](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40229935586/job/121280745552)（新重排/零CTS19项、旧forward9项、独立PSNR/SSIM对照和缺参考SSE64反例）、Chromium/WebKit各6/6、[ci-cache13/13与原PSNR GUI四组](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40229935586/job/121280745491)、三平台compiled九素材以及[release-set六资产1/1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40229935586/job/121290678581)。main重新构建并消费固定core56eec749；这属于Web实际合入提交的验收，不是core29548b31的独立post-merge run。Web本批合入后功能验收闭环，core触发器限制仍单独保留。
- 性能仍未通过：候选配对配置有效、16样本8失败，baseline/feature各4/8失败；候选source信息性采样solo两次约0.997×均通过，dual约0.676×/0.664×均below-realtime。独立本地WebKit默认12次均低于实时、11次有presentation stall，非因果对照。本次main信息性采样4/4均below-realtime：solo约0.865×/0.833×，dual约0.545×/0.538×。绿色informational job不代表性能成功，旧负结果和历史CI未知根因不改写为已修复。
- 历史结果和幂等回执保留当时decoder build。只提供新core的部署会明确拒绝旧build的原帧快照，不替换decoder、重写历史或自动重评分；本批没有历史decoder注册表。见[精确契约](https://github.com/Nakiha/VoidPlayer-Web/blob/63515a647c9e9ccc0e12fdf30da17ecbabd6c65c/docs/reordered-frame-quality.md)。
- 整体仍未完成：超出32-AU闭合GOP/未支持身份的更广依赖帧、序列、更广容器/几何、对应/对齐、任意播放器框选直接测量、自动评分造标注、逐像素热图/VMAF/NR、通用任务/资源/自动重试/共享及分布式仍待。原验收清单和open状态保留；未发布应用版本、标签或Release。以下#141及更早区块是各次历史范围与验证，不代表本批新增ABI缺少已实现的错误标志见证。
<!-- voidplayer-pr142-progress:end -->

<!-- voidplayer-pr141-progress:start -->
### PR #141：普通前向依赖帧的完整测量与证据批次（已合入，合入后功能验证通过）

- [PR #141](https://github.com/Nakiha/VoidPlayer-Web/pull/141) 已于 2026-10-25 合入：GUI 与 HTTP/Agent 从已有可信缓存明确选择目标 AU、实际源 PTS 和闭合解码起点，经同一持久任务得到 PSNR/可选 SSIM/网格，再显式挂到已有标注并打开同一原帧对/ROI 查看器；接口、界面、测试和文档在同一完整批次中交付。普通播放会话不参与取帧，关闭观察不取消后台执行，不自动评分造标注或移动播放头。
- 支持保守的前向子集：原有可信完整单配置、无恢复缺口 FLV/Enhanced FLV，渐进 H.264/HEVC、明确颜色/色度位置的8/10-bit YUV420。每侧目标携带 `decode:{mode:'forward-one-output-per-au-v1',startAu}`，从实际验证的闭合 IDR 连续送包至目标；要求唯一严格递增 PTS=DTS、每次输入在下一次送包前恰好输出一帧、最终 drain 无残余。每侧最多32 AU、整对64次输入/输出；不按近似 PTS 寻帧，不认证引用图。重排/延迟输出、CRA/开放起点、重复时钟、变更参数和更长窗口明确拒绝。见 [完整契约](https://github.com/Nakiha/VoidPlayer-Web/blob/c09cff6809563cdd3a4a03ae411885cad6397346/docs/forward-frame-quality.md)。
- **保证的是所选码流窗口的实际解码输出，未认证引用图完整性或不存在 concealment。** API `qualityJobs.source.forward.guarantee` 和不可变 `provenance.*.dependency.guarantee` 明确保存 `pixels=exact-decoder-output-of-verified-input-window`、`referenceIntegrity=not-certified`、`concealmentDetection=unavailable`。当前 packet ABI 不提供 decode_error_flags/concealment 见证；真实 H.264 删除中间参考 AU 后，重新显式构建可信缓存的 HTTP 任务仍可能完成，本次反例相对未损源 SSE64。选帧、任务/共享证据结果和原帧查看器均直接提示“缺失参考帧仍可能返回分数”；不能称所有缺失依赖均拒绝，或称 concealment 已修复。
- 完整窗口 AU/tag/字节/原始时钟、实际输出计数与保证边界随 job/attempt/digest 保存；普通编辑、导出/历史导入保留事实，历史副本不能继承服务核验。错误/缺失/抬升保证声明拒绝。原帧查看重新验证完整窗口和来源/缓存/decoder/几何，不查私有 job、不重评分。旧不带 decode 的 isolated-key 请求仍保留2/2默认预算、原幂等指纹和旧附件语义；stat identity 不是内容认证。
- 仍保持16MiB总源读取、8MiB/包、32MiB/保留帧、256MiB WASM、像素、30秒总执行及128KiB结果/附件上限；中间输出计费但不复制到 JS，取消/截止须实际 Worker 退出后才释放容量。颜色、精确 SAR/crop/旋转与 viewer 更严格几何门槛不放宽，不自动建索引、共享计算或重试。
- 精确候选 `4b7eb6cb963df27627162a361ca10134c1200372` / tree `f1f2b7275afd775cfe274f41c03661675fe84b7b` 已通过独立完整和增量复核；[候选 full40212349257 attempt1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40212349257) 成功：33 success、1预期tag skip，[identity40212349245](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40212349245) 成功，无重跑。普通日志确认 source143/143、媒体48/48（新依赖帧9/9、FFmpeg/BigInt标准对照、缺引用SSE64/持久/防篡改反例）、双引擎各4/4（新增forward8/10及旧SSIM8/10）、原PSNR GUI四组和ci-cache13/13、三平台compiled五素材及release-set六资产1/1。独立复核另确认40目标对/80原始帧、10拒绝反例、16种保证声明删改/抬升及历史降权/旧actor围栏。CI实际测试合并 `922e14440fbe64c1e13ad9d78691fbc56703fe2f` 的 tree 与该候选一致。
- 已合入 main `c09cff6809563cdd3a4a03ae411885cad6397346`，parents 为原main `bfce625d48cc206d113e518e790931a32c3a5b08` 与候选 `4b7eb6cb963df27627162a361ca10134c1200372`，tree 保持 `f1f2b7275afd775cfe274f41c03661675fe84b7b`；PR已关闭。[main full40215886987 attempt1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40215886987) 于 2026-10-25 18:01 UTC 成功：32 success、2预期skip（push无PR-base配对性能、无tag发布草稿），[main identity40215886955](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40215886955) 成功，无重跑。实际 main 普通日志确认 source143/143、[媒体48/48](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40215886987/job/121236922003)（新增forward9项、标准对照及缺引用SSE64/保证声明反例）、Chromium/WebKit各4/4、[ci-cache13/13及原PSNR GUI四组](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40215886987/job/121236922006)、三平台compiled五素材、FATE/HTTPS功能检查；[release-set](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40215886987/job/121246998742) 实际三平台六资产校验1/1。合入后功能验收闭环；未发布版本或标签。
- 性能仍未达标：当前候选配对报告 configurationValid=true、16样本12失败、passed=false；source采样4/4 below-realtime（solo约0.868×/0.875×，dual约0.561×/0.562×，其中一次dual亦有卡顿）。旧负结果和历史CI未知根因保留，功能验收不代表性能成功。 本次 main 实际信息性采样同样4/4 below-realtime：solo约0.819×/0.831×，dual约0.543×/0.542×，两个dual样本的A/B均记录presentation-stall；不把绿色job或合入后功能验收解释为性能通过。
- 整体路线仍未完成：重排/延迟输出或超出上述窗口的更广普通依赖帧、序列、更广容器/几何、可验证对应/对齐、任意框选直接测量、自动评分造标注、热图/VMAF/NR、通用任务/资源管理及分布式仍待；原总验收清单与 open 状态保留。
<!-- voidplayer-pr141-progress:end -->

<!-- voidplayer-pr140-progress:start -->
### PR #140：显式可选 SSIM 的完整闭环（已合入，合入后功能验证通过）

- [PR #140](https://github.com/Nakiha/VoidPlayer-Web/pull/140) 已于 2026-10-25 合入：GUI 显式勾选或 HTTP/Agent 请求 `ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'}`，复用同次可信原始帧解码，在必需 PSNR 之外返回独立 `result.ssim`。任务、不可变结果、显式挂接已有标注、历史导出/导入与精确原帧对/选块查看完整接通；没有新增 SSIM-only 作业或通用任意指标组合。GUI 与 Agent 消费相同后台事实，关闭观察不取消持久执行。
- 算法明确为 Float64 的 FFmpeg 均匀 8×8、步长 4 变种，不是 Gaussian/Wang 或 MS-SSIM：固定原生 Y/U/V 8/10-bit 码值、峰值/常量及 4:1:1 平面均值权重，只计有效窗口，不补边/重采样/钳制负分。逐平面记录实际源网格覆盖和窗口数；整 ROI 与独立块窗口分数分开，不能由块均值还原整 ROI 分数。SSIM 的 ROI 及每个实际边缘块至少 16×16，最多 64 块；原 PSNR 小块请求保持原语义。见 [SSIM 契约](https://github.com/Nakiha/VoidPlayer-Web/blob/bfce625d48cc206d113e518e790931a32c3a5b08/docs/source-plane-ssim.md)。
- 来源仍限已注册媒体库、已有可信完整单配置 FLV/Enhanced FLV、渐进 H.264/HEVC 闭合关键 AU、明确色彩/色度位置的 8/10-bit YUV420。源版本、cache namespace/build、AU/实际 PTS、颜色、预算和 Worker 物理退出容量围栏不放宽；stat identity 不是内容认证。原帧查看器继续拒绝非精确方形 SAR/crop/旋转。缺缓存、来源变化、几何/颜色不兼容及错误 ROI 明确失败，不自动建索引、猜配对或扩大帧域。
- SSIM 选择纳入原事务幂等身份，同键改变/删除指标冲突；旧 PSNR 规范化指纹保持。附件保存同一不可变 digest 下的两项事实，普通编辑保全；plain/gzip v2 导入/副本保留数值并降为历史事实。表单错误现可跨后台轮询保留；旧大块背压回归改为实际达到累计字节/下一帧预留条件后再验稳定，保留原等待上限、断言及生产调度。
- 精确候选 `3bd058ea4ddf29a982e80f5df7614a99944f33be` 已通过完整和增量独立复核；[候选 full attempt 1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40197548217) 成功：33 success + 1 预期 tag skip，[identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40197548187) 成功。普通日志确认 source 143/143、媒体 47/47、新 SSIM Chromium/WebKit × H.2648/HEVC10 四组、原 PSNR GUI 四组、ci-cache 13/13、三平台 compiled quality 与六资产 release-set 通过；47 项媒体明细及 job 链接在 PR 正文。背压实测 25 块、25,839,966 字节且退出检查通过，原门槛未降低。
- 已合入 main `bfce625d48cc206d113e518e790931a32c3a5b08`，tree `b72594046642ce77a2d9b27f18bdf90529767cf0` 与已审候选及 CI 测试合并 tree 一致；父提交为原 main `e3dc9e3f4bc3b61d73522fd0543f93e300791f44` 和候选 `3bd058e`。[main post-merge full attempt 2](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40201156057/attempts/2) 已于 2026-10-25 完成并成功：32 success、2 预期 skip（push 无 PR-base 配对性能、无 tag 发布草稿）；[identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40201156034) 成功。main 普通日志确认 source 143/143、媒体 47/47、新 SSIM 四组、原 PSNR GUI 四组、三平台 compiled quality；重跑 source UI job `121202622545` 的 ci-cache 13/13，原 Chromium10 查看器用例 49,757 ms 通过。[release-set job](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40201156057/job/121212055102) 校验三平台六资产并 1/1 通过。此次合入后功能验收闭环，没有新提交、降低断言或扩大限时。
- 保留首次故障事实：[main attempt 1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40201156057/attempts/1) 曾因 Chromium10 原 PSNR viewer/annotation 用例在 `observer-play` 达到 300 秒而失败（ci-cache 12/13，release-set 被依赖阻断）；仅按授权对失败 job 及依赖重跑一次，同一 SHA 通过。首次精确根因仍未确认。本地有界诊断仅暂停 rAF 调度时，真实 play 调用正常返回且播放继续推进，但默认 rAF 条件轮询超时、同条件定时轮询通过；这证明一种测试等待盲区，不等于确认远端首次故障原因，不能把重跑通过称为根因已修复。
- 性能未达标：候选配对报告 configurationValid=true、16/16 样本失败、passed=false；候选 source UI 性能 4/4 below-realtime。本次 main attempt 2 实际性能报告也为 4/4 below-realtime：solo 两次约 0.864×/0.858×，dual 两次约 0.569×/0.555×，仍是 informational 负结果。功能 CI 成功不代表性能验收，旧未知故障根因记录保留。未发布版本或标签。
- 整体路线仍未完成：普通依赖帧/序列、更广片源与几何、自动对应/对齐、任意框选直接测量、自动评分造标注、逐像素热图、更广算法/通用多指标任务、VMAF/NR、自动重试/共享、完整资源管理与分布式仍按各 issue 原范围推进。保留原总验收清单与 open 状态。
<!-- voidplayer-pr140-progress:end -->

### 已合入

- [PR #139](https://github.com/Nakiha/VoidPlayer-Web/pull/139) 已于 2026-10-25 合入 PSNR 分块与最差区域证据完整批次：GUI/HTTP 同一请求显式指定 `spatial:{blockWidth,blockHeight}`，在同一次原始平面遍历中返回逐块 Y/U/V 与聚合 SSE/样本数/MSE/PSNR；网格锚定测量 ROI，偶数源像素、边缘按实际范围截断，最多 64 块，最差最多 8 块按每样本 MSE 排序。整体 PSNR 仍由总 SSE/总样本计算，不平均块 dB。
- #139 网格参数纳入事务幂等身份；块事实随原 job/attempt/digest 持久保存、显式挂到已有标注，普通编辑不能替换/剥离，导出/导入保留数值并降为历史事实。任务结果、共享附件和原帧查看器消费同一数据；GUI 与 viewer Agent 的选块经同一只读 session，在已核验两侧快照上独立覆盖，不查私有任务、不重评分/解码、不 seek 或写标注，也不把全 ROI 分数冒充选中块分数。
- #139 当时的支持范围维持已有可信完整单配置 FLV/Enhanced FLV、渐进 H.264/HEVC 闭合关键帧、明确色彩 8/10-bit YUV420。源版本/cache namespace/build/AU/实际 PTS 和精确几何门槛不变，查看器仍拒绝非方形 SAR/crop/旋转；stat identity 仍不是内容认证。没有新增普通依赖帧、序列、新容器、SSIM、逐像素热图、自动配对/造标注或分布式计算。保留 128 KiB 结果/附件预算和 Worker 物理退出容量围栏。见 [分块证据契约](https://github.com/Nakiha/VoidPlayer-Web/blob/e3dc9e3f4bc3b61d73522fd0543f93e300791f44/docs/psnr-spatial-evidence.md)。
- #139 精确候选 `519bf77dc208216babf9ebb27301ce6f8d3564f7`；合并提交 `e3dc9e3f4bc3b61d73522fd0543f93e300791f44`，tree `220a70f2c817fc328f1092f6e2073c96bc151645` 与已审候选及实际 CI 测试合并 tree 一致。此批选择空间证据是复用已有原始平面/持久任务/附件/查看链路；更广帧域需可信随机访问接线，#139 合入时 SSIM 尚待独立窗口/边界契约（现已由 #140 补齐受限变种），不能以 #139 代替。

- [PR #138](https://github.com/Nakiha/VoidPlayer-Web/pull/138) 已于 2026-10-25 合入受限单帧 PSNR 的完整 GUI 操作批次：独立检索媒体库、读取已有可信缓存的有界候选 AU/实际源 PTS、显式选择双方帧及源 visible 网格偶数整数 ROI，提交/取消、观察真实阶段、历史/详情与不可变结果，再显式挂到已有共享标注并打开既有精确原帧对/ROI 查看器。GUI 与 HTTP Agent 消费同一后台 job/attempt/result，关闭页面只解除观察，不取消已受理任务；播放 A 时测量 B/C 不移动 A 的播放头。
- #138 的候选查询不建索引、不解码、不自动配对；容器关键帧只是候选，执行时仍校验闭合 AU、源版本/缓存 namespace/build、色彩/像素及预算。保留原 actor/client/key/body 的丢响应重放；捕获 actor 与实际 cookie 不一致在私有读取、受理或取消前返回 409 actor-changed，避免跨窗口身份通知迟到产生错误归属任务。该归属机制仍不是用户认证或安全隔离。
- #138 精确候选 `44df0afb9685b10f9c734d83cb7c8eafcfd871d1`；合并提交 `960aca3c9f78b9834354a7d6f01c21abb507dfd2`，tree `413047e8eaa260ff291d17e0d1bd7b102e4e8cc9` 与已审候选及 CI 测试合并 tree 一致。支持仍限已有可信完整单配置 FLV/Enhanced FLV 上的渐进 H.264/HEVC 闭合关键帧 8/10-bit PSNR；测量与查看器几何支持明确区分，后者不放宽精确方形 SAR、无 crop/旋转的限制。见 [GUI 任务工作流](https://github.com/Nakiha/VoidPlayer-Web/blob/960aca3c9f78b9834354a7d6f01c21abb507dfd2/docs/psnr-task-workflow.md)。

- [PR #124](https://github.com/Nakiha/VoidPlayer-Web/pull/124) 已于 10 月 23 日合入：#113 的渐进式 HTTP 发现，以及 #119 的无 GUI 标注持久命令、幂等回执、操作事件和 GUI 被动同步。已验证关闭 GUI 后写入、重连恢复及播放 A 时接收 B 的活动而不改变播放头/焦点；#119 当前只覆盖标注域。
- #120 已分批合入 [PR #125](https://github.com/Nakiha/VoidPlayer-Web/pull/125)（自解释缓存信息/FFmpeg 有界查询）、[PR #126](https://github.com/Nakiha/VoidPlayer-Web/pull/126)（FLV/JS-TS 语义头）、[PR #127](https://github.com/Nakiha/VoidPlayer-Web/pull/127)（分片记录查询）、[PR #128](https://github.com/Nakiha/VoidPlayer-Web/pull/128)（GUI 索引读取快照修复）、[PR #129](https://github.com/Nakiha/VoidPlayer-Web/pull/129)（有界缓存技术候选筛选）。它们读取已有缓存，不隐式探测、建索引或解码，不代表完整选片能力已完成。
- [PR #130](https://github.com/Nakiha/VoidPlayer-Web/pull/130) 已合入 8/10-bit planar YUV420 源平面 PSNR 数值核心：显式 ROI、SSE/样本数正确聚合、有界输入及独立 FFmpeg 对照。
- [PR #131](https://github.com/Nakiha/VoidPlayer-Web/pull/131) 已于 04:29 UTC 合入：可信宿主已绑定 Blob/完整单配置 FLV 缓存上的内部单帧 PSNR 桥，独立 Worker/WASM 取源平面、逐侧身份/provenance 校验，并在 Worker 实际终止后释放容量。它不是任意输入的安全认证，也不包含媒体库评分服务。精确候选 `25c87ecaca00b5843bcbf3f4a2fd495dc3fe0bd5`；合并提交为 `b4a580236b9fac40c54ff7eec7b2850148bde110`。

- [PR #132](https://github.com/Nakiha/VoidPlayer-Web/pull/132) 已于 06:27 UTC 合入：受限媒体库的来源发现 `GET /api/media/{id}/psnr-source` 与一次性 `POST /api/quality/psnr-pair`，独立 Node/Bun Worker 真实解码、8/10-bit PSNR 和来源/算法/解码器 provenance。仅支持完整、单配置、无恢复缺口 FLV/Enhanced FLV 的渐进 H.264/HEVC 闭合关键帧及明确色彩的 YUV420；双方 AU/实际 PTS 和 ROI 由调用者显式指定，不自动配对或对齐。
- #132 已落地服务端完整扫描与缓存 producer evidence 的事务原子绑定；客户端上传无法 mint/补盖可信证据，缺缓存/证据不触发评分侧建索引。高精度 stat/描述符与缓存绑定保证所声明的身份检查，不是全文件内容认证。精确候选 `f9536647e40102f0cccf64c3f67ffb1096f37594`；合并提交为 `17238fbc808e15f55c2c39ed453321d733b8db04`。

- [PR #133](https://github.com/Nakiha/VoidPlayer-Web/pull/133) 已于 08:00 UTC 合入受限持久单帧 PSNR：`POST /api/quality/jobs` 提交、列表/详情/不可变结果读取、显式取消、事务幂等、真实 queued/preparing/running/终态、断线不取消及重启 interrupted/历史保留；多实例持锁独占，排队/执行/历史预算有界。仍仅支持已有可信 FLV/Enhanced FLV 缓存上的显式 H.264/HEVC 闭合关键帧 8/10-bit PSNR，不扩大像素或来源范围。
- `quality.jobs` 发现声明现仅在持久媒体库数据库部署启用；临时数据库 disabled/unavailable，任务接口返回 503 quality-storage-unavailable。仍需已有 identity 和逐源条件；actor/client 是自述归属，不是认证或安全隔离。精确候选 `e5e54cca9d9bcef59d4cbf11940259e07d193238`，合并提交为 `98db9e1a0dba8d1e77c1dee4629db427e5d821d9`。

- [PR #134](https://github.com/Nakiha/VoidPlayer-Web/pull/134) 已于 12:21 UTC 合入 #115 的受限 PSNR 证据挂接：GUI、页面 Agent 与 HTTP 使用同一 `attach-quality-result` 持久命令，把当前 actor 已完成任务的不可变数值/provenance 挂到已有共享标注。标注、附件、事件和幂等回执同事务提交；校验选中侧来源版本/实际 PTS/ROI、attempt 与 digest，不重算、不建索引、不造标注、不 seek 或加载媒体。
- 附件保存可共享的两侧测量事实，不带私有提交者/client/request/幂等元数据；普通编辑保留附件，后续 ROI 不匹配显示历史/不适用。历史副本和导入降为未验证历史事实，含证据 workspace/review 用 v2 导出；已有结果清理后原回执与共享事实仍可恢复。精确候选 `0c8ffe00e01d35e8d882c13160f008bee21ce47b`，合并提交为 `820d79584e199589d0548489b46316864831d7f1`。

- [PR #135](https://github.com/Nakiha/VoidPlayer-Web/pull/135) 已于 13:24 UTC 合入 #134 的深链接兼容修复：活动入口和管理页“在播放器打开”按附件选择 workspace v2，普通无附件标注仍为 v1。保留原标注/媒体 ID、源版本、实际 PTS、ROI/附件与严格 v1 附件拒绝，不改变导入降权；这不是新增算法或任务能力。精确候选 `b3b4ffdf98ac1963f2d1dafd756768f80a83a5a3`，合并提交为 `01d6c5766ff0acceb8f9c1f17dda0c079d4793da`。

- [PR #136](https://github.com/Nakiha/VoidPlayer-Web/pull/136) 已于 17:04 UTC 合入：从既有、当前服务 server-verified PSNR 证据显式打开精确原帧对与 ROI；GUI 链接与 Agent `get_annotation_pair_view` 共用同一引用，独立只读窗口保留两个不可变快照，不操控原播放、不重算、不写标注、不建索引，也不访问他人的私有任务。
- 显示前核对源版本/实际 PTS、完整缓存 namespace/build/binding、AU、decoder/像素颜色域与证据 provenance，呈现 token 再核验精确 SPS 几何及 ROI。仅支持可信完整 FLV 闭合关键帧 8/10-bit、无 crop/旋转且明确精确方形 SAR 的子集；历史副本、变化/含糊来源及不支持几何明确拒绝，不按近似 PTS 或取整显示宽度替代。精确候选 `1a6ab8a12fecb944ece508a79fcd8ae3a2e5b8ea`，tree `e0e15c09e3beb249ddbaf5911f1be3fcf5a95c08`，当时 main 为合并提交 `0bcc8ca3c8969401dbd9aeb71dc20b75d3ac89c4`。

### 验证与已知限制

- #139 精确候选 [完整 CI attempt 1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40186330435) 成功：31 success + 1 预期 tag skip；[identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40186330456) 成功，无重跑。source 142/142、媒体 46/46、ci-cache 13/13（真实 Chromium/WebKit × H.2648/HEVC10 网格 GUI 四组）、三平台 Node/Bun/compiled quality 与 [完整 release-set](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40186330435/job/121154841986) 六 assets 验证通过。独立复核对该精确 SHA/tree 无代码阻断，独立 BigInt 随机块、4096×2304/10-bit/64 块及绑定边界通过。
- #139 功能 CI 成功不代表性能达标：配对报告配置有效但 16/16 样本失败；独立 runner 的两个单轨样本通过、两个双轨样本均未达标（below-realtime，其中一次有卡顿）。原性能门槛未降低，历史 HEVC 采集超时和 Linux 清理失败根因仍未知。
- #139 main 合并 SHA `e3dc9e3f4bc3b61d73522fd0543f93e300791f44` 的 [post-merge full attempt 1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40188881374) 已成功：30 success、2 正常条件 skip；[identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40188881369) 成功，无重跑。普通日志确认 source 142/142、媒体 46/46、ci-cache 13/13（真实 Chromium/WebKit × H.2648/HEVC10 网格 GUI 四组通过）、三平台 compiled quality、FATE/HTTPS 功能及 [完整 release-set](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40188881374/job/121164915345) 1/1、六 assets 验证通过。tree `220a70f2c817fc328f1092f6e2073c96bc151645` 与已审候选一致，合入后验证闭环。main 信息性性能仍为 4/4 below-realtime，双轨均有卡顿，保持性能未达标；未发布版本或标签。

- #138 精确候选 [完整 CI attempt 2](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40177647781/attempts/2) 成功：31 success + 1 预期 tag skip；[identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40177647766) 成功。source 142/142、媒体 Node 46/46、ci-cache 13/13（含真实 Chromium/WebKit × H.2648/HEVC10 GUI 点击发起四组）、三平台 standalone 和完整 release-set 均通过；独立复核已重放并关闭跨窗口 actor P1。
- #138 首次完整 CI 的 Chromium FLV legacy HEVC 性能采集超时保留；一次授权失败项重跑通过未改动的完整矩阵，超时根因仍未知。旧 Linux 子进程清理失败在最终候选未复现，亦不宣称根因已修复。播放性能仍有 below-realtime/卡顿等负结果，信息性 job 成功不等于性能达标；断言、阈值及限时未降低。
- #138 合入后 main `960aca3c9f78b9834354a7d6f01c21abb507dfd2` 的 [完整 CI attempt 1](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40181430229) 已成功：30 success、2 正常条件 skip；[identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40181430228) 成功，无 post-merge 重跑。普通日志确认 source 142/142、媒体 Node 46/46、ci-cache 13/13（四组真实 GUI Chromium/WebKit × H.2648/HEVC10 均通过）、三平台 standalone、FATE/HTTPS 功能及 [完整 release-set](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40181430229/job/121142013723) 1/1（6 assets）通过。tree `413047e8eaa260ff291d17e0d1bd7b102e4e8cc9` 与已审候选一致，合入后验证闭环。main 信息性性能仍为 4/4 样本 below-realtime，其中双轨有卡顿，保持性能未达标结论；未发布版本或标签。

- #136 精确候选 [完整 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40110897919) 成功：31 个 job success + 1 个 tag 专属步骤条件跳过；[身份 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40110897897) 成功。source 141/141、媒体 46/46、ci-cache 9/9，Chromium/WebKit × H.2648/HEVC10 四个真实 viewer 和实际 SAR 1000:1001 拒绝验证通过；三平台 compiled quality 及完整 release-set 通过。契约和独立显示限制见 [原帧对/ROI 查看契约](https://github.com/Nakiha/VoidPlayer-Web/blob/0bcc8ca3c8969401dbd9aeb71dc20b75d3ac89c4/docs/annotation-psnr-pair-view.md)。
- 2026-10-25，合并提交 `0bcc8ca3c8969401dbd9aeb71dc20b75d3ac89c4` 的 [post-merge full attempt 2](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40114486979/attempts/2) 已成功：30 个 job success、2 个正常条件 skip；[identity](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40114487022) 成功。仅补跑 [Windows Standalone](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40114486979/job/121077963379) 及依赖，Windows 用时约 5 分 28 秒，Node 12/12、Bun 15/15、compiled quality、HTTPS 与 console shutdown 通过；[完整 release-set](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40114486979/job/121078932568) 用时 25 秒，实际三平台 6 assets 验证 1/1 通过。未改代码、限时或断言，Windows/release-set 的 post-merge 待重验缺口已关闭。
- 原 attempt 1 的 Windows 超过 20 分钟限制而取消记录保留，具体耗时根因仍未知；本次通过不等于已经定位或修复该根因。
- 同一 post-merge 已通过 source 141/141、媒体 46/46、ci-cache 9/9（四个真实 viewer 及 SAR 拒绝）、三平台 compiled quality、FATE 与 HTTPS 功能检查；原 Windows 取消不是 FATE 故障。合并 tree `e0e15c09e3beb249ddbaf5911f1be3fcf5a95c08` 与已验收候选一致，性能负结果及其他未完成业务验收保持原判。
- 本候选所需 FATE 检查实际运行，无需 FATE 豁免；性能报告仍为配对 16/16 FAIL、独立 4/4 below-realtime，不宣称性能达标。
- [PR #137](https://github.com/Nakiha/VoidPlayer-Web/pull/137) 仅为 FATE 固定素材缓存基础设施，不计为业务完成。其 main 合并后 [完整检查](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40110452146) 已成功，已有官方 14 样本完整下载/校验、实际保存和精确键命中复验；不把原 PR 的失败候选运行重标为绿色。
- #135 精确候选 [完整 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40095284330) 成功：31 个 job success + 1 个 tag 专属步骤条件跳过；[身份 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40095284325) 成功。Chromium/WebKit 真实点击活动/管理入口均通过，恢复原 ID/版本/实际 PTS/证据；v1 严格拒绝及原窗口播放隔离保留。性能仍未达标（该候选配对 HTTPS 9/16 样本失败），不以绿色信息性 job 代替性能验收。
- #134 精确候选的 [完整 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40090765539) 成功：31 个 job success、1 个 tag 专属 release-draft 步骤按条件跳过；[身份 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40090765551) 成功。ci-cache 7/7，真实 PSNR Chromium/WebKit 两引擎通过；三平台 compiled 附件、幂等、历史重启和空 PATH 验收通过。行为与共享边界见 [PSNR 标注证据契约](https://github.com/Nakiha/VoidPlayer-Web/blob/820d79584e199589d0548489b46316864831d7f1/docs/annotation-psnr-evidence.md)。
- #134 的播放性能报告未达标；配对 HTTPS 信息性报告 16/16 样本失败，绿色 job 不等于性能通过。另行 FATE 探索 24 pass / 66 fail 保留原失败结论，不据此宣称广泛兼容性或改变验收判定；旧 WebKit/Windows 失败的未知根因也不因新诊断版通过而被视为修复。
- #133 精确候选的 [完整 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40073998471) 成功：31 个 job success、1 个 tag 专属 release-draft 步骤按条件跳过；[身份 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40073998491) 成功。source 139/139、媒体 45/45，Linux/macOS/Windows 编译包真实持久任务、幂等/重启历史、第二实例拒绝及浏览器隔离验收通过。配置、发现及状态/预算边界见 [持久单帧 PSNR 协议](https://github.com/Nakiha/VoidPlayer-Web/blob/98db9e1a0dba8d1e77c1dee4629db427e5d821d9/docs/source-psnr-jobs.md)。
- #132 精确候选的 [完整 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40067454129) 成功：31 个 job success、1 个 tag 专属 release-draft 步骤按条件跳过；[身份 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40067454088) 成功。source 137/137、媒体 43/43、Linux/macOS/Windows compiled release-quality 真实 8/10-bit SSE/provenance 与 producer 重启复用验收通过。支持范围和 HTTP/Worker 契约见 [媒体库 PSNR 说明](https://github.com/Nakiha/VoidPlayer-Web/blob/17238fbc808e15f55c2c39ed453321d733b8db04/docs/source-library-psnr.md)。
- #132 的一次性 `quality.frame-pair` 仍为连接作用域，断线取消；该入口自身不创建持久 job，不能与 #133 的断线不取消契约混用。deadline 到期禁止成功；内核阻塞 IO 的安全排空和 Worker 物理退出可能延迟，容量在实际结束前不提前释放，不承诺严格到点返回。
- #131 的 [完整 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40060118690) 已完成：31 个 job 成功，1 个 tag 专属 release-draft 步骤按条件跳过；[身份 CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40060118697) 成功。source 136/136、媒体 42/42，通过的均为上述精确候选，不再沿用旧 head/未完成 CI 的状态。
- WebKit 增加诊断后的检查通过，不证明先前内部错误的根因已定位或永久修复。已有播放性能报告仍未达到原门槛；信息性 job 绿色不等于性能通过，保留原失败结果，未降低阈值。

### 未完成与下一步

- 原帧对/ROI 显式查看已随 #136 合入，#141 的有界前向及 #142 的32-AU闭合GOP重排/延迟输出均已贯通测量、附件与复核；更长窗口/未支持身份的更广依赖帧、自动对应/对齐、帧序列、逐像素热图和 VMAF 仍未交付。受限单帧 GUI 发起/任务管理已随 #138 合入，不据现有子集提前完成上述更广验收。
- #115 已交付 PSNR/显式 SSIM 挂接已有标注，并由 #143 补齐显式 AU 独立快照/ROI 到可信完成结果原子创建共享测量候选的 GUI/Agent 闭环。无人值守自动评分/发布候选、当前实际播放帧的可靠身份直接绑定、任意播放器框选直接测量、逐像素热图、序列、VMAF/NR 和通用任务管理仍未完成；重试、跨请求共享计算、自动建索引等更广验收保持未交付。
- #120 仍缺 MP4/Matroska 语义适配、完整流/位深/色彩探测、持久 probe/build、全库技术筛选及覆盖/未知统计、时间定位优化和跨页聚合。
- #114 仍需更广支持矩阵、可验证的参考配对/对齐、更广 GUI 测量支持、更广空间证据及 #115 更广算法/自动化附件闭环。#121 已有上述受限持久任务切片，但通用指标/任务、重试/共享、管理与完整资源策略等原验收仍未整体完成；不据此关闭 #114/#121 或勾选总验收。
- #122 VMAF、#116 CAMBI/NR、#117 浏览器 MCP 桥接、#118 进阶指标评估和 #123 计算节点仍按原依赖推进。各 issue 保持 open，不据已合入子集提前勾选整项。

## 已合入：独立 ROI 与原子共享测量候选（2026-10-26 UTC）

- [PR #143](https://github.com/Nakiha/VoidPlayer-Web/pull/143) 已正常合入 main `7c399ad05ad381c9df9e9713be98d5292ed9fd65`；tree `3e3025077f85f48a97052b47b13be8c9400927d4` 与独立复核的 head `76d9a074325a8bf1e9e961dfd6a3b62f4bc74b69` 及实际 CI 测试 tree 一致。一个完整 Web 功能 PR 包含入口、命令、文档及验收；没有发布版本或标签。契约见[独立 ROI 与测量候选](https://github.com/Nakiha/VoidPlayer-Web/blob/7c399ad05ad381c9df9e9713be98d5292ed9fd65/docs/quality-roi-candidates.md)。
- 从播放器片源面板显式选择两侧缓存 AU，经独立 Worker 核验版本/namespace-build/producer/解码身份及严格几何后呈现快照；独立偶数源网格 ROI → 已有持久 PSNR/可选 SSIM/grid → GUI/无 GUI Agent 同一 `create-quality-candidate` 原子命令 → 共享标注与原帧查看。无需先创建空标注，不按 PTS 猜帧、不暂停/seek/隐式建索引；关闭观察不取消后台任务。
- 从可信完成结果的索引派生时钟见证构造锚点和 ROI；缺见证旧结果明确拒绝新建。文字/严重度由调用者填写，候选明确未作人工缺陷判断。回执优先于私有结果读取，结果回收/重启可重放；actor 围栏、事务原子性、普通编辑保全、历史导入降权、v3 候选导出/DB v4 兼容围栏保留。无效本地草稿可编辑恢复，有效未知提交仍冻结并使用原操作重放。
- 精确候选 [full40245560028](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40245560028) attempt1 成功：33 job success、1 tag 专属条件 skip；[identity40245560030](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40245560030) 成功。source143/143、媒体Node49/49、ci-cache17/17、三平台 compiled quality/候选命令/重启/空PATH通过；Chromium/WebKit×H2648/HEVC10 的四组真实ROI及四组完整标注/查看流程均实际通过。
- 合入后验证已完成：实际 main `7c399ad05ad381c9df9e9713be98d5292ed9fd65` 的 [full40249009510](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40249009510) attempt1 成功（32 job success、2正常条件skip：PR-base配对性能与tag专属release draft）；[identity40249009556](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40249009556) attempt1成功。source143/143、媒体Node49/49、ci-cache17/17、双引擎四组ROI与四组标注/查看、三平台compiled实际通过；[release-set](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40249009510/job/121347009067) 校验三平台6资产通过。merge/main tree与已审候选一致，未使用重跑或验收豁免。
- 性能仍未达标：候选配对 configurationValid=true，16样本8失败、passed=false；实际 main 独立HTTPS四组4/4失败，均有below-realtime，其中一组另有B:presentation-stall。未改变阈值，绿色信息性 job 不代表性能通过。
- 历史失败保留：[旧 WebKit access-control](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40240674442/job/121311706805) 与[旧 observer-play 300秒等待](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40242665921/job/121317810423) 根因仍未知。本批受控 rAF 饥饿负对照证明旧等待盲点，50ms定时轮询观察真实帧推进，原300秒预算和原断言不变；不据新通过宣称旧根因已根治。本地旧基线折叠采样失败的未知根因同样保留。
- 仍限可信完整 FLV/Enhanced FLV、H264/HEVC8/10位YUV420及每侧32AU，引用完整性未认证、concealment检测不可用。未扩容器/序列/VMAF/分布式，没有 core/fork 改动。整体 issue 保持 open，不勾选更广总验收。

**#143 当时的验收缺口：普通播放器当前实际呈现帧尚不能直接绑定质量身份。** #143 的独立 AU 快照不能替代该条目；#144 现已补齐上述受限 WebCodecs FLV 路径。WASM/其他容器/不支持的 profile 或几何仍不支持直接绑定，无人值守自动评分/候选发布仍未交付，原更广验收保留。

