# Sites 部署与线上验收

站点：[VoidPlayer 本地视频评审](https://voidplayer-local-review.akanemeguri1296.chatgpt.site)。
访问范围为所有者私有，通过 ChatGPT 登录；没有开启公众访问。

- Site ID：`appgprj_6af0985045708191bd98833d76761fad`。
- 部署专用源码目录：`artifacts/sites-hosted/`；绑定身份在该目录的 `.openai/hosting.json`。
- 上游实现分支：`codex/sites-local-player`。
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
