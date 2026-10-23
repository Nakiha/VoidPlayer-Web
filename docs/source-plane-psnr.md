# 源平面 PSNR 数值核心 v1

这是 #114 的独立数值小切片，服务于 #112 路线图。`shared/analysis/quality/psnr.ts` 的 `measurePsnr` 在调用者提供的原始 YUV 平面上计算 CPU PSNR。没有媒体读取、解码、帧对齐、GUI 调用或持久任务；`quality.jobs` 保持未实现。此结果不能证明来源/帧配对正确，也不代表 #114、#120 或 #121 已完成。SSIM、分块证据、VMAF 和任务/GUI/Agent 适配后续交付。

## 输入与可比性

调用必须显式提供 `domain='source-yuv-code-values'`、`reference`、`distorted` 和 `roi`。每帧包含 `pixels: Uint8Array` 与现有 `FrameDescription`。`color` 必须描述实际平面资源；不借用 `sourceColor`、显示默认值或 `resolveYuvColor` 的 fallback 补齐缺口。调用者须提供稳定、尚未转换的源平面，独立验证来源版本、stream/picture、真实 PTS、参考/待测角色及对齐方案。核心不接收媒体路径，不验证这些身份；结果明确为 `pairing='caller-supplied-unverified'`。

支持矩阵：

| 条件 | v1 要求 |
| --- | --- |
| 资源 | `format='YUV'`，planar 4:2:0，Y/U/V 三平面，8 或 10 个有效位，`bitShift=0` |
| 存储 | 8 位每样本 1 字节；10 位每样本 2 字节 little endian，右对齐；offset/stride 按字节计 |
| 几何 | coded/visible 尺寸及 crop 原点均为偶数；双方 visible 和报告的 display 尺寸一致；coded 分配、crop 原点、行跨度可不同 |
| 实际色彩 | primaries：bt709/smpte170m/bt470bg/bt2020；transfer：bt709/smpte170m/iec61966-2-1/bt2020-10/bt2020-12；matrix：bt709/smpte170m/bt470bg/bt2020-ncl；fullRange 为显式 boolean |
| 色度位置 | 明确的 AVChromaLocation 1–6；0/null 表示缺失，不默认 center |
| 双方域 | 有效位深、上述全部色彩字段和色度位置完全一致 |

NV12、RGBA、其它位深/子采样、左对齐 10 位、估算长度、标记了 `colorFallback` 的资源及 SharedArrayBuffer/resizable ArrayBuffer 拒绝。PQ/HLG 和未知色彩标签拒绝。即便两帧都缺相同标签，也不推定可比。支持的色彩字符串是严格值，不做别名猜测。每个被访问的 10 位样本必须在 0–1023 内，超界拒绝，不能截断高位或掩码伪装成有效值。

这里比较的是声明域内的非线性整数码值；不解释成线性光/感知质量，也不执行 range 归一化、色彩转换、色度重建、旋转、缩放或 HDR tone mapping。display 尺寸相同仅是保守的几何前提，不证明 SAR、内容、方向或时间配对正确。核心得到像素后，未来适配器仍须验证实际源像素与配对证据；省重建码流块和显示截图不满足输入契约。

## ROI、统计与序列化

ROI 必填，坐标相对未旋转的 visible luma 网格。`x/y/width/height` 必须是安全整数、在可见范围内，且全部为偶数；最小 2×2。v1 拒绝不对齐边界，不隐式扩展或取整。亮度按 ROI 采样，U/V 各按宽高减半的对应区域采样；分别叠加每帧自身的 crop、offset 和 stride。coded padding 与 ROI 外样本不参与结果；只验证所选样本有效，不认证整个分配或其它帧。

每平面返回整数 `sse`、有效 `samples`、`mse=sse/samples` 和 `psnr`。峰值由有效位深固定为 `2^bitDepth-1`，即 255 或 1023，limited/full range 都不改成 219/876。保留合法 superblack/superwhite 码值，不裁剪到名义范围。所有分量使用同一峰值。

聚合为 `sum(SSE) / sum(samples)` 后计算 `10*log10(peak²/MSE)`；4:2:0 的 Y/U/V 样本权重为 4:1:1，不平均三项 dB。SSE 为零时返回 `{kind:'positive-infinity', db:null}`，其余为 `{kind:'finite', db:number}`。完整结果可直接 JSON 序列化；不输出 JSON 无法表示的 Infinity/NaN，也不把无穷值变成 0 分。结果复制 ROI/色彩字段，不持有输入缓冲。

## 工作边界与失败

硬上限：总平面样本 16,777,216；双方保留的 ArrayBuffer 分配合计 128 MiB；coded 单边 16,384。请求可用 `budget.maxSamples/maxInputBytes` 降低上限，不能提高；参数必须为正安全整数。保守地分别计费双方完整 backing allocation，同一分配的两个视图也计两次，避免小视图隐藏大分配。结果 `work` 区分 view 字节、计费字节、比较样本和实际样本读取字节；`samples` 统计成对比较位置，`bytesRead` 计双方。

预算和布局校验先于像素遍历，无按图像大小分配的中间数组，输出只有三个平面和总计。最坏 SSE 为 `16,777,216 * 1023² = 17,557,843,083,264`，低于 Number 的精确整数上限。该同步核心不提供任务准入、异步取消或实时性承诺，未来须在独立执行器内按需使用更小预算；不能从播放 tick 自动调用。

失败抛出 `PsnrError`，包含固定类别 `code` 和定位 `field`：invalid-input、unsupported-format、missing-color、incompatible-input、budget-exceeded。任何失败都不返回伪造分数，不修改调用者像素或描述。

## 验证与实际覆盖

`node --test test/unit/psnr.test.ts` 覆盖 8/10 位相同图、已知差值、正确 SSE 聚合、混合零/非零误差、非零视图偏移、独立 crop/stride、ROI 与格式/色彩负例、硬预算/较小调用预算、10 位超界值、超 32 位精确累计、输入不变和结果字段隔离。

`node --test test/media/psnr.test.ts` 使用 FFmpeg 从 testsrc2 生成带明确 BT.709/limited/left 标签的 8/10 位 FFV1，再真实解码为相同位深的 YUV420 平面，逐码值施加可复核扰动，对整帧及对齐 ROI 分别运行独立 FFmpeg `psnr` 滤镜。比较各平面及 aggregate 的 MSE、PSNR 和峰值；FFmpeg stats 输出保留两位小数，绝对容差 0.00501。另有解析已知算例按 1e-12 dB 验证，避免依赖参考输出精度。测试记录实际 FFmpeg 版本及数值，不提交像素/媒体文件。这只验证数值核心，不冒充应用媒体库帧配对、独立取帧或无 GUI 评分闭环。

两组用例登记在 testing manifest 的 source/fast/contract 与 media/ci-node-media 中。当前播放性能历史失败继续保留，新增数值核心不调整播放路径、性能阈值或原始诊断结果。
