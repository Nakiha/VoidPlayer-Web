# 顺带音频

所有轨道默认静音。下方子轨道窗格中，喇叭按钮紧靠可视按钮左侧；用户点击后选择该轨道出声，选择另一轨道会先停止原轨道，再切换输出。隐藏画面与静音是独立操作。暂停和定位立即停止已排队的声音，定位后的声音只使用新位置附近的包。工作区不保存声音选择；刷新、导入工作区、移除或替换所选片源后，需要再次点击喇叭。

要求浏览器支持 WebCodecs AudioDecoder 和 Web Audio。FLV 支持 AAC-LC 单/双声道；MP4、WebM、Matroska 通过 Mediabunny 解析已有数据，再交给浏览器支持的音频解码器（至多双声道）；MPEG-TS 支持 PMT 中首个 ADTS AAC-LC 音轨。验收覆盖 MP4 / MKV / TS 的 AAC 和 WebM 的 Opus，不代表这些容器内所有音频编码均可出声。TS 的 LATM、AC-3、跨窗口不完整的包和多包分段的 PAT/PMT 暂不支持。没有可用编码、配置、索引或完整包时保持静音。浏览器拒绝出声时，按钮提示用户关闭后再次点击。FLV / TS 音频配置在流中发生变化时，该片源停止顺带音频，避免向后定位使用错误的历史配置。

## 静音轨道信息

轨道信息面板按封装、视频、音频分组。无需解除静音即可查看可靠识别的封装格式，以及音轨“有音频 / 确认无音频 / 尚未确认”、已知编码、采样率和声道数。音轨存在性独立于当前播放路径是否支持：未支持编码和多声道仍显示有音频；没有完整缓存证据时不推断无音频。播放支持未经验证时明确显示“播放时确认”。

查询只读取已有缓存中的头部及音轨声明，不调用媒体 Input、不解码、不额外下载或读取 Blob。打开信息面板后最多每秒进行一次有预算的查询；查询结束不保留解析 worker，也不增加静音缓存预算。关闭面板、换片或释放来源会取消旧查询，正常视频读取产生新证据后再更新。已确认的静态元数据可以复用，缓存淘汰不会被解释成音轨消失。

MP4 使用已有 moov，FLV 使用 header/tag 和 ASC，Matroska/WebM 使用 EBML Tracks，TS 区分 PMT 音轨声明和 ADTS AAC 播放过滤。超预算、大型/缺失 moov、启动缓存之外的 Tracks、复杂或缺失 TS 表都可能保留未知；不是全文件扫描或完整 ffprobe 替代。具体预算及测试命令见 [测试说明](testing.md#静音轨道信息)。

## 读取与索引

不为声音发出 HTTP Range 或本地 Blob 读取，不改变服务端视频索引格式。音频仅能观察视频读取已缓存的压缩数据；缓存缺失时直接返回，不补读、不扫描缺失区域、不进入视频提取请求链。`RangeReader.peek` 不进入 IO 队列，不提升缓存优先级。音频设备、解码器和轮询均只在用户解除静音后启用。

| 容器 | 如何从已读数据定位音频 |
| --- | --- |
| FLV | 复用视频包索引定位附近 tag，保留已读的少量 AAC 配置。 |
| 普通 MP4 / MOV | 在独立音频 worker 中解析已读 `moov` 的音轨 sample 表，再按时间查询缓存中的音频包；视频 sample 表本身不能替代音频 sample 表。 |
| 前置 moov 的普通 MP4（faststart） | 仍是完整 sample 表，初始化更容易命中头部缓存；不需要再扫描媒体数据。 |
| 分片 MP4（fMP4） | `moov` 提供初始化配置，每段 `moof` 提供 sample 信息；只查询视频已经读到并仍可用的片段。 |
| WebM / MKV | 解析已读 EBML 元数据、Cues 和 Cluster；遇到缺失索引或 Cluster 时保持静音。 |
| MPEG-TS | 从缓存窗口识别 PAT / PMT、PES 原时间戳及完整 ADTS 帧，不建立全文件音频索引。 |

普通 MP4 的视频 Input 已经解析过 `moov`，但其内部音轨对象不跨 worker 共享。因此解除静音后会有一次额外的**元数据解析**，没有额外媒体下载，也不展开遍历全文件音频包。MP4 路径保留视频已经消费的 `moov` 数据引用（至多 4 MiB）及最多 64 KiB 启动前缀，以免原视频块缓存淘汰后丢失初始化信息；不保留整个 `mdat`。

DASH 常用分片 MP4，但「moov 放在前面」本身不能判断文件是否分片。此功能支持已载入的单个 fMP4 文件中顺带读到的音频，不新增 MPD/分段播放器。如果 DASH 的音频来自另一个 URL 或独立音频分段，视频的缓存中没有那些字节，零额外读取模式下仍不能出声。

本地 FFmpeg 的同步 AVIO 原先没有可查询的压缩数据缓存，现仅记录其既有读取返回的字节。默认静音保留至多 1 MiB 最近数据、128 KiB 启动前缀及最近一个不超过 256 KiB 的 AVIO 缓冲；解除静音后最近数据预算为 8 MiB，静音后缩回 1 MiB。缓存块最多 256 个，音频查询不延长其存活时间。远程 FFmpeg 复用原 Range bridge 缓存。

## 时钟与预算

解除静音后，每 80 ms 至多请求一次缓存观察，worker 合并重复请求。FLV 单次遍历最多 512 个 tag / 512 KiB、24 个音频包。其他容器的解析运行在独立的可终止 worker：初始化读缓存预算 4 MiB，后续查询 512 KiB、128 次源读取调用，每次桥接至多 64 KiB；TS 单次最多观察八个缓存窗口。返回至多 24 个音频包，单包至多 16 KiB。解码队列、PCM 队列和排程节点也有上限。缓存 RPC 超时只返回缺失，不触发视频 worker 的超时失败或终止。

声音服从会话视频时钟及轨道偏移；已有包按原时间戳播放，迟到的包丢弃或截掉过期部分。视频不前进时停止声音，音频不参与视频等待条件。定位后可能马上有声，也可能缺失数秒甚至整段无声，取决于缓存是否包含初始化元数据、定位信息和完整音频包；恢复后仍对齐当前位置，不把晚到的旧声音延迟播放。当前实现不承诺连续音频、每次定位后的恢复时限或采样级同步。

音频需要额外 CPU 和有界的缓存/队列内存，也增加一个按需加载的解析 worker 代码资源。零额外读取指媒体数据，不指 JavaScript 资源。音频不让视频等待，但仍共享设备计算资源，不能保证所有设备和素材上的性能完全相同。

## 验证

```sh
npm run build
npm run test:fast
node --test test/session.test.ts test/worker-rpc.test.ts test/opportunistic-audio.test.ts
node scripts/check-opportunistic-audio-browser.mjs chromium
AUDIO_CONTAINER=fragmented node scripts/check-opportunistic-audio-browser.mjs chromium
AUDIO_CONTAINER=mkv AUDIO_INPUT=local node scripts/check-opportunistic-audio-browser.mjs chromium
```

`AUDIO_CONTAINER` 支持 `flv`、`mp4`、`faststart`、`fragmented`、`ts`、`mkv`、`webm`；`AUDIO_INPUT=local` 验证本地文件。浏览器回归用 ffmpeg 生成 3 秒 320×180 合成音视频，检查真实 PCM、默认无音频设备、按钮位置、定位清空声音、单轨切换、排序/移除/刷新，以及关闭/开启声音采用相同播放和 seek 操作时完全相同的媒体 Range 请求与字节数、本地 Blob 读取序列。用例注册在统一测试清单，支持 `CHROME_EXECUTABLE_PATH` 指定 Chromium。

Linux Chromium 153 验证了七种远程素材（FLV、普通 MP4、faststart、fMP4、TS、MKV、WebM）和五种本地素材（普通 MP4、fMP4、TS、MKV、WebM），开关声音的媒体读取逐条一致。12 秒 320×180 素材的 MP4、远程 TS、本地 TS 分别比较原版、默认静音、开启声音各三轮现有 `benchmark_review`，共 27 轮通过，门限不变。TS 对照使用相同 1280×800 视口、展开的子轨道窗格及 Chromium `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` 参数；远程 TS 的三组 P95 帧间隔分别为 44.36–46.09 / 44.17–46.20 / 45.67–49.61 ms。未指定这些 GPU 参数的原 CLI 基准中，原版和默认静音版远程 TS 均未达门限，不能把该环境失败归为音频回归。

这些小型合成素材回归不能代表高分辨率、多轨或 WebKit 音频输出已验收。静音轨道信息另有 Chromium/WebKit 的本地/远程矩阵，覆盖读取序列、未支持编码、多声道、静音、seek 和中英文切换。通用 WebKit UI 与契约回归已通过；最终必需门禁由 PR 的完整 CI 核验。
