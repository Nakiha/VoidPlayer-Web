# 架构与行为边界

## 会话与时间

`src/session.ts` 的 `ReviewSession` 是 UI 与 Agent 共用的行为入口。轨道为 A–D，时间单位是整数微秒，每个片源首个视频时间戳归零后再应用轨道偏移。

公共时长取偏移后各轨道结束时间的最大值。定位和播放对短轨道保留最后一帧。逐帧基于解码后的真实前后继 PTS，通过 `src/presenter.ts` 的公平步进规划避免跳过中间帧，不假设固定帧率。

播放采用每轨独立解码和有界帧队列，公共时钟受解码覆盖范围约束。进度通过 `subscribeProgress` 在呈现 tick 更新；完整 UI 状态快照约每 100ms 更新。暂停、取消、替换和关闭必须释放待处理帧，禁止旧请求覆盖新状态。

## 解码与呈现

| 路径 | 入口 | 边界 |
| --- | --- | --- |
| WebCodecs | `src/media.ts` | Mediabunny 解封装，通过文件或 HTTP Range 读取；浏览器负责支持的编码组合 |
| MP4 WASM 压缩包 | `src/mp4-engine.ts`、`src/packet-media.ts`、`src/packet-worker.ts` | 远程 AVC/HEVC/AV1/VVC 由 TS 读取包索引，按 GOP 读取压缩数据；WASM 只解码 |
| FFmpeg 解封装回退 | `src/ffmpeg-media.ts`、`src/ffmpeg-worker.ts` | 仅用于尚不能用 TS 压缩包路径处理的文件；本地 Blob AVIO、远程 Range AVIO，不在浏览器整文件下载或写入 MEMFS；Node 本地文件测试仍有 512 MiB 上限 |
| FLV | `src/flv-media.ts`、`src/flv-engine.ts`、`src/flv-demux.ts`、`src/flv-decoder.ts` | Worker 内分块/Range 解封装，WebCodecs 或 packet-only WASM 解码；不使用整文件 MEMFS |

FLV 支持标准 AVC、legacy HEVC、private AV1/VVC，以及单轨 Enhanced FLV 的 avc1/hvc1/av01/vvc1。重复配置头可接受，编码配置变化、多轨 Enhanced FLV 和不支持的编码会返回诊断。它是可定位的文件播放器，不是 HTTP-FLV/RTMP 直播客户端。

普通 MP4 的 sample table 已给出包大小、时间戳和关键帧位置，因此读取索引不需要遍历 `mdat`。VVC 的 `vvcC` 配置由小范围 box 读取补充，包表、B 帧排序和 edit list 由 Mediabunny 的公开接口处理。分片 MP4 可能仍需遍历 fragment 头。FLV 缺少完整 sample table，由 TS 扫描 tag 头构建索引；64 KiB 预读可能覆盖部分载荷，小包密集文件仍可能读到大部分文件，但不会整文件驻留。

Range 压缩数据缓存每轨最多 8 MiB（MP4 解封装库另有最多 1 MiB 缓存）；MP4/FFmpeg 以 256 KiB 块读取，FLV 以 64 KiB 块读取。HTTP 必须返回精确的 206/Content-Range；忽略 Range、截断、响应过长及文件版本变化都报输入错误，不静默退回整文件下载。FFmpeg 同步 AVIO 通过 SharedArrayBuffer 与异步 fetch 桥接，需要 COOP/COEP 跨源隔离；MP4/FLV 的 TS 路径没有这项读取限制。FFmpeg 容器回退仍会扫描包建立索引，因此 TS/MKV 等文件的首次载入时间还可能随文件长度增长。

索引用于真实帧时间、关键帧定位、倒退逐帧和尾帧定位。没有完整索引可支持顺序播放，但若要先播再渐进建立索引，需要会话和 UI 明确区分已索引范围、暂定时长及尚不可精确跳转的位置；当前评审会话仍在完整索引就绪后开放轨道。

WASM core 的源码、裁剪和构建位于独立 `VoidPlayer-FFmpeg-Build` 仓库的 `wasm` 分支。本仓库通过 `scripts/sync-wasm-core.sh` 消费产物，产物不进入 Git。FLV 和 MP4 压缩包路径复用已有 packet API，不需要修改 core。跨源隔离时优先尝试多线程 core，否则使用单线程；多轨共享线程预算。

`presenter.ts` 是上屏入口，解码器不直接绘制。`presentation-surface.ts` 使用视口大小的 WebGL 表面，缩小时 LINEAR、放大时 NEAREST；不可用时回退 Canvas 2D。源帧 canvas 在像素工具和缩略图请求 presenter.captureFrame 时才生成。500× 缩放不会分配 500× 的显示缓冲。

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


## 输出帧、包时间线与元数据变更

- `frame-description.ts` 定义像素/显示几何、裁剪、长度、格式和色彩；
  `wasm-frame.ts` 核验 core 帧 ABI v1 并只拷贝该输出帧的有效字节。
  WASM 源色彩与转换后的 RGBA 描述分开；没有新增 HDR tone mapping。
- `packet-timeline.ts` 是 MP4/FLV 的配置和显示游标。压缩包表用于找随机访问
  起点，实际 receive 输出决定显示 PTS；顺序读取到 drain 结束，不按包数量
  截断显示帧。定位保留一帧前瞻并返回目标时刻之前最近的实际帧。
- MP4 的 stsd/stsc/ctts/样本偏移映射在 `mp4-config.ts` 中验证；公共解封装
  接口继续负责读取包和应用 edit list。分片 MP4 的 DTS/配置映射、容器独有
  裁剪等不满足包路径约定时，在 container 阶段选择普通容器回退。
- AVC 原生能力判断包括 SPS 的隔行和重排约束，不能只依赖 isConfigSupported。
  带内参数集切换先完成旧配置输出，防止预读配置改变旧画面。普通兼容流仍优先
  WebCodecs；无重排约束/隔行使用保守的软件路径。
- `media-state.ts` 是元数据修改入口，递增 metadataRevision 并产生变更快照。
  后台索引只修改索引/时长；当前帧描述仅由 session 成功展示后记录。UI 使用
  版本刷新，Agent 仍读取同一个 session；日志在同一变更入口记录有界字段差异。
  Worker 失败附带请求 ID 和最近 16 次操作（不含压缩包或像素内容）。
