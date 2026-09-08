# 色彩链路与帧资源契约

本文描述当前实现和明确的能力边界。修改解码、帧描述或上屏色彩策略时必须同步更新本文。
目标是首帧、播放、seek、截图使用同一套转换规则，而不是按文件名、编码名或横竖屏添加修正。

## 两类信息必须分开

| 信息 | 所有者 | 用途 |
| --- | --- | --- |
| 容器/码流的源色彩 | MediaInfo.color、FrameDescription.sourceColor | 片源信息、诊断；不能直接覆盖已解码资源的标签 |
| 当前资源的色彩 | FrameDescription.color | 上屏策略输入；必须对应实际交付的资源 |
| 资源布局 | format、codedWidth/Height、visibleRect、stride | 存储、裁剪、复制校验；与显示尺寸分离 |
| 内存计费 | byteLength、byteLengthEstimated | 队列预算；不代表整个硬件解码器的显存占用 |

primaries 描述基色，transfer 描述传递函数，matrix 描述分量转换，fullRange 描述取值范围。
BT.2020 本身不是 HDR；PQ/HLG 才触发当前原生 HDR 呈现策略。未知字段保持 null，不能自动补成 BT.709。
源像素格式的 10 bit、HEVC 编码、屏幕支持 HDR，都不能单独证明当前资源需要或已经完成 tone mapping。

## 原生解码：保留浏览器资源

1. mediabunny 的 VideoSample 或 packet decoder 的 VideoFrame 进入共同的 frame-description 边界。
2. videoFrameDescription 从实际 VideoFrame 提取色彩、裁剪、编码尺寸与格式；sampleDescription 只负责适配 VideoSample。
3. Worker 传递 VideoFrame 及帧描述，主线程将其包装为 DecodedFrame。包装、clone、seek 不应重新解释色彩。
4. presenter 调用 presentationColor，由当前帧描述选择呈现路径。

VideoFrame.format=null 是不透明资源，不等于坏帧或不支持解码。
这种帧不能依赖 allocationSize/copyTo 获取默认像素布局，但仍应保留浏览器绘制能力。
对它不调用 allocationSize，以 codedWidth × codedHeight × 8 作为队列预算估算并标记 byteLengthEstimated。
这是 RGBA16 尺度的计费估算，不是实际分配的承诺，也不分配这块内存。
可读帧使用 allocationSize 返回的复制缓冲大小；NotSupportedError 同样降为估算，其他错误继续传播。
无效尺寸和已关闭的资源仍须拒绝。不得为计算预算增加 Canvas 读回或切换软解。

## 当前呈现策略

| 交付资源 | 路径 | 色彩责任 |
| --- | --- | --- |
| 原生 SDR、无旋转 | VideoFrame → WebGL | 浏览器处理视频纹理导入，shader 不执行自定义 tone mapping |
| 原生 PQ/HLG | VideoSample.draw → sRGB Canvas 2D → WebGL | 委托浏览器的颜色管理/HDR 压缩；所有帧走同一入口 |
| 原生帧有旋转，或无 WebGL | Canvas 2D | 处理旋转及浏览器颜色转换 |
| WASM RGBA8 | 像素 → WebGL，或 ImageData → Canvas 2D | 字节上传不会自动解释源 PQ/HLG 标签 |

目前输出画布采用 SDR/sRGB 工作目标，不承诺 HDR 显示器上的原生峰值亮度输出。
Canvas 2D 的 HDR 转换由浏览器和平台决定；路径一致不等于跨平台绝对色准一致。
不得在 browser 已转换成 SDR 后再用容器 PQ 标签重建资源，否则可能重复转换。
presenter 是唯一上屏决策点，presentation-surface 负责上传、几何和采样，不按 codec 决定颜色。
截图从当前呈现路径按需物化，不另外增加一套色彩规则。

## WASM：已有信息与尚未实现的能力

packet 与 FFmpeg 容器回退都通过 readWasmFrame 读取 core 的逐帧描述及 RGBA8 字节。
sourceColor 保留 FFmpeg AVFrame 的源标签；当前适配器为 RGB 字节保留源 primaries/transfer，标记 RGB/full range。
这些标签不是经过校准的转换证明：前端无法仅凭它确认 core 的 YUV 矩阵、range 选择和精度处理正确。
当前链路没有显式的、经验证的 WASM HDR → SDR tone mapping 契约。

因此 RGBA8 携带 PQ/HLG（或源明确为 HDR）时，日志必须显示 rgba8-hdr-unmanaged 并警告不适合色彩评审，
不能记录成 color=null、hdr=false 来暗示正常 SDR。当前仍显示已有输出；警告不代表修正了这些像素。
把源标签抄给 ImageData、换用 sRGB Canvas，无法恢复已经量化/裁剪的数据，也不会自动补齐 HDR 转换。

未来若实现 WASM HDR，需在 core 仓库或明确的高精度渲染边界实现并验证：
范围展开 → 正确矩阵 → 逆传递函数 → 线性亮度/色域变换 → 明确的 tone/gamut mapping → 目标编码。
应在降为 RGBA8 之前保留足够精度，输出契约标明实际目标颜色及已执行转换。
届时同步修改 readWasmFrame、presentationColor 和本表，避免源 HDR 导致二次转换。

Dolby Vision/HDR10+ 的动态元数据目前没有端到端解析、传输和应用契约。
能解码 HEVC 基层不代表支持 Dolby Vision；不得根据文件名或容器标签宣称完整支持。

## 诊断和验收

上屏路径状态变化时记录：帧类型、format、opaque、byteLengthEstimated、当前 color、sourceColor、
hdr/sourceHdr、conversion、target 和源 PTS。仅状态变化记录，避免逐帧日志干扰性能。
解码器类型/能力探测与色彩路径分别判断：不透明帧并不能独立证明具体硬件实现。

- 不透明帧：allocationSize 被禁止时仍能建立描述，保留资源及 PQ/HLG，不发生复制或额外 clone。
- 生命周期：首帧、顺播、seek、切换 SDR/HDR 的策略与实际像素回归保持一致；资源显式关闭。
- 软件 HDR：识别并记录未管理状态，不能把日志通过当成色准通过。
- 浏览器合成 PQ/HLG 测试用于像素一致性；绝对色准还需已知亮度/色域测试图、可靠参考转换及目标设备验证。
- 播放改动运行播放基准；没有浏览器/原片时必须在交付中注明验证缺口。

参考：[WebCodecs](https://www.w3.org/TR/webcodecs/)、
[不透明帧的 allocationSize/copyTo 讨论](https://github.com/w3c/webcodecs/issues/920)、
[WebKit Canvas 色彩管理](https://webkit.org/blog/12058/wide-gamut-2d-graphics-using-html-canvas/)。
