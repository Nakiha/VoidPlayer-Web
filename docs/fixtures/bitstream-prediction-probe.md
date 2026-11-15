# Analysis core 预测数据采集实测

2026-11-15 在发布锁指定的 FFmpeg 和采集器上构建了单线程实验 WASM。AVC、HEVC、VVC 各取一个 1080p 样片的前 17 个解码包，每片都收到 17 幅有效 picture。按源 AU 比较，实验构建的 51 幅 picture 与已发布单线程 WASM 的 POC、基础块数及全部 12 字节块记录逐帧一致。新增记录只存在于实验模块。播放器目前仍通过基础块产品提供亮度块几何、适用的亮度 QP、预测粗分类和已支持的树深度。[发布锁](../../scripts/release-analysis.json) · [现行产品契约](../bitstream-analysis.md)

## 实际取到了什么

下表记录每个样片 17 帧的总数。坐标和尺寸统一用 coded 亮度网格表示，允许亮度和色度有不同的分区。表中 C 表示 Cb 和 Cr 共用的预测模式选择。

| 数据 | 采集位置 | 实测 |
| --- | --- | --- |
| AVC 帧内 Y、C | 在 CABAC/CAVLC 推导亮度模式、读取色度模式后，边缘 DC 替换前取值。按实际预测块输出 Y；常规 4:2:0 色度选择按宏块输出 | Y 有 104,480 个 4×4、8,376 个 8×8、1,213 个 16×16；C 有 9,837 条，模式 0–3 均出现。16×16 Y 采用 FFmpeg 的宏块预测器编号，正式导出需按尺寸翻译 |
| HEVC 帧内 Y、C | 在 `intra_prediction_unit` 的实际 PU 中取 Y 的 MPM/余数选择与派生方向；C 在 `chroma_mode` 仍有效时取选择值，再取派生值 | Y、C 各 20,927 条。C 中 20,630 条使用派生亮度模式。该样片两类记录数量恰好相同，源码另有 NxN 和 4:4:4 分支 |
| HEVC 帧间 PU | 在 `hls_prediction_unit` 求出运动场、解析当前 slice 的 L0/L1 后，跳过像素重建之前读取真实 PU 矩形、skip、merge 候选索引和两路参考/运动 | 37,985 个 PU，L0 单向 5,643、L1 单向 2,247、双向 30,095。890 个矩形为非正方形。AU 2 / POC 4 的 `(232,528) 8×16` 双向 PU，L0[0]→AU 0，位移 `(-1/4,0)`；L1[0]→AU 1，位移 `(+1/2,-1/4)` 亮度像素 |
| VVC 帧内 Y、C | 在亮度模式推导后、色度模式选择和推导均可见时分别记录。包含 single-tree 与独立色度树。Y 附 MIP、ISP、参考线索引；C 附普通选择或 CCLM 索引和派生结果 | 29,701 条纯帧内 Y、3,280 条 C，其中 2,671 条来自独立色度树。Y 有 3,808 条 MIP，需用 MIP 模式表解释。VTM 核对了全部 Y/C 最终模式、C 选择模式、Y 的 MIP/ISP；另有 448 个 CIIP 块的亮度帧内贡献，也与 VTM 对齐 |
| VVC 帧间工具 | 在 `inter_data` 完成候选选择和工具派生后读 CU/PU 字段。联合记录 skip、merge、MMVD、CIIP、GPM 分割索引、子块 merge、运动模型及 DMVR/BDOF 候选标记 | 17,741 条。MMVD 有 1,909 条，CIIP 有 448 条，GPM 有 737 条。与 VTM 对齐的是 MMVD/CIIP 标记以及 GPM 出现的块位置。仿射和细化工具另见下节 |

HEVC 的完整和免像素两条路径对上述全部帧内及帧间记录给出相同值。AVC 两次请求实际都走同一解码路径。AVC 和 HEVC 的预测细项尚无独立参考解码器的逐块对照。此实验使用逐行 4:2:0 样本，未验证场编码、其他采样格式或 PCM、IBC、Palette 等特殊路径。[AVC 预测器枚举](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/h264pred.h) · [HEVC 的 PU 采集位置](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/hevc/hevcdec.c#L2099-L2175) · [VVC 帧内推导](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/vvc/ctu.c#L951-L1110)

### 同一方向可能来自不同选择

以下都是 VVC AU 0 / POC 0 的色度块，覆盖亮度网格 64×64，对应色度网格 32×32。对同一 Annex B 输入，在 VTM 原有 block statistics 旁增加一项观测，直接记录派生前的 `pu.intraDir[CHROMA]`。去掉新增行后，trace 的 SHA-256 与仓库冻结的独立参考逐字节一致。[独立参考及哈希](bitstream-analysis-vtm.json) · [VTM 观测补丁](../../scripts/tools/fixtures/prediction-probe/vtm-selected.patch)

| 块起点 | FFmpeg 在解码语法时的选择 | VTM 选择模式 | 最终模式 |
| --- | --- | --- | --- |
| (384,64) | 普通选择值 4，跟随对应亮度预测 | 70 · DM | 18 · Horizontal |
| (192,64) | 普通选择值 2，选中水平候选 | 18 · Horizontal | 18 · Horizontal |
| (1088,64) | CCLM 分支，索引 2 | 69 · MDLM_T | VTM 69，FFmpeg 83，同为使用上方邻样本的跨分量线性模型 |

以上名称属于**帧内**预测。DM 是色度的派生选择；CCLM 用亮度预测色度。17 帧里有 1,994 个 DM、95 个 MDLM_T。只导出最终方向会丢失 DM 的来源，只导出 FFmpeg 整数会丢失模式表的含义。[FFmpeg 内部枚举](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/vvc/ctu.h#L233-L244) · [VTM 模式定义](https://vcgit.hhi.fraunhofer.de/jvet/VVCSoftware_VTM/-/blob/69f5112bae8c0f91f3cbc5ba0f44b58986080f16/source/Lib/CommonLib/CommonDef.h#L237-259)

### VVC 免像素路径对运动字段的影响

同一个实验二进制分别请求完整路径与免像素路径，检查实际路径，再按 POC 和矩形配对所有记录。VVC 的帧内记录、skip/merge、MMVD、CIIP、GPM 索引和子块 merge 标记在两条路径相同。完整路径上，将子块时域候选 SbTMVP 与四／六参数仿射分别解释后，17,741 个块的分类均与 VTM 对齐。免像素路径有 **498 个块**的这一分类与独立参考不同。

DMVR 候选标记有 766 处、BDOF 候选标记有 818 处在两条路径之间不同；三个字段合计涉及 1,316 个不同的块。这两个标记描述解码器派生的条件，尚未验证最终细化后的运动或像素。申请精确仿射子型时，应从合法随机访问锚点以完整路径建立参考状态，或将该字段标记为不可用。验证 DMVR/BDOF 及 VVC 实际 MV 需要单独参考。原有帧级候选列表也不能恢复某块的 slice 局部 refIdx。[VVC 子块候选派生](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/vvc/mvs.c#L1370-L1433) · [分析执行契约](../analysis-execution.md)

## 针对数据的 ABI 建议

现有采集器收到的部分参数在写入 12 字节基础块时丢失。另一些信息在更早就已消失，例如 VVC 色度独立树被基础钩子排除，HEVC 在 CU 起点取运动信息时已失去 PU 分区和原始精度。需要同时扩展**解码器钩子**及 **WASM 导出**。建议保留基础 ABI v1，新增可发现、可选的预测扩展及独立版本的 Web 分析产品。[采集器及基础钩子](https://github.com/Nakiha/VoidPlayer-FFmpeg-Build/blob/5ccd3566bdb791e44479439c81b4852fa3340183/analysis/stream.c#L115-L162)

| 记录 | 正式导出的最小信息 |
| --- | --- |
| 帧内预测区域 | 源 picture/AU、codec、coded 矩形、采样格式/坐标单位、tree、分量掩码（Y 或共享 Cb+Cr）、模式族、存在的语法选择、派生模式及其编号体系。MIP 的模式号、ISP 方向、MRL 独立表达。区分显式、推导、不适用和当前路径不可用 |
| 帧间预测区域 | 真实 PU/子块几何与工具标记，skip、候选来源和运动模型可同时成立。HEVC 各有效列表记录本 slice 的 refIdx、源参考 AU、有符号 MV 及分母。仿射控制点、GPM 两区及细化前后运动分别定义；逐 CU 的一个向量不足以表达这些数据 |
| 能力和传输 | 打开解码器前按产品申请数据，按 codec、采样和执行路径声明语义。已封存的画面返回记录族、版本、数量、步幅、长度、字段可用性；宿主复制后统一释放。把请求字段、构建、产品版本与路径语义纳入缓存身份。逐产品及总分配设字节上限，超限返回明确信息，基础块仍可独立请求 |

实验用 16 个 int32 定长槽方便比对。单幅 AVC 已达 110,784 条，即 **6.76 MiB** 的有效记录，还未计算容量预留和基础块。正式布局应拆分记录族、按需采集并覆盖多 picture 累积成本。新字段进入发布契约前还需验证线程版、浏览器与服务端交付、超限与取消，并为 AVC/HEVC 补独立答案。播放器顶部的 RGB/Y/U/V 继续定义像素显示，分析请求的分量由数据产品定义。

### 后续可取的数据

| 数据 | 应在哪一步保留 | 还需证明什么 |
| --- | --- | --- |
| HEVC/VVC 有符号 QpY 及分量 QP | 在基础块钩子截到无符号字节前取 QpY；在量化参数映射、分量偏移及 bit-depth 偏移应用处取 Cb/Cr 值，显式区分语法 QP 与用于反量化的索引 | 负 QP、不同位深、Cb/Cr 偏移与 VVC joint CbCr 的独立样本 |
| 变换单元、非零残差和分量边界 | 在 HEVC/VVC 的 transform tree/unit 解析时记录实际 TU/TB、分量、CBF、transform skip 和 joint CbCr。VVC QT/MTT 分区类型在 coding tree 的递归点记录 | ISP、双树、不含系数的单元、裁剪边缘和采样。系数值、预测面及残差像素另需系数或重建路径 |
| Tile/Slice 与局部码量 | 从当前 picture 的活动 PPS、slice/CTU 映射和熵解析位置采集；记录计数器的单位、作用域和未归属开销 | 多 slice/Tile、参数集变化、CABAC 缓冲和对齐。局部读指针之差不足以证明某块实际使用的精确比特数 |

这些条目已定位到源码，尚未通过本实验的预测记录对照。[HEVC 变换树](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/hevc/hevcdec.c#L1293-L1360) · [VVC 变换单元](https://github.com/Nakiha/FFmpeg/blob/fc5b9f1c45775b46cba7c1d9000977df27724080/libavcodec/vvc/ctu.c#L372-L472) · [AOMAnalyzer 与 StreamEye 现有调研](../bitstream-inspection-design.md)

## 复现实验版采集器

使用 Emscripten 6.0.9、Node 24+、ffprobe、Python 3、系统 patch 及 make。从仓库根目录执行，输出目录须为新路径。脚本下载固定的 builder 和 FFmpeg 源码，仅构建单线程分析解码器与实验导出。对照使用本机已同步的发布版单线程模块。每次输出一幅 picture 时读取其数据，按 AU 校验全部包，最后 drain 至 EOF。[构建和抓取脚本](../../scripts/tools/fixtures/prediction-probe/replay.sh) · [解码器和实验 ABI 补丁](../../scripts/tools/fixtures/prediction-probe/collector.patch)

```sh
bash scripts/tools/fixtures/prediction-probe/replay.sh .run/prediction-probe
```

实验输出为逐 picture 的 JSONL。`au` 始终是源解码序号，`poc` 为编码 POC，`path` 为实际执行路径（0 完整、1 免像素），`hash` 是该画面原生基础块字节的 SHA-256。`rows` 每条以 `[kind,x,y,w,h]` 开头，后接下表所列字段，剩余槽位为填充。

| kind | 记录 | 字段顺序 |
| --- | --- | --- |
| 1 | VVC Y 帧内 | tree、派生模式、MIP、ISP、参考线索引、BDPCM |
| 2 | VVC C 帧内 | tree、派生模式、普通选择、CCLM 索引、ACT、BDPCM、chroma direct MIP、水平/垂直采样 shift。选择分支未使用时为 −1 |
| 3 | HEVC 帧间 PU | skip、merge 索引（−1 表示未用）、列表掩码；随后按 L0、L1 各给 refIdx、参考 AU、MVx、MVy。仅有效列表的位移有意义，单位为 1/4 亮度像素 |
| 4 / 5 | AVC 帧内 Y / C | 当前分区的解码器预测模式 |
| 6 | VVC 帧间工具 | skip、merge、MMVD、CIIP、CIIP 的 Y 模式、GPM 分割索引（两者未用时为 −1）、subblock merge、原生运动模型、IBC、DMVR、BDOF |
| 7 / 8 | HEVC 帧内 Y / C | Y 给派生模式、是否 MPM、MPM 索引或余数；C 给派生模式、色度选择值 |

样片为 `fixtures/video` 下的 `h264_9s_1920x1080.mp4`、`h265_10s_1920x1080.mp4`、`h266_10s_1920x1080.mp4`，SHA-256 依次为 `fb41bae79c6dc65d22cf7e4e8657be0fce45f38a3206def6b535d6d9d32dfcb2`、`c7e6480ec6be4b49595e1f229552ca6107606f649f0e5b142247dcba30fc4a4c`、`088a1b66b61bd23ceebe863720e80c6bac62ad379ae633c510326678de7954fd`。发布对照 buildId 为 `5ccd3566bdb791e44479439c81b4852fa3340183:refs-c943938979b526dc`。

按已有 VTM 说明准备 `.run/issue56-vtm/source` 与 `first17.vvc`，再用一个单独 checkout 添加观测点。最后的比较逐块验证 VVC 的语义、原 trace 哈希、实验数据路径差异和三个 codec 的基础块哈希。[VTM 样本准备](bitstream-analysis-vtm.md#复现) · [比较器](../../scripts/tools/fixtures/prediction-probe/compare.py)

```sh
probe=.run/prediction-probe
git -C .run/issue56-vtm/source worktree add --detach "$PWD/$probe/vtm" 69f5112bae8c0f91f3cbc5ba0f44b58986080f16
git -C "$probe/vtm" apply "$PWD/scripts/tools/fixtures/prediction-probe/vtm-selected.patch"
cmake -S "$probe/vtm" -B "$probe/vtm-build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-DENABLE_TRACING=1
cmake --build "$probe/vtm-build" --target DecoderApp -j 8
decoder=$(find "$probe/vtm/bin" -type f -name DecoderApp | head -1)
"$decoder" -b .run/issue56-vtm/first17.vvc --TraceFile="$probe/with-selected.stats" '--TraceRule=D_BLOCK_STATISTICS_ALL:poc>=0'
python3 scripts/tools/fixtures/prediction-probe/compare.py "$probe" "$probe/with-selected.stats"
```


## 发布候选的独立对照

正式 ABI 按目标帧和产品分配。冻结答案来自独立解码器，参考侧只添加观测输出。使用前述三个 SHA-256 固定的 MP4，每个流取前 17 个编码包。按源 AU 匹配解码器，参考帧 POC 根据各自的解码顺序转换为 AU。独立记录覆盖 AVC 帧内 123,906 条，HEVC 帧内 41,854 条及帧间 37,985 条，VVC 帧内 32,981 条及帧间 17,741 条。单线程、双线程和四线程分别执行全部 85 个产品请求，再比较完整载荷。

| 参考解码器 | 准备方法与观测字段 |
| --- | --- |
| JM 19.0 | [官方源码压缩包](https://iphome.hhi.de/suehring/tml/download/jm19.0.zip) 的 SHA-256 为 `5a87ec1b112423748897fb771f249ac6b7cc8a50c3b56350275857346eed9e1f`。解压后将 `ldecod/src/image.c` 的 CRLF 转为 LF，应用 `jm-prediction.patch`。用 `ldecod.exe -p InputFile=avc.264 -p OutputFile=/dev/null` 解码，stderr 存为 `jm.rows`，对照亮度子分区和色度宏块方向。 |
| HM-16.26 | [HM 官方仓库](https://vcgit.hhi.fraunhofer.de/jvet/HM) 修订 `786d8b907dcda43a9637f611d90290a8494a1516`，应用 `hm-prediction.patch` 并编译 TAppDecoder。输入 Annex B 并在最后追加十六进制 EOS `00 00 01 48 01 80`，使最后一个 VCL NAL 有明确边界。将 stderr 存为 `hm.rows`。验证最终方向、色度 selector、真实 PU、skip、merge 索引和两列表的 refIdx、参考 AU、四分之一像素位移。 |
| VTM | 沿用[独立 VVC 夹具的步骤](bitstream-analysis-vtm.md#复现)，在相同修订应用 `vtm-selected.patch`、`vtm-gpm.patch`，生成 `vtm.stats` 和 `vtm-dec.log`。验证树内亮度/色度区域、方向、色度选择、MIP、ISP、参考线、skip/merge、MMVD、CIIP、GPM 及仿射子型。移除新增的两类 trace 行后校验原始 trace 的 SHA-256。 |

抽取 AVC/HEVC 时使用 `ffmpeg -i INPUT -map 0:v:0 -frames:v 17 -c copy -bsf:v h264_mp4toannexb -f h264 avc.264`，HEVC 对应 `hevc_mp4toannexb` 与 `-f hevc`。三份参考日志完成后，在仓库根目录执行以下命令。冻结器对每帧每个产品按完整的投影行排序，以 ASCII 的逗号和 LF 序列化，输出记录数和 SHA-256。完整载荷的线程一致性另用真实 WASM 验证。[观测补丁与冻结器](../../scripts/tools/fixtures/prediction-probe) · [逐帧答案](prediction-answers.json)

```sh
python3 scripts/tools/fixtures/prediction-probe/freeze-reference.py "$trace_dir" "$trace_dir/prediction-answers.json"
cmp "$trace_dir/prediction-answers.json" docs/fixtures/prediction-answers.json
npm run test:suite -- media --case node-bitstream-analysis-core
```
