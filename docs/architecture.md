# 架构与行为边界

## 会话与时间

`src/session.ts` 的 `ReviewSession` 是 UI 与 Agent 共用的行为入口。轨道为 A–D，时间单位是整数微秒，每个片源首个视频时间戳归零后再应用轨道偏移。

公共时长取偏移后各轨道结束时间的最大值。定位和播放对短轨道保留最后一帧。逐帧基于解码后的真实前后继 PTS，通过 `src/presenter.ts` 的公平步进规划避免跳过中间帧，不假设固定帧率。

播放采用每轨独立解码和有界帧队列，公共时钟受解码覆盖范围约束。进度通过 `subscribeProgress` 在呈现 tick 更新；完整 UI 状态快照约每 100ms 更新。暂停、取消、替换和关闭必须释放待处理帧，禁止旧请求覆盖新状态。

## 解码与呈现

| 路径 | 入口 | 边界 |
| --- | --- | --- |
| WebCodecs | `src/media.ts` | Mediabunny 解封装，通过文件或 HTTP Range 读取；浏览器负责支持的编码组合 |
| 文件 WASM 回退 | `src/ffmpeg-media.ts`、`src/ffmpeg-worker.ts` | 按 `MediaOpenError.stage` 决定是否回退；文件进入 WASM 内存，上限 512 MiB |
| FLV | `src/flv-media.ts`、`src/flv-engine.ts`、`src/flv-demux.ts`、`src/flv-decoder.ts` | Worker 内分块/Range 解封装，WebCodecs 或 packet-only WASM 解码；不使用整文件 MEMFS |

FLV 支持标准 AVC、legacy HEVC、private AV1/VVC，以及单轨 Enhanced FLV 的 avc1/hvc1/av01/vvc1。重复配置头可接受，编码配置变化、多轨 Enhanced FLV 和不支持的编码会返回诊断。它是可定位的文件播放器，不是 HTTP-FLV/RTMP 直播客户端。

WASM core 的源码、裁剪和构建位于独立 `VoidPlayer-FFmpeg-Build` 仓库的 `wasm` 分支。本仓库通过 `scripts/sync-wasm-core.sh` 消费产物，产物不进入 Git。FLV 需要支持 packet API 的 core。跨源隔离时优先尝试多线程 core，否则使用单线程；多轨共享线程预算。

`presenter.ts` 是上屏入口，解码器不直接绘制。`presentation-surface.ts` 使用视口大小的 WebGL 表面，缩小时 LINEAR、放大时 NEAREST；不可用时回退 Canvas 2D。保留源帧 canvas 供像素工具和缩略图使用。500× 缩放不会分配 500× 的显示缓冲。

当前没有原生 HDR 输出管线。WASM 输出为 8-bit RGBA；浏览器色彩管理、真实显示扫描和不同设备性能需要分别验证，解码成功不是显示准确性的证明。

## 标注与界面

标注是源帧坐标下的矢量对象，可以延伸到画面外围的对应视口。`strokeWidth` 存 CSS 像素，缩放时保持屏幕线宽；绘图颜色属于内容，不随 UI 主题改变。

图层顺序为背景网格、视频、标注 SVG、浮动控件。SVG 使用独立的视口与 viewBox，不随中间位图缩放；只受轨道视口裁切。

UI 和 Agent 都通过 `session.updateMark` 修改对象，保留 ID 与帧锚点。标记外观只通过 ID 推导，不写入额外状态。`ui/annotation-thumbnails.ts` 是页面内存缓存，预览不触发额外定位或解码。

导出格式为 `voidplayer-web-review`，version 1，包含媒体信息、帧锚点、轨道对齐和标注。ID 不是文件内容哈希；替换片源保留原标注的来源关系。格式不保证兼容桌面播放器的导入器。

## Agent 与服务

`src/agent.ts` 定义工具清单、参数校验和执行入口；`src/main.ts` 暴露 `window.voidPlayer`。工具包括会话与轨道操作、定位与步进、播放与基准、标注编辑与导出、媒体库及日志读取。以实际导出的工具 schema 为准，不在文档复制一份易过时的签名。

支持 WebMCP 的浏览器会注册同一组工具；不支持时普通 UI 仍可用。浏览器文件必须由用户选择或提供已有 File 对象，不能通过页面任意读取本机路径。

`server/` 提供白名单媒体索引、Range、静态文件、健康检查和可选日志上传。默认绑定本机；配置、账号、可选本机定位能力和部署方式见 [部署说明](../deploy/README.md)。

诊断通过 `log.ts` / `log-storage.ts` 本地保存，读取不会上传。上传只由用户操作触发。评审内容当前没有服务器保存功能。
