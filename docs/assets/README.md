# README 演示资源

`voidplayer-demo.webp` 为应用实录：多轨同步对比、逐帧矩形标注、码率 / NAL 类型图及双轨 QP 热图。
中英文 README 共用同一文件。

- 1008 × 628，31 帧，循环播放约 12.5 秒。
- 动态 WebP，462,526 字节（约 452 KiB）；同帧 GIF 对照为 6,737,914 字节。
- 画面来源：本地 QA 片源 `fixtures/video/mhw_x265_aq_qg16_4s_1920x1080.mkv`。
- 两个演示轨道均由此片源转为 30 fps、960 × 540 的 H.264；A 使用 CRF 18，B 先缩至 320 × 180 再用最近邻放大，并以 CRF 48 编码。
- 使用英文界面与暗色主题录制，章节标题为后期添加。图表、矢量标注和 QP 热图均由实际应用生成。

WebP 使用 Pillow / libwebp 以 quality 68、method 6、`minimize_size=True` 编码，保留各帧停留时间并无限循环。
只提交最终动图；重编码片源、截图序列和 GIF 对照留在忽略的 `.run/readme-demo/` 中。
