# AGENTS.md

VoidPlayer Web：浏览器内的视频评审工具。WebCodecs 优先、自建裁剪版 FFmpeg WASM 兜底
（FFV1 / MPEG-2 TS / H.266 / 浏览器不支持的 profile 组合）。

## 结构

- `src/`：页面与会话。`session.ts` 是 UI 和 Agent 共用的唯一会话；`media.ts`
  WebCodecs 路径；`ffmpeg-media.ts` + `ffmpeg-worker.ts` WASM 回退（Worker 内运行）；
  `presenter.ts` 唯一决定帧如何上屏；`log.ts` / `log-panel.ts` / `log-storage.ts`
  本地诊断日志；`agent.ts` WebMCP 工具；`library.ts` / `library-panel.ts` 媒体库客户端。
- `server/`：零依赖 Node 媒体库服务（白名单目录 + Range 流式 + 日志上传），可选。
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
node scripts/bench-playback.mjs webkit    # 需要先起 npm run serve
```

改动播放/解码路径后必须跑 bench；改动载入路径后跑测试即可。
