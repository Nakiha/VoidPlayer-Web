# 工作区文件

“导出工作区”生成 `.voidplayer`：gzip 压缩的 UTF-8 JSON。导入按 gzip 文件头识别压缩，不依赖扩展名；菜单和拖入支持 `.voidplayer`、`.json`、`.gz`。压缩文件及解压内容上限均为 32 MiB。

当前格式为 `schema: "voidplayer-workspace"`、`version: 1`：

- `serverUrl`：导出页面的媒体服务地址；每个媒体库片源的 `source.url` 同时转换为绝对 HTTP(S) 地址。
- `media`：当前及历史标注引用的媒体身份和文件信息。视频字节、登录凭据不写入文件。
- `tracks`：当前打开的轨道，数组顺序即显示顺序；保留 slot、mediaId、offsetUs。
- `positionUs`：公共时间。导入后暂停；每个轨道按照自身偏移和时长显示相应帧，较短轨道停在末帧。
- `marks`：原始标注 ID、文字、作者、时间锚点、对比引用和矢量图形。标记形状和色系仍从 ID 推导，无额外身份状态。
- `viewport`：并排/分屏、排列、擦拭比例、缩放、平移和像素尺寸模式。
- `layout`：工具区展开状态、选中轨道、子轨道高度、标注列展开和宽度、文件名列宽度。导入时按当前窗口约束尺寸。
- `thumbnails`：已生成的 JPEG 标注预览。可省略；不影响矢量标注还原。

解析、版本检查及输入验证在 `src/workspace-file.ts`；`ReviewSession.restoreWorkspace` 在全部片源和目标帧就绪后替换会话，失败/取消时释放新解码器并保留原会话。界面、`window.voidPlayer` 和 WebMCP 的 workspace 工具共用同一条导入路径。

本地文件需重新授权选择，按名称、大小和修改时间匹配；也可将工作区和原视频一起拖入。此匹配不是内容哈希。媒体库引用按绝对 URL 打开，导入前检查 HTTP 状态和文件大小；服务迁移、权限变化或片源被替换时会报告失败。不同域部署仍受浏览器 CORS 和 HTTPS 混合内容规则约束，不绕过服务访问控制。

旧版 `voidplayer-web-review` v1 仍可读取：alignment 恢复轨道，媒体及标注原样保留，位置从 0 开始，使用默认对比视图；其相对片源 URL 使用导入页面的服务地址。旧 API `export_review` 保持兼容。

外观偏好属于接收者的浏览器，不随工作区覆盖。媒体库管理、服务端工作区存储和在线协作不在当前格式的实现范围内。
