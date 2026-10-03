# 文档导航

先查当前行为契约，再按 [验证说明](testing.md) 选择测试。历史记录保留当时的环境、分支、失败和证据，不把旧结果视为当前版本通过。测试范围与命令以 [统一清单](../scripts/testing/manifest.json) 为准。

## 当前行为与开发入口

| 主题 | 文档 |
| --- | --- |
| 开发启动与仓库约束 | [项目首页](../README.md)、[AGENTS.md](../AGENTS.md) |
| 架构与失败边界 | [架构](architecture.md)、[失败隔离](failure-isolation.md) |
| 测试、CI 与报告 | [验证说明](testing.md)、[迁移验收](testing-coverage.md)、[脚本索引](../scripts/README.md) |
| 独立程序运行与 HTTPS | [便携运行](../deploy/standalone.md) |
| 用户、访客、分享与工作区 | [身份与分享](identity-and-sharing.md)、[工作区格式](workspace-format.md) |
| 媒体库与存储 | [媒体库索引](media-library-evolution.md)、[存储位置](library-location.md) |
| 索引、定位与时间戳 | [渐进索引](progressive-indexing.md)、[统一索引](unified-indexing.md)、[FLV 时间线](flv-timeline.md)、[MP4 Range 边界](mp4-range-boundaries.md)、[时间戳兼容](timestamp-compatibility.md) |
| 色彩与帧资源 | [色彩链路契约](color-pipeline.md) |
| 外观与界面 | [主题约定](../src/themes/README.md) |

## 已完成计划与阶段验收

- [首版交付计划](roadmap.md)、[帧契约重构](frame-contract-roadmap.md)、[帧契约验收数据](frame-contract-acceptance.json)、[标注持久化交付](annotation-persistence-roadmap.md)。
- [合成媒体库验收](generated-library-acceptance.md)、[FATE 审计](fate-audit.md)、[0.2.1 可靠性验收](reliability-0.2.1.md)、[0.3.0 验收](verification-0.3.0.md)、[2026-09-12 本地编码验证](local-codec-validation-2026-09-12.md)。
- 发布说明按版本保留在 `releases/`，最近版本为 [0.4.0](releases/0.4.0.md)。使用者应结合对应版本阅读，当前测试数量查看实际报告。

## 色彩研究与历史证据

这些记录解释实现取舍和未通过的实验；当前准入、转换和回退规则统一查 [色彩链路契约](color-pipeline.md)。

- 原始资源与对照：[SDR 证据](sdr-color-evidence.md)、[Chromium 源码调查](chromium-color-source-investigation.md)、[Edge 原生 YUV 复现](edge-native-yuv-repro.md)、[原生 YUV 读回性能](native-yuv-readback-performance.md)。
- 管线实验与交接：[统一管线交接](unified-color-pipeline-handoff.md)、[CPU / memory-VideoFrame 阶段](unified-color-pipeline-status.md)、[WebGPU 实验](webgpu-color-experiment.md)、[2026-09-10 WebGPU 修复](webgpu-color-pipeline-status.md)、[设计审查](color-pipeline-design-review.md)。
- 平台与审计：[Windows 色彩验证](windows-color-validation.md)、[Windows WASM 修复](windows-wasm-rendering-fixes.md)、[2026-09-12 链路审计](color-path-audit-2026-09-12.md)。

维护时直接更新负责该行为的契约文档，并在验证说明登记可重复执行的检查。带日期、设备或分支的验收结论保留原始上下文，不滚动改写成最新结果；相关取证文件也不因整理文档而删除。
