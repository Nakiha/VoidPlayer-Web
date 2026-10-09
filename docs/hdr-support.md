# HDR 支持

两套色彩模式继续保留，转换归属与显示目标独立选择。PQ/HLG 高位深原始平面已接入解码、首帧、播放、seek、逐帧、按需截图、封面以及工作区比较条件。

## 使用

打开“色彩与解码”，选择“自有色彩”。默认 SDR 目标将 HDR 映射为可复现的 SDR 预览；“HDR”目标在支持的屏幕、浏览器与浮点 WebGPU 环境中开启扩展输出，其余环境明确显示 SDR 预览并保留目标。假定峰值档位是算法参数，不能当作源母版或屏幕测量结果。

浏览器色彩沿用原生资源转换和 SDR 兼容预览。原生 HDR 纹理导入的实测高亮被截断，因此这条路径暂不开放 HDR 输出。软件回退交付合法 HDR 平面时执行共同 SDR 预览。截图和缩略图始终是 SDR，普通图片不冒充 HDR 导出。

## 数学与资源

- `hdr-policy.ts`：明确的实际资源准入、别名和版本化策略。只接受有 BT.2020 primaries、BT.2020 NCL matrix、PQ/HLG、明确 range、10/12/14/16-bit 的实际平面；不从容器标签还原 RGBA8 或补未知字段。
- `hdr-color.ts` / `hdr-shader.ts`：PQ EOTF → 绝对 cd/m²；HLG 逆 OETF → 场景光，再按场景亮度执行 OOTF → 显示光。HLG 不逐通道独立 gamma。
- SDR 策略 `voidplayer-hdr-sdr-preview-v1`：扩展 Reinhard 亮度映射、线性 BT.2020→709、朝映射亮度去饱和以压缩色域、sRGB 编码。CPU、GLSL、WGSL 使用同一规则。
- 默认源峰值 1000、曝光白 203、HLG 参考显示 1000 nits、gamma 1.2。203 是算法曝光参数，不表示 SDR 映射后保留 203 nits。超过假定源峰值会饱和到输出白；参数随工作区保存。
- HDR 输出：Display-P3、rgba16float、extended canvas；显示光除以显式参考白 hdrWhiteNits（默认 203、范围 80–400），扩展 P3 编码保留 >1 高亮，色域外负通道钳制。不会先执行 SDR tone mapping；浏览器/系统处理最终显示动态范围。

PQ/HLG 传递函数依据 [ITU-R BT.2100](https://www.itu.int/rec/R-REC-BT.2100)，参考白背景见 [BT.2408](https://www.itu.int/pub/r-rep-bt.2408)，扩展画布见 [Chrome WebGPU HDR 说明](https://developer.chrome.com/blog/new-in-webgpu-129#hdr_support_with_canvas_tone_mapping_mode)。项目的预览亮度/色域映射不冒充 BT.2390、BT.2446、浏览器映射或 Dolby Vision。

## 解码与会话

上游 [core f9a41c7](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/commit/f9a41c7baf7031a65279b14a55803380f90128f4) 已推送并由 `scripts/release-core.json` 锁定。单/多线程 ABI v2 均交付合法 PQ/HLG 高精度平面；不符合标签/布局的资源继续显式 RGBA 回退。浏览器硬件只接受可读取的 10/12-bit 4:2:0 HDR，并与同 PTS 软件首帧逐样本核对；失败沿用既有 decode 阶段的软件回退。

UI 和 Agent 的 `set_review_color_output` 都使用 `session.setColorOutput`。改变目标或参数暂停播放，重新准备相同位置；保留媒体 ID、标注、偏移，失败恢复原条件与画面。模式、解码偏好和输出设置本地保存；工作区/review 使用 `comparison.version=2` / `voidplayer-color-v2`，保存完整预览参数、HDR 白与请求目标。旧 version 1 SDR 契约恢复固定默认 SDR 条件；未知契约拒绝。

每轨 `presentation` 报告 requestedTarget、actualTarget、captureTarget、executor、contract。解码 `output` 独立保存资源描述，源 `color` 标签保持不变。actualTarget=hdr 证明选择了浮点扩展画布契约，不能证明物理屏幕已测得亮度。

## 验证

- `npm run test:hdr:color`：标准亮度锚点、HLG 彩色 OOTF、单调灰阶、色域/亮度约束、原始平面精度和标签准入；Chromium WebGL/WebGPU、WebKit WebGL 每个浏览器 794 个向量 × 3 组策略。SDR 最大误差预算为 1 个 8-bit 码值，显示光浮点相对误差预算 0.001。
- 扩展画布测试模拟 `dynamic-range: high`，读回浮点高亮 >1，验证普通截图重新执行同一 SDR 策略；原生纹理夹断仅作为诊断证据，未开放产品 HDR 路径。缺少 WebGPU 的显式 GPU 测试必须失败。
- `npm run test:hdr:browser`：生成真实 10-bit PQ/HLG HEVC，验证本地/Range、seek/逐帧/尾帧、峰值修改/恢复、混合 SDR、播放、v2 工作区还原与浏览器模式降级，登记为 ci-playback 必跑用例。
- `npm run test:presentation:browser`：包含 24 个 HDR 原始布局组合（别名 × 10/12/16-bit × planar/semiplanar），与 CPU 对照，同时覆盖原有 SDR、裁剪、旋转、采样与原生 HDR 兼容路径。
- 上游 `scripts/test-hdr-planes.mjs` 在单/多线程 core 对 PQ/HLG 首帧原始平面逐字节核对独立 FFmpeg，并检查重复 seek 的资源标签与 ABI；应用回归另验 seek 后的图片身份。

Dolby Vision/HDR10+ 动态元数据、母版静态元数据自动决定峰值、HDR 图片导出与物理显示校准尚未实现。浮点读回和普通截图无法代替真实 HDR 屏幕验收；Windows 原设备的最终颜色/性能应单独验证。

本轮 macOS 有窗口 WebKit 的 PQ/HLG 小片源及混合双轨共 6 轮、1080p HLG 单轨/混合 SDR 共 4 轮达到原有阈值；1080p HLG 约 29.7–29.9 fps，混合 H264 约 57–58 fps。浏览器色彩的 SDR 基准有负面结果；初次旧版对照通过，后续完全旧代码也出现同类失败，当前视频/图形负载使这组测试无法建立稳定代码归因。保留通过与失败的[聚合证据](evidence/hdr-support-macos.json)，不宣称所有场景或物理显示验收通过。
