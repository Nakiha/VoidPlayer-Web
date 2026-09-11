# 色彩管线设计审查与统一平面实验

2026-09-10，Windows RTX 5080；前置证据见 [Windows 验证](windows-color-validation.md)。

后续 [Chromium 源码与 trace 取证](chromium-color-source-investigation.md) 已确认 Edge 原片内部使用 GAMMA22，而 JS transfer=null；固定 BT.601 + GAMMA22 候选解释了大部分平均偏差。该候选尚未进入生产，仍有采样及资源边界待验证。

## 结论

解码资源、源标签、呈现职责的分离应保留。把某个浏览器原生资源的显示行为当作全局真值，再由软件 shader 追随，不应成为长期正确性契约。已有 Apple/CV profile 是有限兼容实验，不是跨资源认证；中性探针无法验证彩色、色域与所有编码资源。

“硬件解码”和“浏览器转换颜色”是两个步骤。硬解得到的 YUV 可以正确，但 external texture 的 RGB 转换仍与软件路径不同。这次原片的两路 YUV 完全一致，RGB 却不同；HDR 关闭没有改变这些数字。

WebGPU 的 external texture 接口交给应用的是经浏览器转换的采样结果，不提供通用的原始 Y/UV GPU 平面绑定接口。`colorSpace: 'srgb'` 指定目标空间，不能强制浏览器使用应用的 YUV 矩阵、色度重建与资源解释。WebCodecs `copyTo` 可复制可读平面；`format=null` 则不能假称取得了原始平面。[WebGPU 规范](https://www.w3.org/TR/webgpu/)、[WebCodecs 规范](https://www.w3.org/TR/webcodecs/)

## 实现的验证入口

`?colorPipeline=unified`：跳过合成 profile 选择，初始化普通 `planes` GPU shader；`prepareYuvFrame` 按既有背压流程读取原生平面。原生 YUV 与软件 YUV 进入同一个 GPU kernel，截图和视口使用同一规则。没有平台 gamma、逐通道偏移或用户帧拟合。

该入口验证的是现有 SDR 观看约定的一致执行，不是新的完整色度学/HDR 实现。原始标签仍保留；普通媒体路径新增独立 `sourceColor`，不覆盖实际资源的 `color`。GPU 平面标为 `common-yuv-sdr`；不透明或不可读原生资源仍为 `browser-managed`，不能计入对齐通过。

默认播放暂保留原行为，显式入口用于评估替代设计。它不是已准备全面部署的修复，原因是下面的性能与资源边界。

## 色彩结果

用户 4K HEVC 原片：Chrome 和 Edge 各三对同 PTS，整帧 RGB 最大差/MAE **全部为 0**。门限比旧合成测试更严格：统一模式检查整帧，而不是只检查色块内部。

H264 BT.709 limited/full、BT.601、HEVC BT.709 8-bit 合成样片：两浏览器整帧差均为 0，原来的边缘差也消除。

仍未解决的两类资源：

- BT.2020 SDR：原生资源 primaries 为 BT.709，软件参考为 BT.2020，原生可读码值又与软件相同。统一 shader 不能自动证明哪个资源标签可信；测试仍失败，最大差 83。不能把容器标签覆盖到所有原生帧，因为其他平台可能已真正转换资源。
- HEVC 10-bit：原生资源不透明，继续 browser-managed。不能用构造低位深帧或强制 RGB 复制来伪称保留了原始高位深 YUV；测试仍失败。

## 实际会话性能

同一台 Windows、相同浏览器版本，生产构建运行 `benchmark_review`，4K 单轨与双轨各三轮，原片约 3 秒到片尾。双轨使用原片的一份独立本地副本，避免应用禁止重复添加同一片源。没有放宽速度、帧间隔或双轨同步门限；不是长时间稳定性验收。

| 浏览器 / 路径 | 单轨绘制 fps | 双轨各轨绘制 fps | 基准通过 |
| --- | ---: | ---: | --- |
| Chrome / 原自动 profile | 59.52–59.59 | 59.32–59.46 | 6/6 |
| Chrome / 统一平面 | 11.85 | 6.04–6.08 | 0/6 |
| Edge / 原自动 profile | 59.51–59.60 | 59.41–59.52 | 6/6 |
| Edge / 统一平面 | 57.56–58.37 | 10.01–10.48 | 3/6（单轨） |

统一路径的媒体时间/墙钟时间：Chrome 单轨约 0.79、双轨约 0.40；Edge 单轨约 0.99–1.00、双轨约 0.67–0.68。按需同帧诊断中，4K `copyTo` 约 25–46 ms，说明存在显著读回成本；不能把这几个耗时当作播放全程复制分布。

因此统一平面路径解决了这份原片的颜色差异，但**未满足通用 4K 双轨实时播放要求**，保留显式实验入口。报告为 `artifacts/color/bench-{chrome,msedge}-{auto,unified}.json`，汇总为 `artifacts/color/bench-summary.json`。基准之后只有 fallback `colorContract` 诊断标记及测试/文档调整，没有转换/调度热路径改变。

## 长期设计方向

应把两个承诺明确分开：

| 路径 | 可承诺的内容 | 边界 |
| --- | --- | --- |
| 浏览器托管播放 | 使用浏览器原生资源，避免应用读回 | 不保证与软件解码逐像素一致，不能把硬件结果视作颜色真值 |
| 应用定义的色彩评审 | 原始/语义明确的平面共用 range、matrix、transfer、primaries、色度重建与输出规则 | 需要能取得并解释原始平面；不可读/标签冲突必须明示能力不足 |

短期先保留诊断开关，用实测而不是 profile 数量决定可用范围。需要严格评审时，应选择能交付语义明确原始平面的后端，并重新验收软件解码性能；不能把“硬解可用”自动等同于“可做一致性评审”。当前代码没有偷偷换解码器，失败阶段契约保持不变。

## 默认资源契约收紧后的验证

2026-09-10：默认不再调用中性校准并自动选择 Apple/CV 补偿；使用无补偿 planes kernel。原生资源仍 browser-managed，保持应用层无逐帧读回。Apple/CV 只留显式实验。此改动可能改变先前 Mac 上的软件呈现与硬件对齐程度，旧 Mac profile 测试不能作为新默认验收，需要在 Mac 重跑。

- Chrome/Edge 默认与 unified 共四轮呈现回归通过，均禁用 VideoDecoder 证明没有校准依赖；覆盖彩色 BT601/709 full/limited 独立向量（≤1 码值）、10 种高位深/布局、旋转、按需截图、资源关闭和回退重入。
- 12 项颜色参考/帧描述/差异统计单测与构建通过。
- 原 4K HEVC 单轨/双轨各三次，两浏览器共 12 次实际应用 benchmark 全部通过。Chrome 59.15–59.56 fps，Edge 59.23–59.63 fps，播放速度 0.990–0.998。仅约三秒片段，非长时间稳定性证明；报告为 `artifacts/color/bench-{chrome,msedge}-resource-contract.json`。
- Windows 合成跨路径验收重跑仍失败：两浏览器 BT2020 SDR 内部色块最大差 83，Edge HEVC 8/10-bit 为 23；其余内部色块 ≤2。未放宽门限，未宣称原生转换修复。
- 三种替代导入/复制入口均保留 Edge HEVC 色偏，见 [独立复现](edge-native-yuv-repro.md)。因此未把失败候选接入播放，也没有做不必要的候选性能优化。

本轮没有真实 WASM core 产物，以上软件平面测试不能替代 WASM ABI/解码器和发布产物验收。

如果产品同时要求浏览器内硬解、零读回及应用完全控制 YUV 转换，当前通用 Web API 无法直接满足。继续堆平台补偿不能解决这个接口边界；需要未来浏览器平面 API，或在原生应用中使用支持 GPU 平面互操作的呈现架构。

## 复跑

```powershell
# 浏览器呈现：同时证明统一模式不需要解码校准片
npm run test:webgpu:browser -- chrome msedge --unified

# 合成全帧；BT.2020 / 不透明 10-bit 仍以失败状态报告
npm run test:color:windows -- chrome msedge --pipeline unified

# 原片同 PTS，独立 FFmpeg CLI 平面参考
npm run test:color:windows -- chrome msedge --pipeline unified --file 'D:\Code\yorune\agent\VoidPlayer\resources\video\mhw_hevc_fullrange_bt709_3s.mp4'
```

报告位于 `artifacts/color/windows-unified/`、`artifacts/color/windows-file-unified/`。它们仍然不是实际 WASM core 验收；本机没有 ABI v2 core。默认路径的 Mac 结果不能替代统一模式的 Mac 验证。
