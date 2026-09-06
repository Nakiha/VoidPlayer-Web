# AGENTS.md

VoidPlayer Web：浏览器内的视频评审工具。WebCodecs 优先、自建裁剪版 FFmpeg WASM 兜底
（FFV1 / MPEG-2 TS / H.266 / 浏览器不支持的 profile 组合）。

## 结构

- `src/`：页面与会话。`session.ts` 是 UI 和 Agent 共用的唯一会话；`media.ts`
  WebCodecs 路径；`ffmpeg-media.ts` + `ffmpeg-worker.ts` WASM 回退（Worker 内运行）；
  `presenter.ts` 唯一决定帧如何上屏；`viewport.ts` 对比布局（并排/分屏）、缩放、
  平移与像素尺寸模式的纯几何/状态（DOM 接线在 `main.ts`，呈现走 CSS transform +
  clip-path，不动解码路径）；`log.ts` / `log-panel.ts` / `log-storage.ts`
  本地诊断日志；`agent.ts` WebMCP 工具；`library.ts` / `ui/source-catalog.ts` / `ui/workbench.ts` 媒体库与工具区；`ui/track-drag.ts` 排序输入；`ui/seek-preview.ts` 时间预览/标注吸附；`ui/source-actions.ts` 服务连接和文件操作。
- `server/`：零依赖 Node 24+ 服务（共享媒体索引 + Range + 静态网页 + 可信网关身份）；`config.ts` / `runtime.ts` 为开发与正式运行共享入口。
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

## 验证

```sh
npm test                 # 单元 + Node 内真实 WASM 解码
npm run build            # tsc --noEmit && vite build
npm run test:browser     # 构建 + WebKit UI 回归，自建临时服务并清理
node scripts/bench-playback.mjs webkit    # 需要先起 npm run serve
```

改动播放/解码路径后必须跑 bench；改动载入路径后跑测试即可。
改动视图尺寸调度、轨道操作或片源 UI 后跑 test:browser；需先同步样片/core 并安装 Playwright WebKit。
