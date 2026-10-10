# 时间线兼容性：恢复显示顺序，不按文件打补丁

## HEVC MP4 显示顺序恢复

HEVC MP4 如果没有 composition offset，却在码流中存在图片重排，不能直接把原始包时间当作图片显示顺序。

使用独立的 `hevc-timeline.ts` 读取有界的 SPS、PPS 和首 slice 头，建立完整的图片显示顺序。只有结构和时钟都能证明一致时才应用恢复：单层渐进 Main/Main10、单配置、闭合 IDR GOP、每个 GOP 的 POC 唯一且连续、原包时钟等距且唯一。正常 composition offset、零重排上限的低延迟流、VFR 和不完整的图片序列不会被猜成固定帧率。判断不使用文件名、大小、哈希或某个固定 GOP 长度。

恢复将原有等距时钟的时间槽分配给正确的图片，不重编码，不用输出回退后临时加帧距的方法。MP4 原生和软件路径共用 `PacketTimeline` 的播放、逐帧和定位逻辑；原始 PTS 保留在包描述和错误上下文，来源通过 `timelineSource` 和 `indexWarning` 进入诊断。

WebCodecs 请求硬件优先。此偏好表示浏览器接受了配置，不是实际硬件使用率的证明。负的源时间只在送入 WebCodecs 时平移；接收时在帧描述中恢复逻辑时间，不重建 GPU 像素资源。这样首帧、预滚图片和整个显示序列共用一个时间基准。

回归使用完整 600 帧的像素参考、GPU 上屏与回读、关键帧前后定位、倒退定位、逐帧、尾帧、本地/Range 和关闭重开。原始坏片保留，另有独立生成的语法测试覆盖低延迟 B 帧、POC 回绕、参数集标志和多 GOP。测试中 SHA 只用于固定参考素材，生产路径不读取 SHA。

浏览器的原生路径使用独立固定的 FFmpeg 显示顺序生成参考，再要求生产路径的 YUV 平面取样逐值一致。生产路径的 POC 解析结果不参与生成参考。这样不会将不同平台的有限/全范围或 RGB 矩阵转换混入帧序判定。软件 RGBA 输出保留原有像素参考；跨后端 RGB 差异仍记入报告，GPU 上屏另与同一浏览器的画布输出核对。

复现：

```sh
node --test test/hevc-timeline.test.ts
npm run test:hevc-timeline:browser
```

## 时间戳诊断素材与边界

`scripts/fate-timestamp-samples.json` 固定官方文件的 URL、大小和 SHA-256，包含截取的 TS、节目表变化、场编码及不完整起始画面。官方来源不代表样片专门测试坏时间戳，也不证明当前播放器通过。

`make-timestamp-fixtures.mjs` 对固定官方 TS 注入可重复的时钟变化，不修改压缩图片：33 位时钟回绕、向前跳 30 秒、时钟重置和重复片段。派生文件是派生测试，不能冒充官方 FATE 原片。

```sh
node scripts/sync-fate-samples.mjs
node scripts/make-timestamp-fixtures.mjs
node scripts/check-timestamp-corpus.mjs
```

调查使用原生 FFmpeg 的顺序解码和 RGB 区域均值作参考，覆盖 Node/WASM、WebKit/Chromium、本地/HTTP、连续输出、定位和重开。报告位于 `.run/playback-reports/timestamp-corpus.json`。普通运行遇到失败会返回失败；CI 的探索步骤使用 `--report-only` 保存所有失败，**不把这些失败变成通过，也不替代 HEVC 修复的硬门禁**。

诊断时分别检查正常 B 帧重排、33 位回绕、真正时钟重置、正向空档和重复片段，不把一次 PTS 回退当作时钟重置。包数不保证等于实际显示图片数；相同 PTS 也不能单独证明图片相同。空参考、跨源隔离限制、超时和像素不匹配应分别报告，不能合并成一个解码错误。

正常 VFR 和正向空档不应被擅自压成固定帧率。HEVC 闭合 GOP 的恢复不代表所有容器的时钟段或损坏 PTS 已得到修复。兼容性结论必须来自当前固定 core 与应用版本的完整输出、段边界定位、重复定位、重开及元数据检查；历史调查的帧数和失败列表不能作为当前状态。

参考：[WebCodecs 输出与时间戳约定](https://www.w3.org/TR/webcodecs/#videodecoder-interface)、[FFmpeg HEVC 图片头解析](https://ffmpeg.org/doxygen/7.1/hevc_2parser_8c_source.html)、[官方 MPEG-TS 样片目录](https://fate-suite.ffmpeg.org/mpegts/)。
