# VoidPlayer Web

浏览器内的视频评审工具：最多四轨（A–D）同步播放、逐帧对比和矢量标注。优先使用 WebCodecs，不支持的编码组合通过本地 FFmpeg WASM 解码；不上传视频、不播放音频。

## 启动

需要 Node.js 24+。首次运行：

```sh
npm ci
bash scripts/sync-wasm-core.sh
bash scripts/sync-samples.sh
cp voidplayer.config.example.json voidplayer.config.json
npm run dev
```

开发页面为 http://127.0.0.1:5178/，媒体 API 为 5180。配置文件中的 `mediaRoots` 指定媒体库白名单目录。解码 core 来自独立的 `VoidPlayer-FFmpeg-Build` 仓库 `wasm` 分支，也可通过 `WASM_CORE_DIR` 指向已构建产物。

使用正式构建：

```sh
npm run build
npm run serve
```

打开 http://127.0.0.1:5180/。仅播放浏览器选择的本地文件时，也可将 `dist/` 作为静态网站通过 HTTPS 提供；服务端媒体库为可选功能。

后台服务、配置、内网 HTTPS、账号及发布方式见 [部署说明](deploy/README.md)。

## 当前功能

- 并排、田字布局与双轨分屏擦拭；缩放最高 500×，支持平移、轨道排序和偏移。
- 空格播放/暂停，左右方向键逐帧；正在输入文字或使用输入法时保留输入行为。完整快捷键见应用内“更多操作 → 快捷键与说明”。
- 公共时间轴使用所有轨道偏移后的最大结束时间；短轨道结束后保持最后一帧。
- 暂停画面拖动、N 快捷键或标注列表可进入编辑。支持图形、文字、移动、缩放、擦除和撤销；修改自动写入当前评审会话。
- 标注列表、时间轴和折叠栏使用 ID 推导的五种形状与八种色系；不保存身份外观，允许重复。悬停可预览已有标注缩略图。
- 轨道检查显示编码、像素格式、色域原色、传递特性、矩阵系数和 PC/TV 范围；未标记信息保持未知。

## 数据与限制

**标注仍只保存在当前页面会话中，关闭或刷新前请导出评审。** 最近片源记录和本地诊断日志不能恢复标注。

视频在浏览器内解码。非 FLV 的 WASM 回退需要整文件进入内存，文件上限 512 MiB；FLV 使用分块读取和独立解封装。WASM 图像输出为 8-bit RGBA，支持解码 HDR 文件不代表验证了 HDR 显示效果。当前不支持直播、音频播放和服务端评审持久化。

诊断日志保存在本机 IndexedDB，只有用户在日志面板明确点击上传时才发送到配置的服务器。

## 开发入口

- [架构与行为边界](docs/architecture.md)：会话、解码、呈现、标注与 Agent 接口。
- [验证说明](docs/testing.md)：单元、浏览器、真实 WASM 和播放基准。
- [主题与 UI 约定](src/themes/README.md)：颜色、材质、密度及主题适配边界。
- [媒体库备选演进方案](docs/media-library-evolution.md)：尚未实施，不是当前迭代承诺。
- [AGENTS.md](AGENTS.md)：仓库工作约束。

文档记录当前行为和可重复执行的验证方式。历史实现与验收流水保留在 Git，不继续累加到首页。
