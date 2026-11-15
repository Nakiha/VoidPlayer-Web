# 逐帧编码检查：导出项与界面设计

2026-11-15 设计讨论稿。核对基线为 Web `152c5dd7`、analysis core `5ccd3566`、FFmpeg `fc5b9f1c`。第 1A/1B 批次现已接入 control bar 拉起的分析浮层。基线实测使用与发布锁一致的本机单线程 WASM。交互、产品格式及新能力的提议均单独列在「本轮设计」中。[发布锁](../scripts/release-analysis.json) · [码流分析契约](bitstream-analysis.md)

指定帧的预测 ABI 1 已接入本地 Worker、媒体库和页面工具。导出能力及其边界见[逐帧预测契约](bitstream-analysis.md#指定画面的预测明细)。三种编码各 17 帧的采集实验覆盖 VVC 的 DM/MDLM、色度独立树、HEVC 的逐 PU 运动，以及 VVC 免像素路径对仿射子型的影响。[采集位置、独立对照与 ABI 建议](fixtures/bitstream-prediction-probe.md)

## 调研基线能看到什么

| 来源和粒度 | 可取得的信息 | 核对基线中的去向 |
| --- | --- | --- |
| WASM，每个亮度编码块 | coded 坐标与宽高、亮度 QP、intra / inter / skip 粗分类。AVC 为宏块，HEVC / VVC 为亮度 CU。原生记录还含一个深度字节 | 视口显示边界、QP 或预测分类填色，可叠文字。悬停给出块起点、尺寸、QP 和分类。基线 Web 产品将深度字节清零，本轮已接入 HEVC CU 和 VVC QT 深度 |
| WASM，每幅 picture | 源 AU 序号、PTS、coded 宽高、采样位深、有效性、I/P/B、POC、各 slice 活动 L0/L1 的候选参考 AU 并集及其有效性 | 顶部帧参考图和检查卡已用到帧型、POC 和参考列表。逐块实际引用哪幅画面尚无记录 |
| Web 逐块校验与汇总 | 验证覆盖和无重叠，统计块数，按 coded 像素面积计算平均亮度 QP | 顶部码率图可单独开启 QP 曲线。还可从已持有的精确块计算尺寸分布、三类模式的块数或面积占比、有效 QP 分布 |
| JS 包索引、NAL 解析和轨道配置 | AU 的源 DTS（如有）、大小、时间；NAL 类型、AU 内偏移、长度、层号和时间层号；配置记录另有相对偏移。初始 SPS/PPS 可读出 profile、采样、CTU、WPP、Tile 行列数等，依编码而定 | 顶部码率／展示负载率、帧大小、NALU 大小／类型和参考图，左侧「轨道信息 → 编码特性」及其多轨 JSON 导出。初始配置快照不足以定位当前帧每个 Tile 或 Slice |
| 独立画质 ABI | 输入像素后可取得 VMAF（含 NEG 模型）、CAMBI 分数和五尺度色带热图，以及 XPSNR 各 Y/U/V 分量的逐帧和区间分数 | 本版 Web 已移除画质评分工作流。码流遮罩请求返回的 blocks 不携带这些分数或像素图；以后做色带定位应显式选择画质分析 |

基线 Web 产品组装时清零第 12 字节，读取时校验保留值。新产品用这个字节传递带编码含义的树深度。参考候选列表以源 AU 消除 POC 重置的歧义。H.264 普通流的时间层要区分图上的推断层级和码流信令。[结果类型](../shared/analysis/bitstream/contract.ts) · [基线结果组装](https://github.com/Nakiha/VoidPlayer-Web/blob/152c5dd730068307adc8c30b4f1da5a636caab9e/shared/analysis/bitstream/runner.ts) · [产品校验](../shared/analysis/bitstream/products.ts) · [参考图](../shared/analysis/bitstream/diagrams.ts) · [原生采集器](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/blob/5ccd3566bdb791e44479439c81b4852fa3340183/analysis/stream.c#L115-L161) · [画质 ABI](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/blob/5ccd3566bdb791e44479439c81b4852fa3340183/analysis/README.md#L122) · [Web 移除评分的提交](https://github.com/Nakiha/VoidPlayer-Web/commit/a87ccce1)

8-bit 亮度 QP 的有效范围为 AVC/HEVC 0–51、VVC 0–63。HEVC Main10 仅在该帧所有块的原始返回值均大于零时可用，负 QpY 已被钩子截到零。其他高位深组合依当前契约标为不可用。有效的块边界和粗分类仍可单独显示。当前分析构建注册 AVC、HEVC 和 VVC 三个解码器。[QP 准入](bitstream-analysis.md#支持矩阵与身份) · [解码器枚举](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/blob/5ccd3566bdb791e44479439c81b4852fa3340183/analysis/stream.c#L167-L185)

### 哪些数据在途中丢失

在三个现有 MP4 样片各取解码序号 AU 5，分别读取 WASM 的 `_vpa_blocks()` 和同次请求返回的 `blocks-le12-v1`。三帧的 `confidence` 均为 `exact`。以下为这三帧的观测值。

| 样片（fixtures/video） | 帧型 | 块数 | 原生字节 11 的不同值 | Web 产品字节 11 |
| --- | --- | ---: | --- | --- |
| h264_9s_1920x1080.mp4 | P | 8,160 | 0 | 全 0 |
| h265_10s_1920x1080.mp4 | B | 2,055 | 0、1 | 全 0 |
| h266_10s_1920x1080.mp4 | B | 241 | 0、1 | 全 0 |

- **块深度可直接取。** H.264 采集器固定写 0；HEVC 取 `ct_depth`；VVC 取 `cqt_depth`，二叉／三叉分裂另有 `mtt_depth`。界面应分别标明 HEVC CU 深度和 VVC QT 深度。仅凭 VVC 的宽高和 QT 深度无法恢复完整划分树。[原生块结构](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/blob/5ccd3566bdb791e44479439c81b4852fa3340183/analysis/voidplayer_block_sort.h#L9-L11) · [HEVC 取值](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/hevc/hevcdec.c#L2539-L2574) · [VVC QT/MTT 递归](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/vvc/ctu.c#L2538-L2672)
- **一批字段只到达钩子。** 按 codec 和模式，回调可收到帧内模式、MIP/ISP、merge、预测方向、两路 MV 和参考索引、局部 bit 计数等，采集器发布时舍弃大部分参数。AVC 可取宏块首个运动位置，HEVC 可取 CU 起点的运动场，向量还会取整。VVC 的 chroma-only CU 在回调前已跳过。要支持精确运动、色度或变换检查，需要核对原始分区、精度和语义。[AVC 调用点](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/h264_mb.c#L907-L962) · [HEVC 调用点](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/hevc/hevcdec.c#L2540-L2574) · [VVC 调用点](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/vvc/ctu.c#L2340-L2424)

## 两款分析器怎样把数据变成 GUI

| 问题 | AOMAnalyzer / libaom inspect（AV1） | Elecard StreamEye（按厂商公布的编码支持） |
| --- | --- | --- |
| 这个区域怎么切、怎么预测？ | decoder 可选导出块及变换尺寸、变换类型、Y/UV 模式、skip、参考、MV；画面可叠编码／变换网格、方向／引用、Tile。Zoom 局部放大，Block Info 锁定位置读数 | 画面可区分编码、预测、亮度／色度变换边界及 Slice/Tile；Block Presenter 检查局部参数和运动 |
| 这幅画面用了哪些工具？ | 可导出 segment、块 qindex、CfL、插值滤波和 CDEF 等，帧头有 baseQIndex、showFrame、Tile 等。GUI 有相应工具的专题层和帧／块读数；选择器所列项目与 decoder 导出字段各有范围 | Picture 汇总 QP 范围、类型面积和运动范围；Statistics 可按块数或面积查看。Headers 查看当前帧的头部；DPB 面板有单独的 codec 支持范围 |
| 比特花在哪里？ | 启用 accounting 的 decoder 提供符号及成本；GUI 支持 Bits 图层、直方图，块／帧表可读符号名、bits、占比和出现次数 | 时间线上有帧大小和码量分配图，帧／块统计提供更局部的分配；另有随位置同步的码流结构和十六进制查看器 |
| 怎样追查画面差异？ | 同一选区可看放大图、块详情、帧详情与分布。项目的 2021 扩展示例还展示过 film grain 参数、强度曲线和分量纹理 | 支持跨流同步帧与块、按阶段比较画面，以及查看预测／滤波前像素、残差或系数，具体视编码和版本而定 |

AOM 部分区分 libaom 的 inspection 导出、Xiph 前端实际接入的图层和实验扩展。AV1 的 qindex、CDEF、CfL 等保留编码专有名称。Elecard 一栏据厂商功能对照整理。[libaom inspect 导出](https://aomedia.googlesource.com/aom/+/refs/heads/av1-normative/examples/inspect.c) · [AOMAnalyzer 界面和统计口径](https://github.com/xiph/aomanalyzer/blob/4531a4512ed52b0f5a49ca59046ae1b7779255dc/README.md#toolbar) · [实际图层与页签](https://github.com/xiph/aomanalyzer/blob/4531a4512ed52b0f5a49ca59046ae1b7779255dc/src/components/Analyzer.tsx#L573-L700) · [2021 项目演示](https://people.videolan.org/~negge/AOM_Analyzer_update_2021-Aug-13.pdf) · [StreamEye 功能对照](https://elecard.com/question/elecard-streameye-and-elecard-streameye-basic-comparison)

## 本轮设计

### 一幅画面，从看分布到查某个块

以下用上述 HEVC 样片的 AU 5 示意控件的位置和读数。

```text
[拖动]  [A] [B]                    [关闭]

[块划分]             [预测类型 ✓]
[QP 热图]            [CU 深度]

画面显示                             ▾
  ■ 帧内     ■ 帧间      ■ 跳过
  [块边界]           [块内文字]
  不透明度               [75%]

当前帧 · 预测类型分布                 ▾
  检查轨道 [A ▾]      AU 5 · B · POC 3
  2,055 块               [按编码面积 ▾]
  跳过  ━━━━━━━━━━━━━         99.36%
  帧间  ━                      0.64%
  □ 附带块明细            [导出当前帧]
```

1. **码流开关**位于首行中间，左端拖动，右端关闭。点击徽章切换该轨遮罩，右键或长按可单选，再次操作恢复全部。下方直接选择块划分、预测类型、QP 热图或树深度。块划分默认描边，可按尺寸填色；预测类型使用帧内、帧间和跳过三色图例。所有模式都可以叠加边界、文字并调整透明度。
2. **每个模式有两个独立折叠区**。画面显示放绘制选项，当前帧显示正在检查的轨道、AU、帧型、POC 和本模式的分布。只有 QP 模式显示 QP 最小、面积加权均值和最大值。分布可按面积或块数，点击行突出命中块。收起保留当前画面的高亮，各模式分别记住两个区域的展开状态。
3. **指向一个位置**时保留现有轻量 tooltip。后续需要锁点时，在浮层内显式进入检查模式，在详情显示源坐标、块起点／尺寸、QP、模式、深度及其含义。例：上述 HEVC 样片 AU 5，源点 `(960,540)` 落在 `(960,512) · 32×32 · 跳过 · QP 45`。该帧有 2,039 个 skip 块，按块数占 99.22%，按 coded 面积占 99.36%。这两个百分比回答的是不同问题。
4. **多轨对照**时每轨按其实际上屏 picture 单独查块。相同可见几何可锁同一源位置；裁剪、旋转、分辨率或构图有差异时显示两轨各自坐标，只有存在明确对应关系才联动。切轨、换帧和换片时更新命中状态；新帧尚无数据就清掉旧值。标注工具活动时继续由标注接收指针。

### 导出优先级

| 批次 | 交付给使用者 | 数据与实现边界 |
| --- | --- | --- |
| **1A · 现有产品** | 块尺寸填色、选中帧统计、按桶定位；「导出当前帧」含身份、统计口径、能力与缺失原因，可显式附带块明细 | 从已校验的当前帧 blocks 汇总，大小以导出的矩形为准，覆盖用 coded 域，QP 缺失继续显示未知。逐帧操作复用缓存，切换图层或分母无需再解码。首版只导出所选轨和帧，和现有「导出全部轨道编码特性」各有入口 |
| **1B · 原生已有** | HEVC CU 深度／VVC QT 深度填色、块详情及分布。AVC 显示「宏块」，深度标为不适用 | 经带版本的紧凑块编码公开 byte 11，类型、产品 key、验证器和旧 JSON 转换同时处理。由 build/codec 声明深度语义；旧缓存的保留零不能证明深度为 0。像素位深仍单列 |
| **2 · 新增预测记录** | 优先为 HEVC 常规平移预测展示真实 PU 分区、L0/L1 双箭头、引用目标和亚像素位移；块详情增加帧内方向。随后覆盖 AVC 子分区和 VVC 已验证模式 | 按实际预测区域记录几何、分量、预测类型、列表、参考 AU、原始向量及分母；在当时的 slice 列表内解析 refIdx。merge/skip、双向和多分区各自验证；仿射、GPM、子块运动须单列能力。按需请求运动产品 |
| **3 · 新增变换、色度与码量记录** | 可分别开启 Y/Cb/Cr 变换边界、查看 QP 与变换属性；实际 Tile/Slice 边界；每块 bit 成本图、每帧类别分配和选点明细 | 分量以采样网格、subsampling 和 dual-tree 定位；有符号 QpY 与有效 Cb/Cr QP 在截断前采集。Tile/Slice 取自该 picture 的活动配置与 slice 映射。分别记录 CABAC 位置差、符号成本估计和实际 NAL 字节的口径、单位与未归属开销 |

AV1 若进入产品范围，另设 OBU、tile、superblock、transform、qindex 和参考槽的输入及身份适配，再接入同一个检查界面。解码过程的预测面、残差、系数和滤波前后像素另设指定帧／区域请求；这类输出需要核实完整重建路径及内存成本。

### 验收基线

- **数值**：同一输入、configuration 和 AU，比对本地单线程、线程构建与媒体库结果。用已知 QP、固定尺寸编码、HEVC 深度以及 VVC 含 QT 和 MTT 的独立 trace 检查。AVC 常量零、不可用 QP、缺洞、旧块格式在界面与导出中均可区分。模式面积和应等于已验证的 coded 面积，分布计数和等于块数。
- **定位**：覆盖 1088→1080 裁剪、旋转、缩放、双轨不同分区、快速换帧和标注启用。画面高亮与导出的源坐标命中同一块。新运动产品以同帧多 PU、双向不同参考和非整数位移作为准入样例。
- **开销**：工具条关着时保留现有分析需求。已缓存帧切图层、统计分母或高亮不新增 Worker/解码；悬停不重复扫描全帧来计算分布。新产品按字段和记录数限额，summary、blocks 和重型明细分别申请。测量 4K 密集帧的载荷、绘制时间和缓存淘汰后行为。[分析产品与预算](bitstream-analysis.md#分析产品-v199) · [现有 VTM 对照](fixtures/bitstream-analysis-vtm.md)


## 用预测 ABI 1 接下一轮界面

在 control bar 分析浮层下半区扩充「预测」子面板，可沿用现有折叠和当前帧检查。建议按实际可取得的记录提供三种视图。

| 视图 | 用户操作和读数 |
| --- | --- |
| 帧内方向 | 选择亮度 Y 或色度 CbCr，用对应记录的几何绘制区域。在块详情同时显示色度选择和最终模式，例如 DM → Horizontal。MIP、BDPCM、CCLM 显示模式名，不绘制虚构的方向箭头。Cb/Cr 共用一个编码选择时，提供一个 CbCr 开关。 |
| HEVC 帧间运动 | 按实际 PU 定位，分别开关 L0、L1。箭头用有符号位移除以 4 后投影，块详情列出列表索引、参考 AU 和原始四分之一像素数值。 |
| VVC 帧间工具 | 按工具和运动模型着色，块详情读出 skip、merge、MMVD、CIIP、GPM 分割索引或仿射子型。当前 ABI 可画区域与分类；逐子块运动场需要独立的数据来源。 |

第一次展开某项并启用时，请求暂停画面的对应产品。切换 Y/CbCr、L0/L1 或图例可重用同一份记录。切帧、换轨或关闭要撤销旧请求，回包按源、帧和构建身份核对。顶部 RGB/Y/U/V 继续控制视频像素显示。首行保留拖动标签、码流徽章和关闭按钮。
