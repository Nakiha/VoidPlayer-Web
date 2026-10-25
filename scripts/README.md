# 脚本职责索引

自动回归的选择以 [测试清单](testing/manifest.json) 为准；本地与 CI 共用 [执行入口](run-tests.mjs)。使用说明见 [验证文档](../docs/testing.md)。原有顶层命令保留兼容，实际实现通过清单的 `implementation` 关联；不要同时执行兼容入口与实现文件。

| 职责 | 目录或保留的专用入口 | 使用方式 |
| --- | --- | --- |
| 自动回归与基础设施 | `testing/`、`run-tests.mjs`、`run-browser-regressions.mjs`；专用 `check-*` 在清单中登记 | 使用 suite/case 筛选；required 决定门禁 |
| 开发与资源维护 | `tools/development/make-icons.mjs`；`dev.ts`、`service.mjs`、`clean.mjs` | 显式开发命令；不加入回归门禁 |
| 夹具准备 | `tools/fixtures/{make-library-fixtures,sync-fate-samples}.mjs`；`sync-samples.sh`、`sync-wasm-core.sh`、`make-{flv,hlg}-fixture*`、`tools/fixtures/read-vtm-analysis.py`（独立 VTM 块统计冻结） | 每个 job 准备一次只读素材；合成可写素材由 case 独占 |
| 诊断与复现 | `tools/diagnostics/repro-native-yuv-color.mjs`；其余 `repro-*`、`diagnose-*` | 操作者显式运行；诊断成功不代表验收通过 |
| 性能 | `tools/perf/bench-frame-index.mjs`；其余 `bench-*`、`compare-index-scan-modes.mjs` | `perf` 套件或专用参数；显式 informational |
| 发布与产物 | `tools/release/release-version.mjs`；`package-release.mjs`、`prepare-release-core.mjs`、`check-release*.mjs`、`stage-release.mjs` | workflow 管理原生平台、产物依赖和草稿；回归不触发发布 |

目录整理按契约、真实媒体、轻量逻辑、服务、其余逻辑和工具分批进行。带专用启动、打包或平台约束的工具继续保留原有入口和实现，职责由本索引及 manifest 的 kind、restrictions、required 明确区分；不能根据 `check-` 或 `test:` 名称推断它是门禁。

新增浏览器或 Node 回归必须登记稳定 ID、矩阵与前置条件。领域浏览器和 `tools/` 中的模块都纳入漏登记检查；工具例外要给出理由且 `required=false`。复用 helper 不单独作为一次回归执行，Node helper 与 Worker 位于 `test/helpers/`。固定参考 JSON、媒体生成入口和旧 Worker URL 保留兼容，不重生成参考结果。

原生 HDR 浮点呈现：`npm run test:hdr:native` 检查实际默认能力与降级；`node scripts/check-native-hdr-browser.mjs chrome --require-native --experimental-hdr [--qa]` 在独立有窗口测试浏览器验证浮点转换和真实播放，详见 `docs/hdr-support.md`。

## 前端与独立包版本

Vite 与独立程序共用 `release-version.mjs` 的版本规则。标签构建必须在构建网页和打包两个步骤使用同一个 `VOIDPLAYER_RELEASE_TAG`；标签必须匹配包版本、指向当前修订且工作区干净。分支构建保留 `-preview.<修订>`（有未提交改动时附加 `.dirty`）；无 Git 的源码网页构建标为 `-development`，不能据此制作正式包。

`dist/build-info.json` 与网页模块由同一份构建信息生成。打包前校验版本、完整修订、标签和工作区状态，防止把预览网页装进正式程序。`release-version-browser` 在 Linux/Windows 原生 CI 中从解压包检查首页及关于页面，与服务端和 manifest 的版本逐字一致；可用 `node scripts/check-release-browser.mjs /path/to/package.tar.gz chromium --version-only` 单独运行，不需要视频素材。


## 播放核心同步与打包前校验

`sync-wasm-core.sh` 同时接受上游相邻 ST/MT 原始构建目录和扁平 release-core artifact。同步先准备完整目录，再替换目标；缺少 MT 的本地原始构建会移除旧 MT 和旧 provenance，避免单线程新版本与多线程旧版本混用。带 provenance 的 artifact 必须匹配 `release-core.json` 且通过逐文件 SHA-256 校验，失败保留原目标。正式打包必须包含 ST/MT 两套核心。

`package-release.mjs` 在创建输出和编译独立程序之前，验证 `dist` 中播放/分析核心的来源锁、逐文件哈希、分析 manifest 和 build ID；本地打包与 CI 均适用。未固定来源的本地核心仍可开发调试，但不能打包为可追溯的发布产物。验证逻辑由 `core-artifacts.mjs` 共用，契约测试覆盖版本混用、篡改、原始单线程替换和失败回滚。

静态资源 gzip 固定零时间戳与 OS=255（unknown），避免 Node/zlib 的宿主 OS 标记让三平台共享 core 的压缩文件产生不同哈希。所有压缩表示仍有独立哈希与解压内容校验，发布汇总继续逐字节比较共享核心及其 sidecar。

码流遮罩真实几何回归：`node scripts/testing/browser/media/bitstream-geometry.mjs webkit`（或 `chromium`），生成独占的裁剪/SAR/旋转 MP4，验证实际视频、遮罩像素、命中、分屏截图及 RGBA 回退。已登记在 `browser` 和 `ci-analysis-browser`，需要 ffmpeg/libx264。

码流分析持续争用：`node scripts/bench-analysis-sustained.mjs webkit`，需已构建网页、两种 core、QA 视频和可见桌面。默认运行至少 120 秒，8 路实际消费独立媒体库流，中途持久化 8→4→8 并发设置；旁路运行原 4×3×8 秒播放基准和 seek/Range 探测，阈值不变。`ANALYSIS_STRESS_MS` 可设为 120000–600000。报告保存在 `.run/browser-fixtures/analysis-sustained-webkit/`，包括逐秒 CPU/RSS/每路消费数、Range/seek 分位数、逻辑 I/O、取消延迟及原始播放数据。已登记为 `perf-analysis-sustained`；测量范围由机器和素材限定，不能推断任意并发或硬件的性能。

分析产品 #99 的 Mac 配对入口：先从干净 baseline / candidate 独立 worktree 运行
`node scripts/tools/perf/analysis-products-build.mjs /path/to/baseline /path/to/candidate`，
再运行 `node scripts/tools/perf/analysis-products-pair.mjs --baseline /path/to/baseline --candidate /path/to/candidate --pairs 5 --output /path/to/evidence`。
两个构建只添加相同的 session 访问句柄，不插入逐帧序列化；fixture 自建随机端口、临时数据库、独立 Chromium profile 并清理。
`LIFECYCLE=1 VARIANTS=implementation` 测暂停/恢复及精确块；`EXACT=1` 测相同预置状态下的精确块 API。
这些是指定 Mac 的人工性能验收，不把其绝对时限纳入共享 CI；回归测试另在统一 manifest 注册。

`analysis-products-pair.mjs` accepts `PRODUCT=summary|blocks|legacy`, `LIFECYCLE=1` / `PAUSE_ONLY=1`, `FULL_STREAM=1`, and `TRACE_PUTS=1` for actual 30-AU pause/resume coverage and per-AU consumer/server put evidence. Default five-pair summary measurements do not enable put tracing.

## 固定 FATE 素材缓存

`node scripts/sync-fate-samples.mjs` 校验两个固定 manifest 的每个素材（普通文件、精确字节数、SHA-256），只为缺失文件访问原始 `https://fate-suite.ffmpeg.org/` URL。损坏的已有文件立即失败，不静默替换；须调查后显式移除损坏缓存再准备。下载仍使用原来的三次有限传输重试，完整校验后以临时文件原子安装。`--verify` 禁止下载并要求全部存在；`--cache-key` 输出包含两份完整 manifest 的 SHA-256 键。

完整 CI 的三个 FATE 消费 job 使用 `.github/actions/fate-fixtures`，按精确键恢复 `fixtures/fate`，每次恢复后（包括命中）仍完整校验，成功后立即保存，再开始产品回归。无宽泛恢复键，不改素材、测试或阈值。缓存只加速固定公开素材，不是信任来源；冷缓存/被驱逐/不完整时仍依赖官方源，官方不可达就失败。损坏的精确键不可覆盖，需显式处理远端坏缓存；不能靠下载替换隐藏问题。缓存保存与后续命中须看 Actions 实际日志确认，本地通过不证明远端已有种子或上游网络恢复。

- `check-quality-workflow-browser.mjs`：完整服务端 PSNR GUI 任务闭环（Chromium/WebKit × 8/10 位），实际 UI 提交、持久状态/取消/历史、显式已有标注证据和原帧对查看，要求真实 core；登记于完整 `ci-cache`。

- `tools/fixtures/quality-forward.mjs`：生成固定 H.2648/HEVC10 无重排普通依赖帧 FLV 与独立 FFmpeg 原始平面对照、精确时钟和 SHA-256。完整依赖窗口、GUI/Agent/证据/原帧复核见 [工作流契约](../docs/forward-frame-quality.md)；`check-quality-workflow-browser.mjs chromium 8 forward`（另有 WebKit/10bit）登记为现有 core-backed `ci-ssim` 的必需用例，不替换旧 PSNR/SSIM 检查。
