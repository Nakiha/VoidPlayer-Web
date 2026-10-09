# 脚本职责索引

自动回归的选择以 [测试清单](testing/manifest.json) 为准；本地与 CI 共用 [执行入口](run-tests.mjs)。使用说明见 [验证文档](../docs/testing.md)。原有顶层命令保留兼容，实际实现通过清单的 `implementation` 关联；不要同时执行兼容入口与实现文件。

| 职责 | 目录或保留的专用入口 | 使用方式 |
| --- | --- | --- |
| 自动回归与基础设施 | `testing/`、`run-tests.mjs`、`run-browser-regressions.mjs`；专用 `check-*` 在清单中登记 | 使用 suite/case 筛选；required 决定门禁 |
| 开发与资源维护 | `tools/development/make-icons.mjs`；`dev.ts`、`service.mjs`、`clean.mjs` | 显式开发命令；不加入回归门禁 |
| 夹具准备 | `tools/fixtures/{make-library-fixtures,sync-fate-samples}.mjs`；`sync-samples.sh`、`sync-wasm-core.sh`、`make-{flv,hlg}-fixture*` | 每个 job 准备一次只读素材；合成可写素材由 case 独占 |
| 诊断与复现 | `tools/diagnostics/repro-native-yuv-color.mjs`；其余 `repro-*`、`diagnose-*` | 操作者显式运行；诊断成功不代表验收通过 |
| 性能 | `tools/perf/bench-frame-index.mjs`；其余 `bench-*`、`compare-index-scan-modes.mjs` | `perf` 套件或专用参数；显式 informational |
| 发布与产物 | `tools/release/release-version.mjs`；`package-release.mjs`、`prepare-release-core.mjs`、`check-release*.mjs`、`stage-release.mjs` | workflow 管理原生平台、产物依赖和草稿；回归不触发发布 |

目录整理按契约、真实媒体、轻量逻辑、服务、其余逻辑和工具分批进行。带专用启动、打包或平台约束的工具继续保留原有入口和实现，职责由本索引及 manifest 的 kind、restrictions、required 明确区分；不能根据 `check-` 或 `test:` 名称推断它是门禁。

新增浏览器或 Node 回归必须登记稳定 ID、矩阵与前置条件。领域浏览器和 `tools/` 中的模块都纳入漏登记检查；工具例外要给出理由且 `required=false`。复用 helper 不单独作为一次回归执行，Node helper 与 Worker 位于 `test/helpers/`。固定参考 JSON、媒体生成入口和旧 Worker URL 保留兼容，不重生成参考结果。

原生 HDR 浮点呈现：`npm run test:hdr:native` 检查实际默认能力与降级；`node scripts/check-native-hdr-browser.mjs chrome --require-native --experimental-hdr [--qa]` 在独立有窗口测试浏览器验证浮点转换和真实播放，详见 `docs/hdr-support.md`。
