# Sites 部署与线上验收

站点：[VoidPlayer 本地视频评审](https://voidplayer-local-review.akanemeguri1296.chatgpt.site)。
当前访问范围为公开：任何取得链接的人都可以打开播放器，无需 ChatGPT 登录。
2026-11-09 按用户要求由所有者私有改为公开；下文私有访问结果为首次上线时的历史记录。

- Site ID：`appgprj_6af0985045708191bd98833d76761fad`。
- 部署专用源码目录：`artifacts/sites-hosted/`；绑定身份在该目录的 `.openai/hosting.json`。
- 上游实现已合入 `main`；原实现分支为 `codex/sites-local-player`。
- 便携构建目录仍为 `artifacts/sites/`，不携带已注册 Site 的身份。

后续更新复用同一 Site 和专用源码仓库，不重复注册。先构建并验证本地静态版，
再同步 `dist/` 到专用目录，保留 `.openai/hosting.json` 和 `.git`；
使用 Sites 源码工作流提交、推送、打包，并部署返回的同一份提交与归档。
写入凭据仅在工具会话内使用，不保存到仓库、构建目录或验收记录。

## 2026-11-08 线上环境

验收使用 ChatGPT 内置浏览器、真正的 Sites HTTPS 地址和本地合成的短视频，未上传媒体或日志。

| 项目 | 观察 |
| --- | --- |
| 私有访问 | 匿名访问显示 ChatGPT 登录页；登录后播放器正常启动 |
| H.264 / MP4 | WebCodecs，128×72，WebGPU external 呈现；定位与逐帧有效 |
| FFV1 / Matroska | 单线程 FFmpeg WASM，64×48，WebGPU YUV 呈现 |
| MJPEG / AVI | 单线程 FFmpeg WASM，64×48；FFmpeg 容器读取有效 |
| 本地深度分析 | 独立分析 Worker 返回 H.264 精确结果，40 个块 |
| 标注与导出 | 三轨、一条标注、名称与片源搜索写入下载的工作区文件 |
| 本机恢复 | 刷新后仍显示恢复记录，恢复标注、名称和搜索；普通文件输入没有持久句柄时跳过视频并提示 |
| 静态资源 | 启动脚本、浏览器 Worker、播放/分析 core 的 20 份二进制/文本资源与构建逐字节一致；WASM MIME 为 `application/wasm` |
| HTML | `/index.html` 归一化到 `/`；宿主修改 HTML，但原有启动引用与应用 shell 保留 |
| 隔离响应头 | 未观察到 COOP / COEP；不宣称在线多线程能力 |

普通文件输入不保存持久文件句柄，不能把刷新后的本机恢复理解为自动重新取得媒体授权。
因此 Sites 的工作区导入窗口增加组合选择：一次选择一份工作区和对应原视频，
继续使用现有的本地媒体身份匹配、源打开、标注与布局恢复规则，不改变工作区格式。

组合导入的回归先在修复前失败：原选择器不接受多个文件；修复后 WebKit/Chromium 通过。
在无隔离场景使用真实组合选择器，在隔离场景保留工作区与原视频拖入覆盖，无新增内部素材矩阵。
修复前后日志分别为 `.run/sites-online/import-before.log` 与 `.run/sites-online/import-after.log`。
线上资源报告为 `.run/sites-online/assets.json`，截图在 `.run/sites-online/`；
这些证据只代表本次浏览器与短样片，不替代其他浏览器、大文件或性能验收。

## 2026-11-09 修正版复验

修正版已部署到同一私有站点，部署状态为 `succeeded`：

- 应用提交：`f3fd62c1524ec8fb829cee6b88744d55b31ece37`。
- Sites 源码提交：`9416fa4decec028bef4c1e20bccc1e89bd1854b3`。
- 部署 ID：`appgdep_6af09c1d3c508191b5ea29c7b9af625a`。
- 线上组合选择器允许同时选择工作区与原视频，实测恢复三轨、一条标注、
  `300000 µs` 位置、工作区名以及 `local` 片源搜索；恢复后可见标注卡片。
- HTTPS 安全上下文为真，`crossOriginIsolated` 和 SharedArrayBuffer 为假；
  FFV1、AVI 均采用现有单线程 core，未增加服务端解码或视频上传路径。

三轨 30 fps / 2 秒小尺寸合成片的线上播放检查通过：每轨实际绘制 59 帧、
零丢帧，约 0.999 倍速；P95 绘制间隔约 35 ms、最长约 37 ms，暂停约 1.4 ms，
暂停后无迟到画面。原 10 fps 片的 P95 自然约 103 ms，触发固定 75 ms 门槛；
这是素材帧率与门槛不匹配，保留原始失败报告，不据此修改性能门槛或声称播放回归。
这轮实测不代表大文件、高分辨率或其他机器的性能验收。

证据：`.run/sites-online/playback.json`、`.run/sites-online/playback30.json`、
`.run/sites-online/final.jpg`；本地 Sites 双浏览器回归、完整版基础 WebKit 回归、
快速套件 65/65、构建及格式检查均通过。最终 UI 验收使用内置浏览器，
不把先前本机 WebKit/Chromium 的静态服务回归描述为两种浏览器均已在线实测。

## 2026-11-09 主干与公开访问

实现与验收记录已快进合入并推送到 `origin/main`（合入点 `6b39dc3d`）。
现有 Site 的访问策略更新为 `public`，策略修订为 2，没有重新创建站点或修改部署代码。
匿名 HTTP 请求未携带 Cookie、Authorization 或 Sites 服务凭据，首页返回 200、
`text/html`，包含播放器应用 shell 与启动脚本，不含登录门禁。
验证结果保存在 `.run/sites-online/public-access.json`。
公开访问仅改变网页的可访问范围，访客本地视频与标注仍在各自浏览器内处理。
