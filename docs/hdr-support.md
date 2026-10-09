# HDR 支持

两套色彩模式继续保留，转换归属与显示目标独立选择。PQ/HLG 高位深原始平面已接入解码、首帧、播放、seek、逐帧、按需截图、封面以及工作区比较条件。

## 使用

打开“色彩与解码”，选择“自有色彩”。默认 SDR 目标将 HDR 映射为可复现的 SDR 预览；“HDR”目标在支持的屏幕、浏览器与浮点 WebGPU 环境中开启扩展输出，其余环境明确显示 SDR 预览并保留目标。假定峰值档位是算法参数，不能当作源母版或屏幕测量结果。

浏览器色彩的 HDR 目标已接入原生帧 → 浏览器 float16 Display-P3 转换 → 浮点纹理复制 → WebGPU extended 输出。无需原始 YUV 读回或逐帧软件重解码；多一次转换/复制，不能称为 external texture 零拷贝直通。要求浏览器开放 `globalHDRHeadroom` 并接受 Infinity，以及真实 float16 2D 与 extended GPU 画布。当前 Chromium 默认未开放 headroom 接口时继续 SDR 兼容预览，并在“当前运行”、Agent 和本地日志显示原因；自有色彩的 HDR 输出不依赖此实验接口。软件回退交付合法 HDR 平面时可使用同一自有 HDR 输出。截图和缩略图始终是 SDR，普通图片不冒充 HDR 导出。

## 数学与资源

- `hdr-policy.ts`：明确的实际资源准入、别名和版本化策略。只接受有 BT.2020 primaries、BT.2020 NCL matrix、PQ/HLG、明确 range、10/12/14/16-bit 的实际平面；不从容器标签还原 RGBA8 或补未知字段。
- `hdr-color.ts` / `hdr-shader.ts`：PQ EOTF → 绝对 cd/m²；HLG 逆 OETF → 场景光，再按场景亮度执行 OOTF → 显示光。HLG 不逐通道独立 gamma。
- SDR 策略 `voidplayer-hdr-sdr-preview-v1`：扩展 Reinhard 亮度映射、线性 BT.2020→709、朝映射亮度去饱和以压缩色域、sRGB 编码。CPU、GLSL、WGSL 使用同一规则。
- 默认源峰值 1000、曝光白 203、HLG 参考显示 1000 nits、gamma 1.2。203 是算法曝光参数，不表示 SDR 映射后保留 203 nits。超过假定源峰值会饱和到输出白；参数随工作区保存。
- 自有 HDR 输出：Display-P3、rgba16float、extended canvas；显示光除以显式参考白 hdrWhiteNits（默认 203、范围 80–400），扩展 P3 编码保留 >1 高亮，色域外负通道钳制。不会先执行 SDR tone mapping；浏览器/系统处理最终显示动态范围。

PQ/HLG 传递函数依据 [ITU-R BT.2100](https://www.itu.int/rec/R-REC-BT.2100)，参考白背景见 [BT.2408](https://www.itu.int/pub/r-rep-bt.2408)，扩展画布见 [Chrome WebGPU HDR 说明](https://developer.chrome.com/blog/new-in-webgpu-129#hdr_support_with_canvas_tone_mapping_mode)。项目的预览亮度/色域映射不冒充 BT.2390、BT.2446、浏览器映射或 Dolby Vision。

## 解码与会话

上游 [core f9a41c7](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/commit/f9a41c7baf7031a65279b14a55803380f90128f4) 已推送并由 `scripts/release-core.json` 锁定。单/多线程 ABI v2 均交付合法 PQ/HLG 高精度平面；不符合标签/布局的资源继续显式 RGBA 回退。浏览器硬件只接受可读取的 10/12-bit 4:2:0 HDR，并与同 PTS 软件首帧逐样本核对；失败沿用既有 decode 阶段的软件回退。

UI 和 Agent 的 `set_review_color_output` 都使用 `session.setColorOutput`。改变目标或参数暂停播放，重新准备相同位置；保留媒体 ID、标注、偏移，失败恢复原条件与画面。模式、解码偏好和输出设置本地保存；工作区/review 使用 `comparison.version=2` / `voidplayer-color-v2`，保存完整预览参数、HDR 白与请求目标。旧 version 1 SDR 契约恢复固定默认 SDR 条件；未知契约拒绝。

每轨 `presentation` 报告 requestedTarget、actualTarget、captureTarget、executor、contract、displayHdr、outputColorSpace、outputFormat、toneMapping，以及 SDR 降级时的 fallbackReason。解码 `output` 独立保存资源描述，源 `color` 标签保持不变。actualTarget=hdr 证明选择了浮点扩展画布契约，不能证明物理屏幕已测得亮度。

## 验证

- `npm run test:hdr:color`：标准亮度锚点、HLG 彩色 OOTF、单调灰阶、色域/亮度约束、原始平面精度和标签准入；Chromium WebGL/WebGPU、WebKit WebGL 每个浏览器 794 个向量 × 3 组策略。SDR 最大误差预算为 1 个 8-bit 码值，显示光浮点相对误差预算 0.001。
- 扩展画布测试模拟 `dynamic-range: high`，读回浮点高亮 >1，验证普通截图重新执行同一 SDR 策略；内存创建的原生帧仅作为导入诊断，不能推定所有解码资源的行为。缺少 WebGPU 的显式 GPU 测试必须失败。
- `npm run test:hdr:browser`：生成真实 10-bit PQ/HLG HEVC，验证本地/Range、seek/逐帧/尾帧、峰值修改/恢复、混合 SDR、播放、v2 工作区还原与浏览器模式降级，登记为 ci-playback 必跑用例。
- `npm run test:presentation:browser`：包含 24 个 HDR 原始布局组合（别名 × 10/12/16-bit × planar/semiplanar），与 CPU 对照，同时覆盖原有 SDR、裁剪、旋转、采样与原生 HDR 兼容路径。
- 上游 `scripts/test-hdr-planes.mjs` 在单/多线程 core 对 PQ/HLG 首帧原始平面逐字节核对独立 FFmpeg，并检查重复 seek 的资源标签与 ABI；应用回归另验 seek 后的图片身份。

Dolby Vision/HDR10+ 动态元数据、母版静态元数据自动决定峰值、HDR 图片导出与物理显示校准尚未实现。浮点读回和普通截图无法代替真实 HDR 屏幕验收；Windows 原设备的最终颜色/性能应单独验证。

本轮 macOS 有窗口 WebKit 的 PQ/HLG 小片源及混合双轨共 6 轮、1080p HLG 单轨/混合 SDR 共 4 轮达到原有阈值；1080p HLG 约 29.7–29.9 fps，混合 H264 约 57–58 fps。浏览器色彩的 SDR 基准有负面结果；初次旧版对照通过，后续完全旧代码也出现同类失败，当前视频/图形负载使这组测试无法建立稳定代码归因。保留通过与失败的[聚合证据](evidence/hdr-support-macos.json)，不宣称所有场景或物理显示验收通过。

## 浏览器原生 HDR 验证

直接导入的负面证据保留在 [Chrome 154 诊断](evidence/hdr-native-import-macos.json)。Chromium 当前的 [external helper](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webgpu/external_texture_helper.cc) 对高位深非 RGBAF16 视频使用 N32 中间资源；[GPUQueue](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/webgpu/gpu_queue.cc) 的 VideoFrame copy 复用同一个 helper。因此仅改最终 canvas/纹理为 float16 不足以取得正确的显示光。该源码说明针对当前 Chromium 实现，不推定其他浏览器或所有原生资源。

新入口使用浏览器提供的 [HDR headroom API](https://chromium.googlesource.com/chromium/src/+/066d68d3a9c6de6ba029f5a6f6f92d3254b6b869)。它允许 drawImage 不先做 SDR tone mapping；不能在 float16 context 上凭空添加同名属性模拟支持，必须先检测原生接口。应用不根据片名、codec 或源标签拟合 RGB，也不向已转换的 P3 资源再叠加 PQ/HLG。

```sh
# 真实默认能力/降级与播放验证，需要有窗口 HDR 屏幕和原生 HEVC
npm run test:hdr:native
# 只在隔离的测试浏览器中开放实验接口，验证浮点原生呈现
node scripts/check-native-hdr-browser.mjs chrome --require-native --experimental-hdr
# 附加 QA 1080p HLG 与混合 H264 播放
node scripts/check-native-hdr-browser.mjs chrome --require-native --experimental-hdr --qa
```

用例登记为 `manual-native-hdr-browser`，不把虚拟 SDR CI 当作真实屏幕验收。它生成 PQ/HLG 的 10-bit HEVC，检查内存帧与真实解码资源、灰阶高亮和彩色块、独立浏览器浮点转换与 GPU 采样的一致性、旋转/尺寸变更、原帧释放后的暂停重画、按需 SDR 截图，以及实际应用的 seek/逐帧/尾帧、目标切换和播放。测试移除 Playwright 的强制 sRGB 启动参数，并要求真实 `dynamic-range: high`，不覆盖媒体查询冒充 HDR 屏幕。实验参数只影响测试进程，未修改用户浏览器设置。

本机 Chrome 154 的[浮点桥接证据](evidence/hdr-native-bridge-macos.json)同时保留默认浏览器的拒绝/SDR 诊断与实验接口开放后的真实呈现。PQ / HLG 原生解码浮点高亮分别超过 5 / 2，GPU 结果与独立浏览器 float16 转换一致；四轮生成片源单/混合轨及两轮 QA 1080p HLG 单/混合 H264 播放通过原有阈值。1080p HLG 约 30 fps，混合 H264 约 60 fps。实际显示亮度仍需设备测量，不能用这些浮点值换算成已测 nits。
