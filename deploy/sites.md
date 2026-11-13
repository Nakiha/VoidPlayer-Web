# VoidPlayer Sites 本地文件版

这是独立的静态分发目标，复用完整版的播放器、呈现、标注与本地分析实现。
视频在浏览器中读取，不上传。无需启动 VoidPlayer Node 服务。

## 构建与交付

- `npm run dev:sites`：开发预览，不代理媒体 API，也不提供跨源隔离响应头。
- `npm run build:sites`：检查并生成 `artifacts/sites/`，不覆盖完整版 `dist/`。
- `npm run package:sites`：额外生成 `artifacts/voidplayer-sites.tar.gz`。

以上命令在 VoidPlayer-Web 源码仓库运行。交付目录是无需再次构建的静态项目，不需要安装 Node 服务或 npm 依赖。

构建前沿用完整版的固定播放 core / 分析 core 同步流程；core 是忽略的本地产物，
仅把源码传给其他环境时须重新同步。导出目录已经包含运行需要的 WASM、Worker、主题与许可证。

交付项目包含 `dist/index.html`、静态资源和 `.openai/hosting.json`。
它尚未绑定 Site，首次通过 Sites 注册时填入真实 `project_id`，后续部署保留此身份。
不要运行完整版的 `package-release.mjs`，也不要把 Node 程序或本机数据目录放入 Site。
当前命令只构建本地产物，不注册、发布 Site 或改变站点访问范围。

## 保留与裁剪

保留本地视频、多轨对比、逐帧、像素取样、截图、矢量标注与码流分析。观看条件通过 ABI 1 URI 参数表达，本地引用只包含文件身份/元数据，不包含字节或路径。当前页面可以直接应用 URI 视图状态；重开本地文件仍需要已授权句柄，普通文件选择不保证刷新后能读取。

不装配服务器身份、媒体库轮询、文件管理、压缩分享、远端标注同步、日志上传、stdio 页面桥或 PWA。远端 URI 片源在任何网络请求前明确拒绝。没有服务器工作区、文件导入导出或本机工作区检查点。标注保存在本机当前片源身份下，不上传。

## 部署环境验收

使用 HTTPS；本地预览可以使用浏览器认可的 localhost 安全上下文。
在最终 Sites URL 上验证文件选择、拖入、浏览器 Worker、WASM MIME/CSP、
WebCodecs 和 GPU 能力，不能以本地测试代替托管环境验证。

默认静态版本不假定可设置 COOP / COEP，也不假定内嵌页面能取得跨源隔离。
无隔离时沿用已有单线程 WASM 与本地 Blob / FileReaderSync 路径；
有隔离时仍可使用现有多线程路径。未修改解码策略和色彩合同。
远程 FFmpeg Range 读取仍需要 SharedArrayBuffer，本版本不提供远程媒体入口。
如果托管环境不支持某项能力，应在原有能力探测和失败阶段规则内处理，
不要整文件下载远程视频、伪造隔离或绕过既有错误回退策略。

## 回归范围

Sites 浏览器回归用纯静态 HTTP 服务，不启动媒体 API；对所有 `/api/` 请求设为失败。
在无隔离与有隔离环境检查本地解码，并验证标注、本地 URI 状态往返、
本地搜索和服务功能裁剪。完整版继续运行原有基础浏览器回归。

运行 `npm run test:sites:browser` 检查 WebKit，追加 `-- chromium` 检查 Chromium。
用例登记在统一清单，并进入 `ci-pr-browser`；每个浏览器分别执行无隔离和有隔离两个场景。
素材为本地生成的 1 秒 H.264、FFV1/Matroska、MJPEG/AVI，不依赖 QA 样片。
本机每个浏览器约 8 秒，包含一次专用构建；这不是性能门禁或跨机器时限。

新增覆盖针对现有浏览器回归始终运行媒体服务、无法证明静态版不调用 API 的缺口。
独立预期是媒体 API 请求为零、服务功能不出现在用户/Agent 入口、本地分析不移动播放位置、
标注与搜索/布局在当前片源 URI 状态往返后保留；远端 URI 引用在请求前拒绝并保留原会话。
真实浏览器层用于验证 Worker/WASM、文件下载/拖入、IndexedDB 与隔离能力，
不另加源码布局断言或重复模拟解码测试。生成文件与报告均在 `.run/sites-browser/`。

打包校验播放/分析 core 的 release lock、来源与逐文件哈希，并生成归档 SHA-256。
发布前仍需在最终托管 URL 做实际验收；本地通过不代表 Sites 响应头或内嵌权限已经验证。
