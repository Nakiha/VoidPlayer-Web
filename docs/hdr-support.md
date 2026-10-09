# HDR 支持开发

本分支先建立可独立验证的 HDR→SDR 预览内核，再接入真实解码与 presenter。
两套用户色彩模式继续保留；色彩转换的归属（自有/浏览器）与显示目标（SDR/HDR）分开设计。

## 已实现的基础

- `src/hdr-color.ts`：PQ EOTF → 绝对 cd/m²；HLG 逆 OETF → 场景光，再按场景亮度执行 OOTF → 显示光。使用实际资源标签，容器 `sourceColor` 不覆盖资源。
- 原始平面 CPU 参考：明确标签的 BT.2020 NCL、PQ/HLG（含别名）、10–16 位描述，复用现有 range、位对齐、裁剪与色度位置重建。不对 RGBA8、不透明资源或缺失标签作 HDR 推断。
- `src/hdr-shader.ts`：GLSL/WGSL 转换函数；目前是独立内核，未安装到播放 shader。
- 显式策略 `voidplayer-hdr-sdr-preview-v1`：亮度扩展 Reinhard、线性 BT.2020→709、向映射亮度去饱和以压缩色域、sRGB 编码。算法与参数一起描述结果，不宣称为标准母版转换或专业 HDR 参考显示。

默认策略采用 1000 nits 的假定源峰值、203 nits 的曝光归一化白、1000 nits 的 HLG 参考显示和 system gamma 1.2。203 作为算法曝光参数，不表示映射后保持 203 nits，也不表示已测得显示器亮度。超过假定源峰值的亮度会饱和到输出白。亮度参数域为 1–10000 nits，源峰值不得小于曝光白；HLG gamma 为 1–2。策略可显式传入并序列化；尚未接入 session 或工作区快照。

PQ/HLG 传递函数依据 [ITU-R BT.2100](https://www.itu.int/rec/R-REC-BT.2100)。参考白背景见 [ITU-R BT.2408](https://www.itu.int/pub/r-rep-bt.2408)。预览的亮度/色域映射是本项目显式选择，不冒充 BT.2390、BT.2446、浏览器 tone mapping 或 Dolby Vision。

## 当前边界

生产行为仍执行 [现有 SDR 契约](color-pipeline.md)：自有色彩拒绝 HDR，浏览器 HDR 沿用 sRGB Canvas 兼容绘制。新内核没有放宽 `resolveYuvColor`、`referenceSource` 或硬件准入；播放、截图、工作区和导出没有切换到新策略。

上游 `VoidPlayer-FFmpeg-Build/wasm/vp_decoder.c` 的帧交付代码主动将 PQ/HLG 排除在原始平面输出之外，当前会走 RGBA 回退。完整接入之前必须在上游单独验证 HDR 高精度输出，推送源码并锁定新 core 修订；不能从已有 RGBA8 还原源 HDR。

已核对 Web 仓库锁定的 [core 源码 dc74d66d](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/blob/dc74d66daa56047a365eae45dd109eaf2309fbd6/wasm/vp_decoder.c#L1051)：PQ/HLG 会清除 `planar` 标记。后续还须用真实 HDR 解码结果验证更新后的产物。

## 后续接入顺序

1. 上游 core 交付 HDR 原始平面；核对源标签、实际资源、位深和布局，以及可用静态 HDR 元数据。保持既有失败阶段和帧关闭契约。
2. 在 presenter 的 CPU/WebGL/WebGPU 执行器中安装同一预览策略，首帧/播放/seek/按需截图共用。另核验硬件高位深读回；无法核验时使用软件路径。
3. 通过 session 为 UI/Agent 提供同一设置行为；将新呈现契约及所有映射参数保存到工作区和 review 的比较条件，兼容旧 `voidplayer-sdr-v1`，未知契约拒绝。
4. 完成真实 PQ/HLG 片源、双轨混比、SDR 回归、截图/缩略图、生命周期和播放 benchmark 验收，再开放自有模式的 HDR→SDR 预览。
5. 独立增加 HDR 显示目标：浮点画布、正确输出色彩编码和 extended 输出；明确 SDR 白与能力降级，实机验证系统与 HDR 屏幕。浏览器托管 HDR 单独验证转换归属，禁止二次 tone mapping。

首轮不实现 Dolby Vision/HDR10+ 动态元数据。浏览器 API 初始化成功、浮点缓冲或普通截图均不能证明物理 HDR 显示已通过验收。

## 验证

`npm run test:hdr:color` 执行标准亮度锚点、HLG 彩色 OOTF、单调灰阶、亮度/色域约束、原始平面精度及标签准入，以及 Chromium WebGL/WebGPU、WebKit WebGL 对照。Chromium WebGPU 使用有窗口浏览器；缺少 GPU 必须失败，不把跳过报告为通过。WebGPU 也可显式在 WebKit 上测：`node scripts/check-hdr-color-browser.mjs webkit --require-webgpu`。

每个浏览器覆盖 794 个信号向量和 3 组显式策略；GLSL/WGSL 的最终 SDR 结果对 CPU 参考预算最多 1 个 8-bit 码值。WebGPU 另读回浮点显示光，绝对误差除以 `max(1, expectedNits)` 不超过 0.001。标准锚点由 Node 测试单独核验。该测试只证明内核数值，不证明真实片源解码、完整播放或 HDR 显示。
