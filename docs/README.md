# 文档导航

先查当前行为契约，再按 [验证说明](testing.md) 选择测试。历史记录保留当时的环境、分支、失败和证据，不把旧结果视为当前版本通过。测试范围与命令以 [统一清单](../scripts/testing/manifest.json) 为准。

## 当前行为与开发入口

| 主题 | 文档 |
| --- | --- |
| 开发启动与仓库约束 | [项目首页](../README.md)、[AGENTS.md](../AGENTS.md) |
| 架构与失败边界 | [架构](architecture.md)、[失败隔离](failure-isolation.md)、[容器恢复](container-recovery.md) |
| 测试、CI 与报告 | [验证说明](testing.md)、[迁移验收](testing-coverage.md)、[脚本索引](../scripts/README.md) |
| 独立程序运行与 HTTPS | [便携运行](../deploy/standalone.md) |
| 用户、访客、分享与工作区 | [身份与分享](identity-and-sharing.md)、[工作区格式](workspace-format.md) |
| 媒体库与存储 | [媒体库索引](media-library-evolution.md)、[存储位置](library-location.md) |
| 索引、定位与时间戳 | [渐进索引](progressive-indexing.md)、[统一索引](unified-indexing.md)、[FLV 时间线](flv-timeline.md)、[MP4 Range 边界](mp4-range-boundaries.md)、[时间戳兼容](timestamp-compatibility.md) |
| 色彩与帧资源 | [色彩链路契约](color-pipeline.md)、[HDR 支持](hdr-support.md) |
| 默认静音与单轨出声 | [顺带音频边界](opportunistic-audio.md) |
| 外观与界面 | [主题约定](../src/themes/README.md)、[本地化维护](localization.md) |

## 发布历史与保留证据

- [最新版本 0.7.0](releases/0.7.0.md)；全部发布说明按版本保留在 [releases/](releases/)。对应版本的限制与验收结果不随当前代码重写。
- [帧契约验收数据](frame-contract-acceptance.json)、[合成媒体库验收](generated-library-acceptance.md)、[FATE 审计](fate-audit.md)。这些是历史环境的记录，当前测试数量和通过状态以实际报告为准。
- [本地化证据及解释](localization.md#historical-evidence-and-limitations)、[HDR 证据](hdr-support.md#验证)以及 [evidence/](evidence/) 保留通过与失败样本，不因整理文档删除。

## 色彩研究与历史证据

这些记录解释实现取舍和未通过的实验；当前准入、转换和回退规则统一查 [色彩链路契约](color-pipeline.md)与 [HDR 支持](hdr-support.md)。

- 原始资源与对照：[SDR 证据](sdr-color-evidence.md)、[Chromium 源码调查](chromium-color-source-investigation.md)、[Edge 原生 YUV 复现](edge-native-yuv-repro.md)、[原生 YUV 读回性能](native-yuv-readback-performance.md)。
- 平台与审计：[Windows 色彩验证](windows-color-validation.md)、[设计审查](color-pipeline-design-review.md)、[2026-09-12 链路审计](color-path-audit-2026-09-12.md)。

维护时直接更新负责该行为的契约文档，并在验证说明登记可重复执行的检查。已完成计划、过期交接和重复阶段报告不再留副本，可通过 Git 历史查询。带日期、设备或分支的保留证据仍按原始上下文解读，不滚动改写成最新结果。
