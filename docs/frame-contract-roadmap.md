# 帧契约与回归验收 Roadmap

2026-09-07 启动。基线：PR #2 合并提交 `6b95088`；开发分支 `codex/frame-contract-refactor`。
目标是让首帧、顺序播放、定位和关闭重开具有同一套可验证的输出约定。
本地/HTTP 可以使用不同读取实现；不能因此改变帧内容、显示顺序或定位语义。

## 1. 固定反例和验收标准

- [x] 固定 FATE 参考逐帧 PTS、尺寸及像素指纹，注明生成工具；测试时不随本机 ffprobe 改写标准。
- [x] Node 与 Chromium/WebKit 共用结果校验，检查首帧、顺序输出、往返定位和重开。
- [x] 区分必须通过、明确的能力拒绝、已知缺陷；未预期的失败使检查失败，已修复项提升为门禁。
- [x] 用错误尺寸、少帧和错误定位结果验证校验器确实能捕获静默错误。

## 2. 完整输出帧

- [x] 在 FFmpeg-Build 仓库完善逐帧 ABI：有效像素尺寸、长度、stride、时间戳、源像素格式/色彩和输出描述版本。
- [x] core → Worker → DecodedFrame → presenter 共用帧描述，边界校验和资源释放明确。
- [x] 原生帧区分像素几何、显示几何与色彩，不用打开时的快照重标后续帧。
- [x] 普通 WASM 两种 core 的多配置 MOV 首帧、完整播放及跨段往返定位通过。
- [x] 更新固定 core 修订前，先提交并推送上游源码；验证产物来源和必需接口。

## 3. 配置切换与显示时间线

- [x] 区分包索引、解码顺序、显示时间线和定位预滚，输出帧作为显示事实。
- [x] MP4/FLV 按配置段解码，段末保留延迟帧，跨段 seek 恢复正确配置。
- [x] 处理 B 帧重排和结尾 drain，不跳过不匹配帧冒充命中。
- [x] 定位采用同一规则：返回目标时刻之前最近的显示帧；首尾夹取，逐帧不重复不漏帧。
- [x] 多配置 MOV、无重排约束 B 帧、隔行裁剪反例在适用后端及本地/HTTP、关闭重开中通过。

## 4. 状态变更与诊断

- [x] 用统一元数据变更入口/版本替代 UI 中分散的字段签名，UI、Agent 和本地日志消费相同状态。
- [x] 当前显示尺寸/色彩只随实际展示帧更新，后台索引可独立更新时长和索引状态。
- [x] 操作、目标帧、实际送包、配置与实际输出可关联；错误保留原阶段，日志有界且只留本地。
- [x] 验证后台索引完成、动态尺寸、失败/取消及资源回收；现有 UI 和 Agent 行为一致。

## 最终验收

- [x] `npm test`、`npm run build`。
- [x] FATE Node 门禁与 Chromium/WebKit 本地/HTTP 连续关闭重开。
- [x] `test:browser`、展示/标注、FLV/Range 相关浏览器回归。
- [x] WebKit 播放基准，记录实际成绩与基线差异；不将非阻塞性能结果记为功能修复。
- [x] 每批独立提交，下面记录命令、结果、修订和剩余限制。

## 记录

- 基线：本地构建和 276 项测试通过；原探索脚本 8/23 通过。已知错误包括多配置帧尺寸和 B 帧目标 PTS 不匹配；浏览器旧结果见 [FATE 审查](fate-audit.md)。

- 第一批：冻结 FFmpeg 8.1.2 参考数据，Node 8 pass / 8 expected-rejection / 7 known-failure。浏览器本地 40 次检查新增 WebKit 隔行输出 640×372、FLV 第 50 帧失败，以及两浏览器 B 帧像素不匹配；逐项录入待修分类。校验器对少帧、错 PTS、尺寸、像素、定位和错误阶段的对抗测试通过。像素使用 4×4 RGB 分区均值（最大差 8、平均差 3），用于 SDR 回归，不作为 HDR 色准结论。

- 第二批：上游 `ee9e013` 已推送 wasm，双 core 构建和 ABI 实测通过；应用锁定修订、产物摘要/接口验证通过。FATE Node 12 pass / 8 expected-rejection / 3 known-failure；普通多配置 MOV 四个组合提升为门禁。全套测试初跑 279/280，唯一失败是直接读取 Worker 返回 ArrayBuffer 的旧断言，已改为验证帧消息的像素字段并通过定向复验；构建通过。最终浏览器和播放基准在后续批次完成后汇总。

- 第三批：共享 PacketTimeline 消费真实输出，支持一包多帧、跨配置 drain、显示时刻 floor 定位和队列释放。MP4 读取 stsd/stsc 配置及真实 CTTS/DTS/文件偏移；原生 AVC 按 SPS 的隔行与重排约束选择路径，带内参数切换先 drain 旧帧。上游 `c0d3c36` 修复 HEVC reset 残留 FIFO 并采用保守 AVC DPB，已推送。Node 15 pass / 8 expected-rejection / 0 known-failure；两浏览器本地/HTTP 重开 40/40 通过，已知失败清单清空。分片 MP4 的配置/DTS、容器独有裁剪仍在 container 阶段交给普通容器回退，不猜测参数。

- 第四批：`media-state.ts` 统一元数据补丁、递增版本与独立事件快照；session 在 draw 成功后记录输出描述，预取不会提前改变当前画面状态。UI 按版本刷新，后台索引与片源身份更新走同一入口。Worker 失败日志记录请求关联及最多 16 条近期操作，共享时间线错误携带实际送包/配置/目标/先前输出。真实 WASM 用例验证跨尺寸预取和往返 seek 的 UI/Agent 状态。完整 `npm test` 286/286、构建通过；最终 FATE Node 15 pass / 8 expected-rejection，浏览器 40/40 通过，均无已知失败豁免。CI 中 FATE 改为阻塞门禁。

- 浏览器回归：`npm run test:browser`、`check-presentation-browser.mjs`（Chromium/WebKit）、`check-flv-browser.mjs webkit`、`check-range-browser.mjs webkit`、标注 rendering/browser 全部通过。`check-flv-startup-browser.mjs` 两浏览器通过，256 MiB 尾部被阻断时 Chromium 95ms、WebKit 126ms 出首帧，并验证后台索引、缓存重开、UI 与 MCP 状态。报告保存在本地 `.run/refactor-*.log` 和 `.run/playback-reports/`。

- 最终复查补充 `e345bde`：定位后改用另一个位置调用 next，必须使旧 lookahead 失效；小于首帧的 next 返回首帧。以独立回归验证这两个边界，同时让 FATE 校验器拒绝 NaN/非整数 PTS。最终完整测试 **287/287**、构建、Node FATE **15 pass / 8 expected-rejection**、浏览器 FATE **40/40**、WebKit 混合帧率逐帧前后步进通过；元数据面板与共享导出回归也通过。

## 播放基准与剩余限制

同一台 macOS、Playwright WebKit 26.6、headless、1280×800、DPR 1；通过应用实际 canvas 绘制测量，每轮 8 秒或片尾。运行 `node scripts/bench-playback.mjs webkit --headless`，测试服务提供同一份 QA 样片。默认速度下限 0.9、最长绘制间隔上限 250ms，全部保留。源码/core 基线为 `6b95088` / `115f365`，最终版本为 `e345bde` / `c0d3c36`。

| 轮次 | 通过 | 双轨 VVC＋4K HEVC 速度范围 | 双轨最长绘制间隔 |
| --- | --- | --- | --- |
| 基线四场景各三轮 | 12/12 | 0.913–0.978 | 243.8ms |
| 基线追加双轨六轮 | 2/6 | 0.899–0.978 | 270.2ms |
| 重构首次四场景各三轮 | 11/12 | 0.941–0.972 | 262.1ms |
| 重构首次复测 | 11/12 | 0.928–0.976 | 284.0ms |
| 最终修订四场景各三轮 | **12/12** | **0.987–0.989** | **130.4ms** |

最终 HEVC 4K 单轨、VVC 单轨、VVC＋HEVC、MPEG-2 TS＋H.264 均三轮通过。原失败报告仍保留；不能把最后一轮通过解释为所有机器的持续性能保证，也不能仅凭这些有限轮次确定先前波动的唯一原因。合并前后的性能汇总含构建摘要和每轮结果，见 [验收数据](frame-contract-acceptance.json)。物理屏幕扫描输出和真实硬件使用未验证。

四批功能范围已验收；后续仍需单独推进损坏 FLV 的容错策略、裸 HEVC 入口、分片 MP4 配置/DTS、更多位深/色彩参考和长时高负载性能。这些能力没有通过删除检查或改写参考数据宣称支持。

提交：第一批 `4657439`，第二批 `e613efa`，第三批 `a6e825d`，第四批 `aef96d9`，最终边界修正 `e345bde`。后续改动集中在 [PR #3](https://github.com/Nakiha/VoidPlayer-Web/pull/3)；远端验收见该 PR 对应的最新 CI，正式发布仍沿原有发布流程。
