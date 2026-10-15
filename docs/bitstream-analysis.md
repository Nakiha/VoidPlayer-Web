# 按需码流分析 MVP

编码块控制统一放在视口播放栏全屏按钮左侧的「分析遮罩」浮层，左侧轨道信息和轨道标题不再包含分析入口。浮层与标注工具条同级，可同时打开；遮罩浮层在与标注工具条相交时按上下可用空间动画避让，随拖动、视口和内容尺寸变化重新布局，两者分别关闭，Escape 只作用于当前操作的浮层。浮层为横向工具条，仅包含彩色轨道遮罩开关、块边界 / QP / 预测模式和共享透明度；各轨按钮在分析期间显示进度圈，完成后收回。块信息仅在鼠标旁悬浮显示，在视口边缘自动翻转和限位，不再固定选中块或展示帧详情。打开时复用缓存；暂停且当前帧缺少结果时自动提交单帧分析，由输入规划器从预算内经过验证的闭合随机访问点推进到目标 picture，必要时包含重排所需的后续送包。遮罩入口不启动整片分析；暂停后的逐帧和 seek 按需补齐当前帧，连续播放只读已有缓存。同一帧失败后由用户重试，不自动循环；用户无需填写时间区间。前端与 Agent 共用会话 facade 和分析并行数限制，播放路径保持独立。

展示负载率图内提供码率 / QP 图例，普通点击切换、右键或触摸长按单选，重复操作恢复之前选择。码率为轨道色实线，QP 为轨道色虚线；两者分别使用 Mbps 和 QP 纵轴。QP 使用编码器分析得到的像素面积加权平均亮度 QP，原始视图逐帧显示，聚合视图按有效帧平均，不把未知 / 不支持填成 0；全源摘要保留 QP 总和与有效帧数，支持详细记录被淘汰后的概览。上面板默认只显示码率/展示负载率曲线与帧大小，QP 默认关闭，打开默认面板不启动深层分析。显式保存的 QP 偏好和工作区选择继续恢复；选择 QP 自动触发共享流式分析；QP 缺失显示分析中或暂无结果。指标选择纳入偏好及工作区快照。



合并悬浮卡片按轨道分行，每行左侧为轨道色徽标及片名，右侧为本轨实际命中帧的 PTS/DTS 时间，不显示顶部统一指针时间，码流、NALU、帧参考三块横向并排，取消卡片及分区的完整边框，只用贯穿同排内容区的等高分隔线区分（两端各留 3px），压缩内外边距；按勾选项显示，窄屏自动换行；码流读数使用固定标签列，NALU 独立和合并卡片共用自适应数值列；编码帧信息独占整行，利用完整分区宽度，仅在分区确实放不下时换行；数值右对齐，单位放在数值旁；独立、合并和容器头部卡片统一使用 12px 正文（含帧信息及单位）和 13px 时间标题；NALU 大小/类型按实际勾选项显示大小和数量列，不再另加类型/数量/大小列标题；图例省略容器头部/逐帧文字标签，来源保留在悬浮提示和配置详情中；普通点击切换类型筛选，右键或触摸长按 500ms 只显示该类型，“全部”恢复，参考详情与独立卡片共用紧凑布局：编码帧信息用次级字色，层级为徽标，L0/L1 并排、沿用参考线配色，帧号加粗。所有图表的悬浮线与卡片位置连续跟随指针，命中帧只更新读数和标记；冻结时保留指针位置。命中柱体、类型块和参考节点统一使用主题前景色描边（亮色深描边、暗色浅描边），不再另画吸附到命中帧的竖线；参考节点仍突出活动连线，不重复绘制节点旁的帧类型和帧号（颜色及悬浮详情保留）；圆点直径默认 12px，随帧单元缩放缓慢增大，最多 24px；多图参考视图的最小高度按圆点和层数保留层间空隙，避免相邻层节点重叠，上下留白及箭头避让跟随节点尺寸。关键帧大小柱只保留顶端菱形，不再绘制柱内 K 字。帧大小、NALU 与参考分布的柱宽共用时间单元的 70% 比例，最小 1px（类型标记最小 2px），放大时不设固定柱宽上限；多轨与重复时间戳仍预留各自位置。完整时间域起点前预留半个帧间隔且不少于 8px 的空间，使第 0 帧整柱和参考节点完整显示，各图及共用轴使用同一范围。第 0 帧左侧半个帧间隔内也允许悬浮，读数命中第 0 帧、悬浮线继续跟随指针；更左侧的容器配置单元仍与逐帧区域分开。

顶部通过一组五个可多选的图示按钮控制码率、帧大小、NALU 大小、NALU 类型和帧参考金字塔；自绘图标依次为折线、普通柱、堆叠柱、类型分布和参考节点，激活态沿用主题色，名称随 PTS/DTS 和界面语言更新到悬浮提示及无障碍标签，点击或键盘空格/回车直接切换对应视图；五个视图各自独立切换，可同时开启或全部关闭；右键或触摸长按 500ms 单选图表，再次操作同一图表恢复单选前的组合（包括空选择）；单选期间切换目标保留最初组合，普通点击结束单选并继续多选；顶部图示按钮组始终保留；全部关闭时，空态提示下方另提供一组同步按钮，两组复用同一套状态和操作，打开任一图表后焦点转到对应的顶部按钮。默认选中码率和帧大小。NALU 大小和类型同时选中时组成一个上下分区图组，共用一排类型图例和筛选；任一部分都可单独收起，两个分区继续共用时间范围与检查线。图表按面板可用高度排列，每个码率和帧大小行至少保留单独显示时的完整可用高度；NALU 等带图例的视图从这个高度中扣除图例占用，按实际行数等分新增空间；收起重复的范围和底部详情，详情放入悬浮卡片。各图共用原概览的 46px 左轴和完整右边界，以及相同的时间网格。多图只在整组底部保留一条 22px 共用时间轴，固定在滚动区域外；各图取消重复刻度及其预留空间，单图同样保留面板底部时间轴。单独显示码率或展示负载率时，绘图区用满时间轴上方的可用高度，零线靠近底部，不保留大小行的空白。绘图区最小高度由 `--analysis-chart-min-plot-height` 配置（默认 36px，不含时间轴），NALU 类型另按 `--analysis-type-row-min-height`（默认 10px）保留每行空间；码率及各帧大小行以单图可用高度作为最低高度；带图例的视图扣除图例占用后得到绘图区最低高度。整组只使用外层滚动区。只有总最低高度超过可用空间时才在面板内滚动，也可以拖动面板底边增加高度。所有图表共用顶部的「完整范围 / 当前帧」操作。NALU 大小、NALU 类型和帧参考关系默认覆盖整片会话时间，移除了前后翻组按钮；概览的码率/帧大小和这三种图示共用一个会话时间视图，切换时保留缩放和平移范围；完整范围、双击复位、当前帧附近和概览框选都更新同一范围，换片源重置为整片；整片检查结果增量填入完整时间轴，尚未收到的区域为空，选中 NALU 或帧参考图示时自动启动流式分析。Ctrl+滚轮、触摸板捏合（包括 Safari 原生 gesture）以指针为锚点缩放，单图时滚轮 / 双指滑动平移；多图有纵向溢出时，上下滚动浏览图表，横向滚动或 Shift+滚轮平移时间；完整范围按钮或双击复位，当前帧按钮把视图缩到当前时间附近一秒，不定位或重启分析。NALU 图例逐项切换类型可见性，右键或触摸长按单选该类型，再次操作同一类型恢复全部；“全部”也可恢复所有类型；两种 NALU 图共享筛选，换片源清空。详细视图逐帧显示 NAL 大小/类型，payload 字节包含 NAL 头、不含容器长度前缀。稠密视图明确显示汇总：大小按各类型的平均帧字节堆叠，类型按出现频率展示；点击汇总桶放大而不定位到猜测帧。参考总览显示 I/P/B 类型分布，放大后以所选 PTS/DTS 为横轴显示参考金字塔；层级优先使用 VCL NAL 的真实 Temporal ID；普通 H.264 或缺失/冲突的时间层信息，按展示时间上相邻 I/P 锚帧间的局部 B 参考关系推断。跨区间的历史参考保留连线，但不累加布局高度。图头标明“推断层级”，刻度与卡片用 ≈ 标记推断、T 标记真实时间层；锚帧或参考缺失时用 * 标明信息不完整。层级在源记录上计算并按缓存修订复用，不因缩放裁掉锚帧而变化。L0 使用橙色实线、L1 使用绿色长虚线，连线图例和详情同步使用主题配色，与蓝色 P 节点区分。连线来自解码器各 slice 的 L0/L1 活动候选列表并集，不能解释为每块实际使用全部参考；视图外边用点线。旧核心没有参考出口时显示不可用。精确帧的点击/回车按 PTS 定位，AU 只留在详情。选中 NALU 或帧参考图示时，自动按窗口并发设置启动可见轨道的流式分析；同一已载入片源不会因切换图示或悬浮而重复分析。A/B 轨道按钮控制轨道在图表中的可见性；点击逐项切换，右键或触摸长按单选该轨道，再次操作同一轨道恢复所有已载入轨道，右侧上屏帧号仍保留全部轨道；分析期间平滑展宽并显示圈形进度，完成后平滑缩回；不提供再次分析或悬浮展开的操作按钮。空态自动显示准备、索引等待和分析进度。底层有界区间入口仍限制最多一秒、32 个 picture，UI 不提供区间表单。NALU 和参考图也使用玻璃悬浮卡片：逐帧详情显示编码帧号、类型、POC、NAL 数量和字节或 L0/L1；汇总卡片明确显示时间段、帧数与平均值，不能冒充单帧。多图共享悬浮检查：在任一图检查会同步时间线及可精确匹配的编码帧，参考图同步高亮活动连线；设置 → 外观 → 图表悬浮信息可选择“各图独立显示”（默认）或“合并显示”，本地保存并跨窗口同步，不影响任务或工作区数据。独立模式下，码率与帧大小共用一张卡片，NALU 大小与类型共用一张，帧参考关系单独显示；每张卡片位于对应视图的悬浮线右侧，右侧空间不足时翻到左侧，并在视口内限位；单图时独立卡片纵向跟随指针，靠近上下边缘时在图表可见范围内限位；多图时各卡片优先在所属图组的可见范围内垂直居中。卡片位置与命中帧的节点层级无关；键盘检查也使用图组居中位置。独立卡片使用紧凑读数，同类图示跨轨统一宽度；NALU 标题和内容分开排版，避免时间标题撑大帧信息列，标题与时间同一行，取消标题下方的分割线并收紧间距，优先保留完整内容高度，超出图组或与邻卡相撞时按图表顺序推挤避让，并限制在窗口内；仅整组高度超过窗口时让整组滚动，不逐卡截断；未显示在滚动区域内的图表不显示卡片。合并模式只显示一张卡片，NALU 大小/类型共用详情；卡片位于整个分析面板下方，横向跟随悬浮线。超长详情在卡片内滚动。汇总保留自己的时间桶及帧数，缺失记录不能用附近帧替代；PTS/DTS 通过稳定解码序号映射同帧，时间线分别使用真实轴时间。跨图移动及纵向滚动保留检查，离开整组图表和卡片、关闭图示或换片时清空；概览缩放后按指针重新计算检查时间。工作区保存检查页、多个图示选择和共用范围，兼容旧单选字段；恢复包含 NALU 或帧参考图时，会自动检查当前片源；不会启用遮罩。

图表最小高度按上面板的拖动下限减去实际工具栏、共用时间轴和边框计算；面板缩到最小时，概览刚好填满可用区域。多图保持这个最小高度并在图表区滚动；无论只选码率、帧大小、单个深度图或多个图表，都只使用面板底部固定的共用时间轴，图内不再绘制可被滚动挤出的时间标签；NALU 图扣除自身图例，参考图仍按节点大小和层数保留必要高度。工具栏换行、窗口尺寸和主题变化后重新计算。
图示切换先统一准备各轨的图例、空态与最小高度，再根据最终布局绘制所有画布；不把默认画布尺寸或补齐图例的中间状态显示上屏。播放和流式分析的更新合并到同一动画帧处理。

UI 和 Agent 使用 `ReviewSession` 的相同入口：`getPresentedFrame`、`requestBitstreamAnalysis`、`requestBitstreamRange`、`requestBitstreamStream`、状态、缓存查询及取消。Agent 工具对应 `get_presented_frame`、`request_bitstream_analysis`、`request_bitstream_range`、`request_bitstream_stream`、`get_bitstream_analysis_state`、`cancel_bitstream_analysis`，以及只读 `query_bitstream_diagrams`（最多 256 帧、2 MiB 图示元数据）。基础半开区间最长一秒、最多 32 个 picture，供 Agent 和统一会话入口使用；整片检查走独立的连续会话，不把短区间任务串起来。

## 支持矩阵与身份

可执行矩阵是 `scripts/bitstream-analysis-matrix.json`；浏览器回归逐行执行本地 File / 媒体库和现有 browser / reference software 播放路径。H.264、HEVC、VVC 的真实 MP4 均有成功正向样本。WebCodecs 可用性由平台决定，实际使用的 decoder 写入测试报告；VVC 走 packet WASM。本轮新增有限 FLV 文件（AVC、legacy/private、Enhanced framing），同样逐项运行本地与媒体库组合。有限、自包含、单视频轨/单 stsd 的 fMP4 也使用共享包索引与连续 AU；完整范围和限制见 [Issue #59 状态](issue-59-status.md)。TS、MKV、外部 init、直播/混合/多配置/时间断裂分片与无 packet 身份的容器解码仍不在范围内。

持久 key 是 source version、video stream、description 配置段、稳定 sample/AU ordinal、picture 0、layer 0、frame。本地 File 使用会话中的随机来源 ID，不按文件名、长度或 mtime 拼身份；媒体库使用 `id@version`。配置、AU 索引、源时间戳缺失或重复以及不唯一的 packet/picture 映射必须拒绝。

播放送包时只检查已经读入的 NAL 首部，不新增 I/O；H.264/HEVC 检查首 slice，VVC 首版限定单 slice；AVC 扩展层和 HEVC/VVC 非零 layer 被拒绝。输出以**唯一且完全相等**的源 PTS 关联 AU，不做最近 PTS 或容差匹配。HEVC 特殊时间映射复用现有经过验证的 POC 修复实现。分析核心用 FFmpeg COPY_OPAQUE 把源 AU 传到输出；VVC 的旧 range-local decode_order 已被替换。

Presenter 在成功提交绘制后发布 token：真实 picture key、原始微秒时间戳、减去 first PTS 后的媒体时间、slot generation、commit 和几何快照。它是应用绘制提交，不是物理屏幕扫描时刻。轨道 offset 只在 session 边界换算；不进入缓存 key。coded 坐标经 visible crop、SAR 对应的共享显示矩形、旋转和当前视口变换投影。缩放和分屏只重投影；几何变化不重分析。分析层位于视频和标注之间。

Field picture、palette 的使用、损坏/concealment、不完整覆盖和非 4px 网格不能显示精确遮罩。Field/concealment 在解码输出时校验；palette 在 VVC 实际 CU hook 中拒绝。VVC 复杂运动/参考语义、MV、chroma QP、高位深 luma QP 和可交互 NAL 浏览器不在 MVP 输出范围。高位深输出可以声明 blocks/modes，但 QP 为 null/unsupported。8-bit luma QP 范围 AVC/HEVC 为 0..51，VVC 为 0..63；均值按 coded 像素面积加权，包含编码边缘的 padding。

## 独立执行与逐 picture 生命周期

分析核心构建在 `VoidPlayer-FFmpeg-Build`，Web 只消费固定产物。`scripts/release-analysis.json` 固定构建修订、instrumented FFmpeg、Emscripten、ABI 和语义版本；`scripts/sync-analysis-core.sh` 验证并复制 js/wasm/manifest/LICENSE，同时生成 SHA-256 provenance。分析核心单线程，无文件系统、avformat 或网络；和播放 core 完全分离。不依赖 cross-origin isolation。

旧批量 writer 已被独立 streaming collector 替换；不调用旧 finalize_frame_summaries / finish_vachunk，不全局重排、重算或在文件结尾重赋 coded_order。每个 picture 的 records 在 codec hook 中 collecting，只有成功 avcodec_receive_frame 才 sealed，排序一次后 take；take 释放分析 records，不释放 decoder 的参考帧。已交付源 AU、坐标、QP 和顺序不会回写。没有继承旧 COMPLETE/EXACT 位。

定位器只读取有界容器元数据和必要 NAL 首部，FLV 复用现有共享扫描器。闭合 IDR 的语法检查与容器 key 标记同时成立才能起步；CRA、recovery 和未知 open-GOP 不按安全起点处理。每个区间保留一个 decoder，逐 picture 取结果并等待 consumer ACK 后才继续。找不到预算内的安全起点或块覆盖不完整会明确失败/降级；跨配置区间在各自经过验证的安全锚重建参考状态，播放不受影响。

本地 File 由独立 browser worker / RangeReader 分块读，文件不上传。媒体库由独立服务端 worker 本地读盘；浏览器按产品取摘要或紧凑二进制块，旧入口继续取 JSON chunks，不加载分析 WASM，也不会在服务端失败时隐式下载远程文件分析。二者使用相同输入适配、核心和协议。Worker 终止是同步 WASM 取消的硬兜底；正常循环在每次 feed/step/take 前检查取消。

## 服务、缓存与资源预算

路由是 `/api/media/:id/bitstream-analysis/{capabilities,requests,chunks/:id}` 和 `/api/bitstream-analysis/requests/:requestId`。写请求需要同源 Origin、专用 action header 和确切媒体版本；API 不接受文件路径。capabilities 是实现的 admission 范围，每个 picture 仍需独立验证。

服务端全局默认同时运行 8 个独立 worker，管理页「概览 → 分析资源」可设为 1–32 路，写回配置文件 `analysisConcurrency` 并立即生效；HTTP/HTTPS 入口共享同一调度器。调高立即补充排队任务，调低不终止已启动任务。单任务核心最大 heap 准入为 512 MiB，默认并发对应最多 4 GiB 的 WASM heap 容量；这不是进程 RSS 上限，JS 元数据、运行时和传输缓冲另占内存。超出运行路数的请求排队，排队单帧优先于区间和整片请求；不抢占正在运行的 decoder，等待索引或 consumer ACK 的任务也占用名额，只有 worker 终止完成才释放名额；每个 work 可以有多个 owner 隔离的 consumer lease，取消一个不终止另一个。GET 状态续租，30 秒失联回收；最后一个 consumer 退出时终止 worker。HTTP、播放和帧索引队列不等待分析。每个可信 picture checksum 校验后原子 rename 单独提交；区间 manifest 仅在完整完成后提交。异常/取消保留之前已完成的 chunks。重启、坏 checksum、截断、丢失 chunk、版本或 build 变化不能形成错误的完成覆盖。

| 资源 | 上限 |
| --- | --- |
| 分析并发 | 每个浏览器窗口默认 2，设置可选 1–8；本地与媒体库共用窗口上限；服务端全局默认 8 个 worker，管理页可设 1–32 |
| consumers / 提交队列 | 各 32 |
| 执行 / consumer 租约 | 执行无进展 30 秒 / 租约 30 秒；客户端排队另限 120 秒，不占执行预算 |
| 区间 | 1 秒，32 picture |
| 预滚与目标送包 | 300 packet；32 MiB payload；单包 8 MiB |
| 元数据索引 / 逻辑读取 | 250000 sample；64 MiB（含重复逻辑 read） |
| coded 尺寸 | 4096×2304；4px 网格完整且无重叠 |
| 核心 collecting + sealed | 32 picture；每 picture 131072 blocks；records 总 32 MiB |
| WASM heap | 初始 64 MiB，最大 512 MiB；stack 4 MiB |
| 单 picture 结果 / 出站 chunk | 8 MiB，按每条 128B + header 的保守 JSON 上界在 JS records 分配前检查；每 consumer 一块 ACK 背压 |
| HTTP 结果传输 | 同时 2 个，额外读请求有界等待；不限制 worker 运行路数 |
| 本地结果缓存 | 私有紧凑块与只读访问器的逻辑计量 32 MiB LRU，会话结束回收，无持久化 |
| 服务端缓存 | 128 MiB LRU，最多 1024 文件；含 manifest |
| 遮罩 | 最大 8192 边长、32M 像素；缩小跳过 <2 CSS px 的边界线 |

结果 JSON、JS 对象、WASM heap、viewport canvas 属于不同的内存开销；JSON 计量缓存配额不宣称是浏览器总 RSS 限额。预算超限只结束分析，不能改变播放 decoder、轨道 failure、时长或索引。逻辑 bytesRead 不是 RangeReader 物理网络字节；服务端无 Range 下载，测试另外记录 Range 响应时间。

## 失败分类与首批交付边界

本地 worker、服务端队列、HTTP 与会话共用结构化 `reason: {code, kind, message}`。稳定码包括 `unsupported-container`、`unsupported-codec`、`unsupported-picture-layout`、`no-safe-anchor-within-budget`、`unsupported-qp-depth`、`incomplete-reference-state`、`ambiguous-picture-identity`、`resource-limit`、`source-changed`、`invalid-request`、`cancelled`、`internal-error`。分类不匹配人类可读异常文本；未知异常仍是实现错误。`resource-limit` 是 limited，合法但未支持的组合是 unsupported，源变更和内部错误是 error。界面显示对应反馈，Agent 可以直接读取原因码。

服务端不再把所有 partial 输出归为内部错误；经过身份校验、无块且最多 16 KiB 的 unsupported 摘要只保留在 consumer 租约内，不写 exact chunk 或完整 manifest。10-bit HEVC 实测 blocks/modes 保持 exact、QP 为 null/unsupported；QP 选项禁用。损坏和 unsupported 输入不放宽身份、预滚预算或完整覆盖校验。

第一阶段交付是普通 MP4 MVP；#56 的范围、验证依据和发布门禁见 [验收状态](issue-56-status.md)。FLV、高位深 QP、复杂随机访问（包括非闭合 IDR 起点）、更多 slice/工具属于后续能力扩展。

有界区间现在按只读 MP4 索引枚举实际 picture，逐帧查询缓存，而不是依据最大时间戳或几个缓存点推断覆盖。本地查询共享会话缓存，服务端查询跨任务持久化 picture chunk；因此不同起止点的重叠区间、单帧和已提交的整片结果可以复用。每个命中校验完整 picture 身份、精确 PTS、codec、schema、buildId、recipe、分析器版本及 blocks/modes 能力；高位深 QP 的 unsupported 状态原样保留，不能冒充已支持 QP。无效、淘汰、损坏或旧构建结果作为缺口重新计算。

全部命中仍需要有界元数据读取和一个任务 Worker，但不加载/实例化分析 WASM。部分命中先逐块交付已有结果，再从最早缺失 picture 的安全锚点推进，只输出缺失 picture；必要的参考帧仍解码，不能因其结果已缓存就跳过。每块查询/交付都有背压，避免额外保存整区间块数组。取消保留已交付结果；只有所有实际 picture 完成才提交区间 manifest。整片请求仍从头连续执行，不承诺跨服务重启恢复流式游标或 decoder 状态；可从持久化 picture 重新发起有界区间请求。

## 验证与证据

以下 runner 命令明确覆盖原先六项测试（含 FLV 和 TS），不依赖已退役的根目录 shim：

```sh
node scripts/run-tests.mjs unit \
  --case node-bitstream-analysis,node-bitstream-analysis-core \
  --case node-bitstream-analysis-server,node-bitstream-analysis-fmp4 \
  --case node-bitstream-analysis-flv,node-bitstream-analysis-ts
```

覆盖三种真实核心、选定已知记录、随机/顺序逐块一致、后段闭合 IDR、H.264/HEVC/VVC 各 600 帧持续 drain、B 帧重排、各三个后段闭合 GOP 的随机/顺序逐块对照、记录/heap 稳态、暂停 consumer、单帧超预算、双 consumer、lease、原子缓存损坏/配额和重启。H.264/HEVC 额外使用固定编码器 CU/MB 大小与 QP 17 的全黑输入，独立检查完整网格、QP 和 intra；不只检查非空。

`docs/fixtures/bitstream-analysis-answers.json` 固定原样片 SHA-256 和旧原生 analyzer 的选定 CU/MB 记录，用于三种 codec 的迁移对照。该原生参考运行使用旧 writer，和新流式 writer 独立，但两者共享 instrumented codec hook。它不是独立证明所有 VVC 复杂工具语义的 oracle；MVP 不声明那些工具。新增 `docs/fixtures/bitstream-analysis-vtm.json` 由独立 VTM 参考解码器内置块统计生成，覆盖 I/B picture 的全部 CU 几何、luma QP、intra/inter/skip 和 L0/L1 参考身份；不是从 FFmpeg 输出反写期望。固定源码、原始统计哈希、具体记录与复现命令见 [VTM 答案说明](fixtures/bitstream-analysis-vtm.md)。复杂工具仍不因基本块记录一致而自动纳入支持范围。

`node scripts/check-bitstream-analysis-browser.mjs chromium|webkit` 执行矩阵，检查 disabled 不加载 worker/core/canvas、local 无上传、library 不下载分析 decoder、真实 token/key、QP/mode、DPR 2、缓存、区间、offset、换帧和迟到响应。`node scripts/check-analysis-release.mjs` 从解压原生包、无 Node/Bun/ffmpeg 的 PATH、无关 cwd 实际执行三种分析并验证重启缓存。三平台 release workflow 均运行该验收，产物汇总另外验证相同 analysis provenance 与字节。

`ANALYSIS_BASELINE_DIR=/path/to/built/main/dist node scripts/bench-bitstream-analysis.mjs webkit` 保留原播放 bench 的场景和阈值，并记录关闭、暂停分析、缓存播放、后台区间分析的本地/媒体库、hardware/software、单/双轨对照。持续缓存场景先覆盖所有显示轨道的 120 ms 窗口，再在窗口内进行 30 次短段播放（累计至少 1.5 秒实际播放，并在每段等到实际换帧后再结束），使用 QP 热图；要求真实命中比例至少 98%、实际绘制至少 30 次、恒定几何不重设 canvas。窗口回放的 seek/start 总成本单列，不能把它写成连续 1.5 秒唯一画面的遮罩验收。原有连续播放 bench 和阈值另行保留；CI 矩阵也含本地/媒体库的持续命中回归。

后台分析连续提交不同的 450 ms 有界区间，至少三次且跨越前台播放，累计需求至少 1.5 秒；同时使用未完成需求期间的连续 1024-byte Range 探测，同时记录独立 HTTP 探测和浏览器端感知延迟的数量与 p50/p95/p99/max、实际请求时段和分析耗时；浏览器回调受主线程阻塞影响，不能当成纯服务响应耗时，分析结束后不再启动探测。输出记录首选配置和实际 decoder、播放吞吐/失败、每帧遮罩绘制耗时、缓存命中率、主线程 timer lag 分位数/long tasks、服务端 CPU/RSS、并发 Range 延迟和分析 heap/records/输入量。CPU/RSS 为观测值，不是任意负载下零竞争承诺。

### 2026-10-10 初始本机测量（阶段 A 之前）

固定 main `d87fda7`、同一播放 core `1e68e6c`，Apple M5 / 10 CPU / 32 GiB / macOS / Node 24.15.0；原有四场景 WebKit bench 在 main 与功能分支均通过。WebKit 32 个争用场景中，8 个暂停分析及 24 个播放场景完成，24 个播放判定全部通过；暂停请求总耗时 131–333 ms，Range 约 4–7 ms，主线程 timer lag 最大约 26 ms。不同场景存在冷启动/缓存命中差异，这些耗时不作为恒定 SLA。

Chromium 功能矩阵通过，但本机 headless + reference 色彩路径低于实时：关闭分析时 main 与功能分支速度均约 0.31–0.39，所有这些 reference 性能判定仍按原阈值记为失败。它们没有被改成验收成功；不能从这些结果推断可见窗口或真实 GPU 硬解的性能。硬件只是首选配置，报告同时保留实际 decoder。

测量汇总：`docs/fixtures/bitstream-analysis-validation.json`，包含两种浏览器 64 个场景、Chromium 的 8 个 main 同条件对照、CPU/RSS/主线程/Range 指标及原始播放 measurements。解压原生包的真实分析已在 macOS ARM64 本机通过；Linux/Windows 与 CI 构建/完整发布验收由 PR workflow 执行，运行状态以远端报告为准。

### 阶段 A 收口

三种 codec 的持续生命周期证据保存在 `.run/analysis-lifecycle/`，CI 上传该目录。每种样片均输出并释放 600 个 picture，源 AU 与原始 PTS 一一匹配，显示顺序严格递增；AU 104/232/584 的随机结果与连续解码逐块相同。AVC/HEVC/VVC 的峰值记录内存分别为 294912/589824/786432 字节，heap 分别为 67108864/67108864/115998720 字节。随机起点分别覆盖三个已验证闭合 GOP，不提高 300 packet 预算。

冻结只读结果仅在入缓存时复制；公共请求仍返回隔离的数据，遮罩命中不深拷贝整份结果。画布仅尺寸变化时重设，帧、几何、样式均未变化时跳过绘制。命中提示由单个按需 output 显示，并验证其经过全局 tooltip 处理后仍可见。

阶段 A 的核心 PR #4 已于 2026-10-10 合入；当时消费锁定最终 merge revision `e9ad3e9eab9810442701ce6416b62b7527117c20`，保留 instrumented FFmpeg `59196ee` 与 Emscripten 6.0.9。合入后重新构建并校验产物，不跟随浮动分支。

阶段 A 测量汇总为 `docs/fixtures/bitstream-analysis-stage-a.json`：两种浏览器各 16 个 main 对照与 32 个功能场景，共 96 个场景。16 个持续缓存场景、所有显示轨道均为 100% 命中，恒定几何的 canvas 重设为 0。WebKit 单轨/双轨的遮罩绘制 p95 为约 3.2–6.2 ms、主线程 timer lag p95 为约 7.6–12.2 ms；Chromium 遮罩绘制 p95 为约 1.7–3.6 ms，但主线程 timer lag p95 仍有约 105–122 ms，保留其主线和功能分支的非实时限制。

16 个后台场景的实际需求持续约 2.1–4.3 秒，每组独立 HTTP 探测有 182–326 个样本。WebKit 服务侧 Range p95 为约 2.0–6.2 ms，Chromium 为约 5.7–16.0 ms；Chromium 本地分析场景的浏览器端感知 p95 约 184–190 ms，不能隐去或等同服务侧耗时。原四场景 WebKit 播放 bench 的 main/功能分支均通过；Chromium 的原判定在两者上均未达到阈值。窗口重复回放、默认连续播放和未覆盖的任意长时间分析仍是不同负载，不作零竞争承诺。

激活遮罩时先固定点击当下的呈现提交；等待代码加载期间换帧就不启动替代请求。浏览器回归阻塞首次遮罩模块加载后逐帧，确认旧激活不分析或绘制新画面；迟到响应回归先确认旧请求 pending，再换帧，避免测试前提本身发生竞态。未知非法输出几何保持 internal-error，真实尺寸/计数预算超限为 resource-limit。

顶部保留一组 PTS / DTS 分段按钮，统一控制图表时间基准、当前上屏帧号和按帧号跳转。右侧当前上屏帧号在所有图示组合下常驻，包括仅显示 NALU、帧参考或全部收起图示。工作区旧 `numAxis` 字段继续兼容读取，UI 以 `axis` 为准；新快照中的两者保持一致。另一种顺序的帧号仍可在当前帧号提示中查看。

## GOP 分组的整片连续检查

选择 NALU 或帧参考图示时，按窗口并发设置自动启动可见轨道的流式分析，同一已载入片源不重复触发；播放本身不启动分析。相同配置段内一个 worker/input/decoder 从头推进至 EOF 并排空，跨结果块与 GOP 保留参考状态；配置段变化仅在新段有经语法验证的闭合随机访问点时排空旧段并建立新解码上下文，否则明确终止。取消、移除或替换片源终止独立 worker，保留此前已交付的完整帧结果，播放位置与播放状态不由分析改动。

GOP 按源包表的 AU/解码 ordinal 与配置段划分；容器 key 标记仅是分组边界提示。每个结果携带半开 AU 范围、配置段以及经输入语法检查的 closed/dependent/unknown anchor。open GOP 不因存储分组而清空参考帧。每 picture 仍是一块最多 8 MiB 的有界结果，逐帧交付，不在 JS 中积累整个 GOP 的块记录。GOP 元数据与播放 index 的 sample/AU ordinal 关联。整片检查不再等待 index 全部完成：原生路径复用元数据索引的已确认包数，FFmpeg 路径使用已导入记录的连续 AU 前缀（不能直接把展示序 batch 的长度当作解码序前缀）；媒体库 FFmpeg 路径以相同 source version / index identity 订阅共享索引构建和有界持久化 batch。已完成或没有增量适配器的 MP4 路径也改为逐 GOP 枚举元数据，边发现边检查，不先枚举完整包表。

只有下一个 key / 配置边界或明确索引 EOF 才封口当前 GOP；未封口的尾部不发布结果，不把当前已索引长度写成最终 endAu。HEVC 等距 POC 时间恢复在封口 GOP 内完成后才发布身份。分析赶上索引时 UI 显示「等待索引 · 已检查 N 帧」，保持同一 decoder / 参考状态；后续增量到达继续。取消只释放分析 worker 与订阅，不取消共享索引构建。索引错误、重建/缓存 epoch 改变或版本失效终止任务，不宣布全片完成。

媒体库依然只在服务端独立 worker 运行，多个不同任务可同时推进。任务结果引用按每页最多 32 条、每页最多 64 KiB 的带校验分页记录原子提交；状态通过 `?after=cursor` 有界读取，客户端只确认已消费引用，不保存全片 seen 集合。每个 consumer 有独立游标与租约，最多 32 块未消费结果，慢 consumer 使生产暂停，失联按租约释放。分析执行使用 30 秒无进展预算；索引等待另有 120 秒连续 AU 前缀无进展预算并向客户端更新等待状态，等 consumer 的时间由租约约束，不把长片总时长限制为 30 秒。服务端 128 MiB / 1024 文件 LRU 配额继续生效；被淘汰的结果不承诺仍有完整缓存覆盖。重启保留已提交 picture，但不恢复 decoder 内存，也不自动恢复整片任务。

整片模式仍限制最多 250000 条源包元数据，单次读取 32 MiB、单包 8 MiB，连续没有输出的推进最多 300 包 / 32 MiB；不再把累计全片读取量限制为短区间的 64 MiB。进度按已交付帧数 / 总帧数计算，索引未结束不能显示 100%；完成必须核验索引 EOF、全部 AU 已唯一交付，实际执行解码时还须完成 decoder drain，不能仅用最大 PTS 或读到的文件位置宣布完成。单帧、区间请求原有预算保持不变。

重新检查整片时，按已封口 GOP 枚举并验证每个持久 picture，逐块交付缓存，不在内存中积累整个 GOP 的块数组。全部命中只加载 manifest 验证 build identity，不初始化分析 WASM。部分命中保留原记录及其 metrics；仅缺口生成新结果，同一 AU 不重复交付。已启动 decoder 只有在缓存段之后存在语法证明的闭合起点或明确 EOF 时才 drain/关闭并跳过该段；遇到 dependent GOP 保持连续参考状态，或从之前已证明的闭合起点重建参考。缓存配额、旧构建、损坏或丢失的块仍作为缺口处理；250000 源包与每次无输出预算继续生效。

`after` 是当前 consumer lease 已交付引用的确认游标，不能大于已交付数或倒退到已经确认的引用之前。同一 lease 的未确认页面可重读；服务重启或 lease 到期后重新提交请求，从新 lease 的 0 开始构建覆盖，不能把旧游标套给新请求。picture 缓存身份跨任务稳定，运输游标及 decoder 内存不持久化。此恢复适用于现有固定 `blocks-basic-v2` recipe，不声明任意能力集合的覆盖。

## 图示数据与开发内核

轻量图示元数据独立于块 LRU 保存（另有 32 MiB 上限），避免块结果淘汰后整片图消失；按 sourceVersion/configuration/AU 隔离，取消保留已收到结果。NAL 每帧最多 4096 条，参考边最多 64 条；导入先验证类型、长度、前向解码身份及重复边，再进入缓存。图示查询保留可见窗口，禁止把全片块数组放进 UI/Agent 会话状态。新增 query_bitstream_chart / session.queryBitstreamChart 以会话时间和像素宽度查询：最多 256 个 raw picture / 2 MiB，或按像素分辨率汇总的桶。另有最多 8 个片源、每源 1024 个自适应时间桶与 2M AU 去重位图，整片汇总独立于原始记录淘汰，重复检查不会累计两遍。若详细缓存被淘汰，缩放仍保留汇总并明确提示重新检查可恢复细节，禁止把缓存尾段伪装成全片。工作区只保存图示选择，不保存任务、核心或结果。

参考 ABI 1 的导出位于独立 VoidPlayer-FFmpeg-Build 的 `analysis/stream.c`、`scripts/build-analysis.sh`；解码器插桩与参考身份逻辑已直接进入 `Nakiha/FFmpeg@c160c1bb3f0faf3ac59b8fbf907a8e3fb604632e`，不再在构建时通过文本补丁注入。源帧标识直接取参考 AVFrame 的 COPY_OPAQUE，不用 POC 猜测身份。必需出口包括 reference ABI/count/pointer/invalid/type/POC，记录为 u32 AU + u32 list，take 后失效。发布锁固定已提交并推送的 `7c2f9b053e19961568b5ca4ecd5a23c123e2c73b`，声明 block ABI 1 与 reference ABI 1。Worker 初始化、runner 和准备发布核心均检查实际 WASM 接口，缺失任一参考出口直接拒绝；CI 缓存恢复也必须执行相同检查。打包拒绝 dirty 核心，原生包验收要求三种 codec 的 `references.state` 均为 `ready`。服务缓存使用 buildId，避免旧块结果遮掉新图示字段。

NALU 图在第 0 帧前一个帧间隔处保留标记为 −1 的虚拟容器配置柱，柱宽与普通逐帧柱共用计算，不额外保留最小列宽：分别在大小与类型分区显示 avcC、hvcC、vvcC 内的 SPS/PPS/VPS、扩展参数集和配置 SEI，悬浮或 Home 键显示“来自容器头部”以及真实 NAL 数量和 payload 字节数。没有独立配置栏；所有图共用同一前置空间，码率、帧大小与参考图在该位置留空。−1 不是媒体帧或负时间，不定位、不进入逐帧帧数、大小、时间桶或参考层级；容器配置类型与逐帧类型合并到共用图例，图例使用“容器头部”来源徽标（双来源标明“容器头部 + 逐帧”），−1 柱使用同色斜纹与逐帧实色柱区分，点击类型同时筛选大小、类型分区及悬浮内容，配置柱仍标明“来自容器头部”；配置类型筛选不改变逐帧统计。缩放到其他区段时配置柱离开可见范围。配置摘要随流式检查结果进入会话缓存，逐帧记录淘汰后仍保留；源版本及 configuration 独立，返回值脱离内部缓存。分析 recipe 更新为 blocks-basic-v2，防止复用缺少配置元数据的旧分析缓存。选择 NALU 或帧参考图时按窗口并发设置自动开始可见轨道的流式分析。轨道按钮平滑展宽显示只读圈形进度，完成后缩回；没有开始或重新检查按钮，悬浮和键盘聚焦不再展开。当前片源自动检查只执行一次，图示/显隐/时间基准切换不会重启。


所有图表共用「PTS / DTS」时间基准，按钮悬浮提示分别说明「展示时间 PTS / 解码时间 DTS」，纯 NALU 或参考视图也保留切换入口。逐帧 NALU 和参考节点、汇总桶、悬浮内容及共用时间轴均使用所选时间戳。分析结果保存输入包的真实 `sourceDtsUs`；PTS/DTS 各维护最多 1024 个自适应汇总桶及去重位图，详细记录淘汰后两个时间基准仍可查看汇总。缺失 DTS 的旧结果不借用 PTS，不伪造时间戳；所选轨道缺少可靠 DTS 时禁用解码时间并提示原因。PTS 模式曲线和悬浮读数称为「展示负载率」，表示展示时间窗口内帧的压缩字节量；DTS 模式称为「码率」，表示解码时间窗口内样本负载，两者都不代表网络吞吐。切换保持共用缩放范围并清空旧基准的悬浮状态；当前帧附近在 DTS 下使用对应 AU 的真实 DTS。参考层级仍按原始 PTS 与参考身份计算，不因横轴切换而变化；点击或回车始终按命中帧的 PTS 定位播放。UI 与 Agent 共用 `session.queryBitstreamChart(..., axis)`，`query_bitstream_chart` 接受可选 `axis`（默认 PTS）。

多轨图示：顶部「码流合并 / 码流分轨」只控制码率和帧大小，仅选择深层图示或单轨时收起此入口。NALU 大小与类型按轨道上下配对，帧参考按轨道独立显示；全局轨道按钮控制所有图示的可见轨道，各轨 NAL 类型筛选独立。所有图共用所选 PTS/DTS 时间轴、缩放与连续悬浮线，各自按本轨 AU 命中内容。合并悬浮 panel 按轨道分行，标题左侧显示轨道色徽标和片名，右侧显示本轨实际命中帧时间，每行包含所选「码流 / NALU / 帧参考」区域；独立 panel 明确标出轨道并限制在对应图示范围内。独立与合并 panel 共用 `analysisDetailTable` 详情结构、`analysisMetricValue` 数值/单位格式和详情样式；合并只省略各分区内的重复表头，外层负责分区与位置。没有该轨逐帧记录时明确留空，不借用其他轨的帧身份。

分析并发设置位于「设置 → 色彩与解码 → 分析并发数」，按窗口持久化并跨窗口同步，默认 2 路，可选 1–8 路。本地文件与媒体库、逐帧与区间请求共用 `ReviewSession` 的任务池，超限等待，排队任务可取消且不创建 worker。调高即时补充任务，调低不打断已启动任务。每轨独立保存状态、AbortController 与任务世代，换源只取消本轨；所有轨道共用有界块缓存及图示存储，避免每轨复制缓存预算。Agent `get_bitstream_analysis_state` 接受可选 slot（省略时读取最近请求的轨道），`cancel_bitstream_analysis` 接受可选 slot（省略时取消全部轨道）。

服务端并发数独立于客户端窗口并发数，默认 8 路，可在管理页配置为 1–32 路。三个用户各提交两个不同任务且服务端设为两路时，两项执行、其余排队；取消或 lease 到期的排队项直接释放且不创建 worker。客户端轮询续租并显示排队状态，最长排队两分钟，开始执行后再计算执行/无进展预算；同一源版本/目标仍合并为一个 work 并按 owner 租约分别消费。原有 32 consumer/提交与每任务资源预算继续生效。并行任务的原子写入串行提交至同一个配额存储，所有任务的未消费及正在提交的结果共同受保护，不能被其他任务淘汰；下载缓冲保持两路，繁忙读请求等待空位，断连或服务关闭释放等待。

遮罩控制条与标注工具条共用背板、内边距和控件高度，左侧把手可拖动，重叠时动画避让。彩色轨道按钮点击切换遮罩；右键或触摸长按单选，再次操作同一轨道恢复全部。

全流完成记录由会话按轨道及片源世代独立保存，`completedStream` 含 sourceVersion 和已确认的覆盖进度；当前任务的 `state/stream` 不代表历史全流覆盖。单帧补算、失败或取消不抹掉完成记录，换源不得继承旧世代。遮罩在暂停且视图事务结束后为连续的缓存缺失帧补算。每个 UI 自动尝试一次；错误、取消和资源限制时，轨道旁显示明确的「重新分析」按钮。确定不支持的能力不自动循环重试，也不显示反复启动同一能力的按钮。源码测试及实际控件浏览器回归覆盖全流完成、连续两个缺失帧、失败后手动恢复与换源隔离。

## 多容器输入扩展

普通 MP4 与有限 FLV 文件通过统一压缩单元接口进入相同分析 runner。首轮 FLV 的 framing、原始时间与播放身份、索引前缀及排除项见 [Issue #59 状态](issue-59-status.md)。第二阶段支持有限自包含 fMP4；TS/MKV 留待后续。

## 可见区间与暂停

图表首次打开时默认展示前 10 秒（短片展示到结尾）；工作区恢复优先采用保存的区间。下方时间条保持整个片源的长度，左右指针标出并可拖动图表可见区间，不增加面板宽度。图表深层分析只请求与当前 PTS/DTS 可见区间相交的完整 GOP；按可靠包表规范化 GOP 集合；同一集合内移动只更新展示窗口，实际缺失集合变化时再取消或补算，参考依赖需要时仍会从安全锚点预读。区间完成不标记为整片完成，Agent 的整片分析请求仍可独立使用。

每轨运行中的进度圆环在悬浮或键盘聚焦时显示暂停按钮，暂停后显示继续按钮，沿用播放控件的动画图标。暂停释放 Worker 和解码器，保留已确认进度及逐帧缓存；继续时按当前可见区间重建解码状态，按实际可读摘要的 AU 集合恢复进度，必要的参考重建单独计数；驱逐后的历史进度不冒充可复用数据。UI 与 Agent 的暂停/继续均经过会话 facade。


## 分析产品 v1（#99）

QP / NAL / 参考图视口显式请求 `summary`。普通码率、帧大小仍只用索引。`request_bitstream_stream` 默认保持原来的 full-result 行为，可显式传 `product: summary|blocks` 及 `window`；旧单帧 Agent API 仍返回完整 `AnalysisResult`，内部通过紧凑块适配成独立对象。summary 只允许 stream，单帧显式产品只允许 blocks；range 只支持原来的 legacy 结果，其他组合在准入时返回 invalid-request。

summary 与 blocks 是独立判别联合，不使用空 blocks 数组冒充完整结果。两者均携带原 metadata、sourceVersion / stream / configuration / AU / picture / layer / field、core buildId、recipe / analyzer、产品 schema / encoding 与索引版本。隐式 MP4 输入也明确使用 `mp4-analysis / mp4-input-v1` 身份；其他容器保留现有索引身份，不改变扫描器或索引证明。generation 和 request sequence 由会话及独立 worker 接收闭包检查；旧 generation 的回调不能授权缓存或显示。

summary 的 exact 表示 producer 完成了完整几何/覆盖校验，并不表示消费者持有块。面积加权 luma QP、null / unsupported、NAL/config、POC、帧类型和 active-list 候选边保持原语义；motion 仍 unsupported。`DiagramStore` 是逐帧摘要唯一拥有者，原有粗桶可在 raw 记录淘汰后继续显示，但 detailMissing 与实际可读摘要独立。完整摘要被驱逐就必须按需补算；块 LRU 驱逐不会使已保留摘要失效。同 source 的 build / index / stream epoch 变化会清除旧 raw / bins / seen 和精确块；暖复用先重新读取当前 manifest 或受源版本校验的服务端 capabilities。

blocks 使用 12-byte LE 记录：四个 uint16 几何值、int16 QP（-32768 为 null）、uint8 mode、零 reserved。producer 直接遍历 WASM 记录完成范围、模式、QP、重叠和完整覆盖校验，summary 不构造全帧块对象数组。需要 blocks 时在 take/grow 前复制至独立 buffer；只转移这个 buffer，绝不转移 WASM heap。缓存通过私有字段拥有 payload；只读稀疏数组访问器逐块生成独立冻结记录，旧公开 API 返回独立对象数组。相同私有拥有者内的验证证明用不可伪造的模块私有 symbol 传递，不信任 serialized validated 标记。

产品二进制响应以固定 VAP1 magic、uint32 header 长度、UTF-8 JSON header、可选块 payload 和 SHA-256 组成；checksum 覆盖 magic 到 payload 的全部内容。保留旧 JSON 缓存入口，不把旧 JSON 识别为新 summary。读取使用 fd.stat 和小型格式前缀，在 body 分配前选择限额；长度、count、版本、checksum 和几何均在使用前验证。响应逐段读取，Content-Length 超限、短读、长读和未知格式明确失败，不引入压缩解压路径。

| 新产品边界 | 硬上限 |
| --- | --- |
| metadata | 1 MiB；在 JSON 分配前计算 UTF-8/转义和结构预算，保留原 4096 NAL 准入能力 |
| 单产品 wire frame | 3 MiB；块数仍为 131072，分配 payload 前检查 count / stride / 长度 |
| 服务端摘要页 | 32 个 AU / 1 MiB；按完整身份及 AU/32 分页，成员缺洞明确，页 key 与全部成员 namespace 一致 |
| stream 引用页 | 32 项 / 64 KiB；包含产品、编码、AU 及成员身份 |
| 每 work 未确认结果 | 同时不超过 32 项与 32 MiB；ACK 前还预留下一帧最坏 3 MiB 产品 / 8 MiB legacy，生产中帧包含在预算内 |
| HTTP 结果读取 | 2 个并发 slot；每响应最多 3 MiB 产品 / 8 MiB legacy，读/编码结束且响应完成或断开后才释放 |
| 会话存储 | 原有 blocks 32 MiB 与摘要 32 MiB，逻辑计量包含 payload、metadata 和只读 facade 估算；不增加第三份逐帧缓存 |
| 服务端存储 | 原有共享 128 MiB / 1024 文件；摘要页、块、引用页及 manifest 共同计费，活跃 lease 保护未确认文件 |
| 合并计划 | 最多 8 个 source epoch；每计划最多 2048 GOP / 8192 个所选 AU 时钟 / 256 KiB，超限不启用合并，仍走可靠原路径 |

这些是格式、队列和逻辑存储准入，不是 RSS 或所有瞬时拷贝之和的承诺。metadata / frame 的限额大于早期原型草稿，目的是容纳旧的极端合法 NAL metadata；没有调高本地或服务端缓存来换取命中率。摘要页原子替换并校验所有成员，精确块单独有界保存；不能仅凭 processed 位图授权 raw 查询或遮罩。

暂停终止 worker / decoder / reader / lease。恢复允许从闭合 anchor 重建参考链，但同消费者已持有摘要只收到小型 coverage 通知，不重复交付或 put 产品；进度按 AU 集合去重。cache reply 与 coverage 之间若发生淘汰，会回传仍独立拥有的合法摘要修复；服务端同样在发布引用前重验或重写失读产品，不能发布悬空覆盖。同 GOP 需求依据可靠包表的精确所选时钟和其他 GOP 的排除边界合并，不以 PTS 邻近猜测 AU。同集合中移动、后续 chunk、完成和暂停恢复都保留最新显示窗口。已暂停的用户任务不会自动继续。遮罩只读当前身份匹配的 blocks，检查 presented picture / PTS / coded geometry；缺块时不能用 summary 显示。暂停帧的精确需求可优先于自动 summary 任务，播放期间仍 cache-only。

计数区分 init / open / feed / step / decodedAU、preroll、products、cacheHit、uniqueDelivered 和 readBytes；core 调用时间为 inclusive，不代表独立像素重建成本。payloadBytes 是实际发送产品内容的 UTF-8 metadata + owned payload，coverageBytes 单列小型通知，均不包括结构化克隆封装或 telemetry；legacy IPC 字节不可可靠直接观察，记 null，避免额外全量 JSON 序列化污染。HTTP wire 内容由浏览器 Content-Length 独立计量。逐 chunk 快照是截至最后确认 chunk 的观测下界；硬终止前未完成调用不可测。heap / Node RSS 只在明确采样点记录，不用累计 payload 或额度冒充峰值。

CI 运行字段/图表等价、零新增解码计数、预算、损坏和取消合同；不使用指定 Mac 的 15% 冷态或 0.5s / 1s 暖态绝对时限。性能验收另用同一 M5 / 32 GiB、同一 Chromium、干净 d8f69d1 baseline 与产品构建的至少五组 AB/BA：新 profile、新 worker 和空分析缓存，索引状态单列，OS 页缓存不清；原始顺序、内容字节、首结果、CPU/RSS/heap 采样及范围全部保留。面板关闭的 facade 测量和实际图表/遮罩 UI 回归分开报告。core pin、播放路径、容器扫描和 alpha.4 发布状态保持不变。

产品 schema 为 2（key 与服务端产品文件同步隔离旧 schema）；LE12 编码和 VAP1 外层 framing 不变。H264/HEVC 可附加 `sourceLayout`，只从当前 configuration 的 SPS 解析 coded 和精确 visibleRect，记录 configuration-sps-v1 provenance。metadata/header/预算与 checksum 一并验证该证明。遮罩允许浏览器 plane padding 或预裁剪，但必须 coded 完全相等，或 result coded 与 SPS 完全相等且 presented visibleRect 与 SPS 完全相等、plane 完整包含可见域；未知配置不能用尺寸取整猜测。旧 legacy 元数据仍可读，缺该证明且几何不匹配的旧 blocks 不授权遮罩或精确请求暖命中。

32 MiB 是每个 work 的未确认 descriptor 内容字节与下一帧最大预留的双重背压：初始下一帧 <=3 MiB（legacy8 MiB），每次 ACK 前检查 pending+next；暂停/终止前不发下一次 producer ACK。3 MiB/8 MiB 分配准入在 runner 构造 payload/legacy块对象数组之前，legacy额外按实际bounded metadata保守预算。并发默认8、最大32，因此32×N MiB仅是逻辑未确认引用上界（256/1024 MiB），并非RAM；共享128 MiB store会在保护文件无法驱逐时明确拒绝新写，重复引用不等于重复文件。实际每worker同一时刻最多一份输出（产品3 MiB/legacy8 MiB准入），另计最多两个HTTP读取slot、受限编码/解析临时拷贝和独立512 MiB WASM heap上限；不宣称全局32 MiB或RSS总上界。

所有stream产品（summary、blocks和默认legacy full）均绑定本次独立读取的当前build；worker plan/cache/coverage、remote status和最终产品必须与它一致。完整stream恢复也只从当前实际owned blocks播种，旧AU仅发coverage，不重复chunk或cache.put；块被逐出则允许从仍拥有的已校验输出修复。legacy owner保留当前index namespace，不能以summary可读性替代完整产品。
