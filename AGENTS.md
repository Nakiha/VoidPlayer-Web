# AGENTS.md

VoidPlayer Web：浏览器内的视频评审工具。WebCodecs 优先、自建裁剪版 FFmpeg WASM 兜底
（FFV1 / MPEG-2 TS / H.266 / 浏览器不支持的 profile 组合）。

## 结构

- `src/`：页面与会话。`session.ts` 是 UI 和 Agent 共用的唯一会话；`media.ts`
  WebCodecs 路径；`ffmpeg-media.ts` + `ffmpeg-worker.ts` WASM 回退（Worker 内运行）；
  `presenter.ts` 唯一决定帧如何上屏；`viewport.ts` 对比布局（并排/分屏）、缩放、
  平移与像素尺寸模式的纯几何/状态（DOM 接线在 `main.ts`，标注走独立视口 SVG viewBox，视频走 viewport-sized WebGL 采样 +
  clip-path，不动解码路径）；`log.ts` / `log-panel.ts` / `log-storage.ts`
  本地诊断日志；`agent.ts` WebMCP 工具；`library.ts` / `ui/source-catalog.ts` / `ui/workbench.ts` 媒体库与工具区；`ui/track-drag.ts` 排序输入；`ui/seek-preview.ts` 时间预览/标注吸附；`ui/source-actions.ts` 服务连接和文件操作。
- `src/flv-demux.ts` / `flv-engine.ts` / `flv-decoder.ts`：Worker 内的 FLV 分块读取、索引及压缩包解码；`flv-media.ts` 接入共享 MediaSource。FLV 不进入 FFmpeg 解封装。
- `server/`：基于 Node API 的零依赖服务（本地 SQLite 持久化索引 + 后台扫描 + Range + 静态网页 + 可信网关身份）；开发使用 Node 24+，`standalone.ts` 用固定 Bun 编译成独立程序；`config.ts` / `runtime.ts` 为共享配置与运行入口。
- `scripts/dev.ts` 同进程启动 Vite 和媒体 API；`scripts/service.mjs` 管理 macOS 用户服务；`deploy/` 为内网 HTTPS / 独立账号部署模板。
- `test/`：node:test，无浏览器依赖；WASM 用例在 Node worker_threads 里跑真实 core。
- `scripts/`：`sync-wasm-core.sh`（从 VoidPlayer-FFmpeg-Build 产物同步 core，可用
  `WASM_CORE_DIR` 覆盖）、`sync-samples.sh`（样片进 `fixtures/video/`，可用
  `VOIDPLAYER_SAMPLES` 覆盖）、`bench-playback.mjs`（Playwright 离屏播放基准）。
- `public/vendor/voidplayer-core/`：gitignored 的 core 产物，由 sync 脚本填充。

## 硬约束

- UI 与 Agent 必须共用 `session.ts` 的行为，不允许各自实现。
- 日志只留本地（IndexedDB），上传仅由用户在日志面板显式触发。
- 解码路径选择按失败阶段决定（`MediaOpenError.stage`），不要新增“整体 try/catch 换路径”。
- 帧资源必须显式 `close()`；解码后端不直接画 canvas（必须经过 `presenter.ts`）。
- WASM core 的构建和裁剪在 `VoidPlayer-FFmpeg-Build` 仓库（分支 `wasm`），本仓库只消费产物。
- 标注坐标相对源帧，可延伸到视频外的对应视口；线宽 `strokeWidth` 存 CSS 像素，不随缩放变化。网格 < 视频 < 标注 < 半透明 UI；不要在标注 SVG 上加视频边界裁剪。
- 标注以矢量对象保存，UI/Agent 编辑共用 `session.updateMark`；采样策略由 presenter / presentation-surface 负责，缩小 LINEAR、放大 NEAREST，不放大 CSS 的中间位图。

## 验证

```sh
npm test                 # 单元 + Node 内真实 WASM 解码
npm run build            # tsc --noEmit && vite build
npm run fixtures:flv     # 从 QA 样片生成 FLV 回归素材（需要 ffmpeg/ffprobe）
npm run test:annotations:rendering # DPR 2 双轨连续缩放、最终像素、图层与工具条约束
npm run test:annotations:browser # 标注交互与实际采样像素回归
npm run test:flv:browser # FLV WebKit 解码、Range、seek 和播放回归
npm run test:saved-workspaces:browser # 双窗口冲突、副本、管理与服务重启还原
npm run test:admin:browser # 管理配置/日志、主动测速取消与亮暗响应式布局
npm run test:library:browser # 目录分页、搜索、离线恢复与版本引用（WebKit）
npm run test:browser     # 构建 + WebKit UI 回归，自建临时服务并清理
node scripts/bench-playback.mjs webkit    # 需要先起 npm run serve
```

改动播放/解码路径后必须跑 bench；改动载入路径后跑测试即可。
改动视图尺寸调度、轨道操作或片源 UI 后跑 test:browser；需先同步样片/core 并安装 Playwright WebKit。

## 独立发布

- 正式打包走 `.github/workflows/release-preview.yml`：固定解码器源码/工具链后准备共享 core，再在 Linux x64、Windows x64、macOS ARM64 原生 runner 打包和测试。
- `scripts/release-core.json` 固定上游修订，更新前先推送解码器源码；不要引用本地未提交改动或浮动版本。
- `scripts/package-release.mjs` 生成独立程序、资源、来源清单与校验和；`npm run test:release` 校验解压产物，无需真实片源。分支上传预览 artifact；版本标签需匹配包版本和发布说明，经三平台汇总校验后生成 Release 草稿，不自动公开发布。`node --test test/release-pipeline.test.mjs` 验证版本、产物汇总和草稿重跑边界。
