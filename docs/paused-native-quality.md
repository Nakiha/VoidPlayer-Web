# 暂停原生帧 ROI 与显式缓存准备

“测量暂停画面”将已暂停的两个原生 FLV 轨道明确锁定为帧对，再复用独立原帧 ROI、持久 PSNR/可选 SSIM/grid、未人工判断候选、双窗共享与原帧查看。普通手选 AU 入口继续提供；本功能不自动暂停、定位或切换解码器。两源对应关系由调用者指定，相同 PTS 不代表对应。

## 见证链与支持子集

FLV packet timeline 在检查单图、唯一时钟后，将绝对 AU/配置序号/实际源 PTS、DTS/压缩字节 offset、size 交给原生解码器。`decode()` 成功受理后，记录精确的实际 chunk clock；异步输出只能消耗同 epoch 的唯一受理记录。未知/重复输出、重复时钟、多图、字段、配置不明或容量溢出拒绝身份。reset/reconfigure 清空记录；不会把当前 generation 附到旧输出。配置见证是每 epoch 一次序列化的完整字节十六进制，至多 4096 字节，不是散列或认证。

只有原始 `VideoSample` 经唯一 presenter 成功提交后，session 才记录 input/资源几何/commit。prefetch、失败或无操作绘制不产生新见证；这里的成功提交不是物理屏幕扫描完成。捕获要求当前暂停、非 busy、相同 source instance 与代际。普通旧 `PresentedFrameToken` 不升级为本协议。

来源在实际打开 URL 时固定：同服务 `/api/media/ID?v=VERSION` 与独立保留的 library reference 完全对应。可编辑 `MediaInfo.source` 不构成传输证明；本地 File 即使带媒体库 lineage 也不符合。页面工具 `capture_presented_quality_frame` 只返回 `voidplayer-native-presented-input`、`binding:unbound`，没有像素/IO/额外解码/网络。它不是服务器安全凭据或 PairTarget。

显式只读查询现有可信 `psnr-source`，再按 **捕获 AU** 读取 `psnr-frames?afterAu=AU&limit=1&buildId=BUILD`。共享 `bindNativePresentedFrame` 比较实际服务 URL/ID/version、producer、完整索引 namespace/build、精确配置字节、AU/配置/包 offset/size/PTS/DTS 与几何；时钟只作一致性校验，不能搜索候选或跨源配对。查询期间换帧/换身份/换来源的迟到回复不落入新选择。锁定后后续播放不改写已经明确的任务意图，实际执行仍重新验证来源、缓存和原始帧。

子集：当前浏览器真实支持的 H.264/HEVC WebCodecs FLV/Enhanced FLV，逐行单图、明确完整色彩/色度位置，已有质量预算内的 isolated/forward/闭合32 AU GOP。平台/profile 支持按实际 decoder 结果判断；WebCodecs 不等于硬件解码。本地 Chromium 正例为 H.264 High 8bit；WebKit 为 H.264 High 8bit、HEVC Main 8bit/Main10 10bit；本地 Chromium 的 HEVC 走软件回退时本入口明确拒绝，不伪称原生覆盖。

WASM 播放、其他容器、转换成 CPU YUV/RGBA 的资源不能直接捕获。只允许有显式精确方形 SAR、无源裁剪、无旋转的可证明几何；原生 allocation 可在严格可见矩形外带 padding，但可见源网格必须完全等同 SPS，不能用四舍五入 display 尺寸证明 SAR。ROI 为两侧相同的偶数整数可见源网格，不是 CSS、截图或原生色彩转换后的像素。

实际数值始终由原独立后台 decoder 获取原始源平面，记录该 decoder/算法/provenance。屏幕像素不计分。源 stat/version 不是内容认证，引用完整性 `not-certified`、concealment detection `unavailable`；缺引用并非一律拒绝。没有区间、容器扩展、VMAF、分布式或自动缺陷判断。

## 显式有界准备缓存

发现缺缓存只显示失败和一个独立动作：`POST /api/media/{id}/psnr-index`，JSON `{version}`，原 actor cookie/header、同源 Origin、`X-VoidPlayer-Action: quality-source-build`。读取/捕获/快照/评分不调用它。普通 FLV 载入原本要求服务端完整索引，既有播放策略不在本批重写；新入口不会再发 build=1 或 completeIndex。缺失回归在载入后显式清缓存，检验新入口只读失败与用户准备动作。GUI 须用户点击；HTTP Agent 同样可直接调用，不受当前播放状态限制。

上限由 `QUALITY_SOURCE_BUILD_LIMITS` 一处声明：来源64MiB、实际磁盘读128MiB、包/序列化索引沿用质量准入限额、Worker heap256MiB、执行30秒。仅完整、无恢复扫描的 FLV 可提交 server producer evidence；打开文件前后与提交前核验版本/root/stat。现成缓存只读，untrusted 缓存明确拒绝，不静默清除或重建。它不改变通用索引器的默认策略，也不是持久 build job/自动重试。

同一质量 admission 围栏覆盖准备、评分与其他冲突操作。整任务在独立 Node/Bun Worker 内；取消/超时先撤销后续 IO/发布，必须等实际 FileHandle 关闭和 Worker 物理退出才释放容量。被系统阻塞的 IO 清理可能延长客户端可见延迟，30秒是执行取消 deadline，并非承诺清理在30秒内结束。客户端超时不等于后台已退出。取消与原子 commit 竞争可以留下有效完成缓存，须重新读取；不承诺取消会回滚已提交缓存。

关闭 ROI 窗口取消未完成的准备/快照，已提交持久评分仍由服务持有。原幂等正文、actor/client/空间围栏、结果回收后回执重放、原子候选及导入历史降权复用原业务规则；不新增一套任务服务。

## 验证与成本边界

- `native-presented-frame.test.ts`：受理记录/reset/容量、成功呈现/prefetch/失败绘制、传输来源、篡改与本地 lineage 拒绝。
- `quality-source-build.test.ts`：真实 HTTP 只读缺失/显式构建/actor与Origin围栏、来源/实际读/包/索引预算、真实已打开文件阶段取消/物理退出/准入与无迟到发布；真实返回缓存见证的绑定与字段/namespace/build/几何负例。
- `check-presented-quality-browser.mjs chromium|webkit`：固定合成 H2648/HEVC8/HEVC10，真实暂停呈现的独立图像码与 FFprobe AU 顺序对照；UI 显式构建、查询迟到换帧、完整评分/同键丢响应/共享候选/原帧查看，SSE与SSIM独立原始平面对照。另以真实 decoder/presenter 验证负时钟、零 CTS drain、重复时钟与多图拒绝。核心完整CI登记双引擎，identity轻套件不承接 core。
- `check-quality-release.mjs` 在三平台实际编译包通过新有界入口准备既有九类样本，再执行原评分/任务/候选/重启验收；本地平台结果不代替其他平台CI。
- `scripts/tools/fixtures/native-presented.mjs FFMPEG FFPROBE` 显式重建冻结的合成素材和原始帧。期望数据有固定hash、工具版本及独立 FFprobe pkt_pos→AU；测试不当场重算并覆盖期望。初始合成源的 unspecified VUI 曾在旧main同样触发 WebKit colorSpace 校验；生成器改为明确编码参数后验证实际 SPS/FFprobe，不在生产中伪造源标签。

本地可行性成本对照在相同浏览器/native decoder/core、1280×720 H264 B2 120帧上，基线7c399ad与本功能各一次预热、4次交替 AB/BA、每次2400ms。Linux进程族 CPU ticks 不是独立 decoder CPU；预先设 speed中位比≥0.90、CPU ticks中位比≤1.10。详细精确候选结果随验收报告记录。小型成本实验证据不替代历史完整性能 suite；旧性能负结论保持，未证明通用性能通过或旧未知CI根因修复。

最终本地汇总见 [结构化验收](validation/paused-native-quality/local-acceptance.json)：source145/145、contract30/30、受影响逻辑85/85、Node/Bun准备各5项以及Linux实际编译包通过。四个实际原生GUI正例通过，Chromium HEVC两档明确平台拒绝；双引擎共136个 original/负时钟/drain 正例输出用实际呈现图像码独立确认 AU，重复时钟、多图和真实interlaced SPS另列拒绝矩阵。最终小型成本速度比 Chromium1.00020/WebKit1.00002，CPU ticks比0.99690/0.97848；不是通用性能验收。

可复跑成本实验：先为基线7c399ad单独构建，再准备声明的1280×720/120帧/H264 B2/GOP30合成源，运行 `node scripts/tools/perf/benchmark-native-presented.mjs BASELINE_DIST SOURCE_FLV REPORT_DIR`。源SHA和各次原始报告记录在报告目录，实验不写生产数据或改变全量性能阈值。首次source套件的Vite收尾失败也保留：两断言通过，但gitignored core符号链接许可目录残留8个watcher；逐文件SHA核对并物化同字节本地core后原测试正常退出，source全套通过。没有修改测试源码/等待上限，不能据此声称历史远端WebKit/observer失败已根治。远端最终head完整CI、Windows/macOS包和父任务独立复核尚待。
