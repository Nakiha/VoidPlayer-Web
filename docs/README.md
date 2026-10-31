# 文档导航

先查当前行为契约，再按 [验证说明](testing.md) 选择测试。测试范围与命令以 [统一清单](../scripts/testing/manifest.json) 为准；历史结果不代表当前版本通过。

## 当前行为与开发入口

| 主题 | 文档 |
| --- | --- |
| 开发启动与仓库约束 | [项目首页](../README.md)、[AGENTS.md](../AGENTS.md) |
| 架构与失败边界 | [架构](architecture.md)、[失败隔离](failure-isolation.md)、[容器恢复](container-recovery.md) |
| 测试、CI 与报告 | [验证说明](testing.md)、[脚本索引](../scripts/README.md) |
| 独立程序运行与 HTTPS | [便携运行](../deploy/standalone.md) |
| 用户、访客、分享与工作区 | [身份与分享](identity-and-sharing.md)、[工作区格式](workspace-format.md) |
| 媒体库与存储 | [媒体库索引](media-library-evolution.md)、[存储位置](library-location.md) |
| 索引、定位与时间戳 | [渐进索引](progressive-indexing.md)、[统一索引](unified-indexing.md)、[FLV 时间线](flv-timeline.md)、[MP4 Range 边界](mp4-range-boundaries.md)、[时间戳兼容](timestamp-compatibility.md) |
| 色彩与帧资源 | [色彩链路契约](color-pipeline.md)、[HDR 支持](hdr-support.md) |
| 发现片源并显式准备 | [技术发现](library-discovery.md)、[严格 MP4](trusted-mp4-quality.md)、[暂停原生 FLV](paused-native-quality.md) |
| 单帧、ROI 与原帧证据 | [PSNR](source-plane-psnr.md)、[单帧桥](source-frame-pair-psnr.md)、[SSIM](source-plane-ssim.md)、[持久任务](source-psnr-jobs.md)、[GUI/Agent](psnr-task-workflow.md)、[ROI 候选](quality-roi-candidates.md)、[附件](annotation-psnr-evidence.md)、[只读查看](annotation-psnr-pair-view.md) |
| 声明参考并评分片段 | [对应计划](reference-clock-plans.md)、[区间与抽样](bounded-quality-ranges.md)、[前向身份](forward-frame-quality.md)、[重排身份](reordered-frame-quality.md) |
| 选择时域 / 无参考指标 | [分析 WASM 架构](analysis-wasm-scoring.md)、[VMAF](native-vmaf.md)、[CAMBI](native-cambi.md)、[XPSNR](native-xpsnr.md)、[同参考比较](xpsnr-comparison.md) |
| 观察、回收与重新执行 | [所有权](quality-ownership.md)、[任务中心](unified-task-center.md)、[显式重执行与存储迁移](explicit-quality-reexecution.md)、[实例资源](quality-resources.md) |
| HTTP Agent 与可选页面宿主 | [HTTP 接口](agent-http.md)、[评分工作流](agent-quality-workflow.md)、[本机页面桥](local-mcp-page-bridge.md) |
| 默认静音与单轨出声 | [顺带音频边界](opportunistic-audio.md) |
| 外观与界面 | [主题约定](../src/themes/README.md)、[本地化维护](localization.md) |

## 专项验证与诊断

- [合成媒体库验收](generated-library-acceptance.md)：生成夹具、执行矩阵与恢复基准；不以合成吞吐替代真实网络存储。
- [Windows 色彩验证](windows-color-validation.md)：独立 FFmpeg 平面对照与明确的验收边界。
- [SDR 本地取证](sdr-color-evidence.md)：同片同 PTS 诊断、报告字段与隐私边界。
- [Edge 原生 YUV 复现](edge-native-yuv-repro.md)：独立合成复现、固定上游源码定位与未确认根因；可重跑，不代表当前浏览器已经通过或失败。

## 发布历史与原始证据

- [稳定版 0.7.0](releases/0.7.0.md)、[1.0.0-alpha.3 预览版](releases/1.0.0-alpha.3.md)；全部发布说明按版本保留在 [releases/](releases/)，不随当前代码重写。
- [帧契约验收数据](frame-contract-acceptance.json)与 [evidence/](evidence/) 保留原始通过和失败产物。解释入口见 [本地化证据边界](localization.md#historical-evidence-and-limitations)、[HDR 验证](hdr-support.md#验证)、[测试证据边界](testing.md#历史证据的读取边界)。
- 不可丢失的旧色彩失败结论及固定版本来源集中在 [色彩证据边界](color-pipeline.md#历史负面证据的边界)。未提交的本地产物不能在当前 checkout 中复核。

已完成计划、过期审计、设计过程和重复阶段报告直接删除，不建归档副本；细节通过 Git 历史查询。当前约束并入负责该行为的文档，可重复执行的入口归入验证说明，不因整理而改变门限或把旧失败改写成通过。

- [紧凑格式与检索](code-format.md)、[可执行模块边界](module-boundaries.md)：格式迁移、宿主环境、领域依赖与循环门禁。
