# Issue #56 验收状态（2026-10-13）

[Issue #56](https://github.com/Nakiha/VoidPlayer-Web/issues/56) 的首批交付范围是支持矩阵中的普通 MP4 MVP。本表记录已实现的闭环、独立正确性证据、持续负载测量及三平台发布门禁。功能完成不能代替发布门禁通过；测量结果由声明的机器和负载限定。

## 已实现及可运行证据

| 范围 | 当前行为 | 验证入口 |
| --- | --- | --- |
| 按需启动 | 打开轻量面板默认只有码率和帧大小，QP 关闭；暂停遮罩优先当前 picture 的安全 GOP 预滚 | `check-bitstream-analysis-browser.mjs webkit --layout-only` |
| 独立分析 | 本地 Worker、服务端 Worker 使用独立核心；分析失败、取消不改变健康播放路径 | `test/bitstream-analysis.test.ts`、浏览器 matrix 用例 |
| 源身份 | source version/config/AU 与呈现 token 一致；歧义拒绝，换帧清除旧遮罩 | unit、core、browser matrix 用例 |
| 流式输出 | 三种 codec 各 600 帧、B 帧、后段 GOP 与顺序对照；逐块 take/release；消费背压、租约和预算 | `test/bitstream-analysis-core.test.ts`、`test/bitstream-analysis-server.test.ts` |
| 服务端调度 | 全局默认 8 路，管理页 1–32；优先排队的当前帧；相同工作多 consumer 共享，租约失效回收 | server unit/media、admin browser 用例 |
| 独立 VVC 答案 | VTM 原生内置统计，3 个 I/B picture 共 32983 个 CU 全量哈希、具体记录及 L0/L1 身份 | `docs/fixtures/bitstream-analysis-vtm.json`、core VTM 回归 |
| 稀疏有界区间 | 枚举实际 picture，跨不同起止点复用；重启复用持久块；损坏/淘汰块补缺；完整命中不初始化 WASM | 本次新增三 codec core、服务重启/淘汰、12 格 browser matrix 断言 |
| 整片恢复 | 按封口 GOP 复用；完整命中不初始化 WASM；缺口保留参考预滚；每 AU 只交付一次；新 lease 从 0 开始，拒绝旧任务游标 | 三 codec core、server restart/corruption、两浏览器 local/library 图示用例 |
| 真实几何组合 | coded 64×64、非零 crop（8,4,48,48）、SAR 2:1、0/90/270°；两浏览器各 12 个输入/解码组合 × 并排/分屏 × 1/8 倍，逐像素及命中；另有 RGBA 三角度 | `testing/browser/media/bitstream-geometry.mjs`；两浏览器加入 CI |
| 能力语义 | 固定 `blocks-basic-v2`，检查版本及 blocks/modes，8-bit luma QP；高位深 QP unsupported 不算完成该能力 | core 缓存拒绝用例、server 高位深用例 |
| 发布来源 | FFmpeg 9.0.2；两个 core 源分支已推送；Web 固定源码/ABI/工具链与哈希 | `scripts/release-{core,analysis}.json`、[WASM 实验](wasm-refresh.md) |

缓存查询仍做有界元数据及 GOP 边界语法读取，需要重建参考的缓存帧仍可能被解码。整片缓存复用逐块推进、不累积 GOP 块数组；闭合起点或明确 EOF 允许跳过已完成段，dependent GOP 保持参考依赖。只为缺失/失效的 picture 发布新结果。重启不恢复 decoder 内存或运输游标，重新提交使用新 lease，并按持久 picture 缓存重建覆盖。

## 收尾验收与发布门禁

1. **持续争用与默认预算依据已补足**：Apple M5 / 10 CPU / 32 GiB / Node 24.15.0 / 可见 WebKit，8 个独立媒体库 H.264 流持续实际消费 120 秒，60 秒时持久化调低至 4 路、90 秒恢复至 8 路；不终止已启动任务，各路恢复后继续推进。共消费 8642 picture、约 4.50 GB 逻辑结果，旁路原播放基准 12/12 通过。Node 服务及分析 Worker RSS 峰值 1.65 GiB，Range 1180 次探测 p95 4.73 ms / p99 7.69 ms，12 次 seek p95 82.40 ms，取消回收 7.39 ms。逐秒样本、原播放吞吐/掉帧/首帧、CPU、I/O 与原始数据哈希见 [持续负载报告](fixtures/bitstream-analysis-sustained.json)。页缓存下 OS 物理 I/O 计数为 0，不用逻辑字节冒充磁盘流量。保留单任务 512 MiB heap 和所有原播放阈值；默认 8 路不是任意硬件或更高分辨率的性能保证。
2. **流式恢复与能力边界已验证**：三 codec 的完整缓存、缺口与 dependent 预滚和取消有真实核心对照；服务重启后用仅 manifest、无 js/wasm 的目录成功消费全部 120 帧，证明完整命中没有隐式解码；损坏/丢失 chunk 补缺后精确内容一致。旧 lease 失效、新 lease 游标从 0 开始，越界/倒退确认被拒绝。当前固定 `blocks-basic-v2` recipe 覆盖 blocks/modes 和 8-bit luma QP；任意独立 recipe/能力请求仍属扩展。
3. **三平台发布仍由当前 PR 的必需 checks 裁定**：[PR #58](https://github.com/Nakiha/VoidPlayer-Web/pull/58) 必须通过 Linux x64、Windows x64、macOS ARM64 的原生打包、包内三 codec 分析/重启复用，以及全部必需 Node、浏览器与发布汇总检查，才满足关闭门槛。本机或前一提交通过不代替当前代码的 CI。

收尾同时修复原有 CI：增量索引 fixture 用两个合法 sample description 触发容器适配器，避免旋转 MP4 改用精确 packet 路径后不再进入被测分支；网络拦截包含内容版本查询参数，等待请求有明确超时；FATE 指纹按 visible crop 比较全部有效样本，不把 coded padding 作为图像差异，也不放宽像素阈值或重生成答案。

`1767856` 的三平台原生包、两浏览器分析面板、HEVC 时间线及完整播放/FATE/HTTPS 功能检查已通过；最终汇总发现 gzip 头携带平台 OS 标记，导致解码器 sidecar 哈希不同。相同 deflate 内容仅改变该字节即可复现日志中的两个哈希。静态资源构建统一写 gzip 的 unknown OS（255），保持零时间戳与原压缩参数；解压内容、CRC 和原始 core 来源不变。汇总仍严格比较完整 JS/WASM、来源清单及所有压缩表示，不排除 sidecar 或放宽来源校验。

FLV/TS/MKV、fragmented MP4、field/layer、VVC 多 slice、复杂工具和 MV 可视化已排除在首批矩阵外。扩展这些功能无需阻塞声明范围内的 MVP，但不得把排除项勾成“已验证支持”。

## 本轮本地验证

macOS ARM64 / Node 24.15 / Bun 1.4.2：fast 39/39、contract 12/12、Node 全套 966/966、build 通过；WebKit 本地/媒体库 × browser/software × H.264/HEVC/VVC 的 12 格矩阵通过，包含缓存区间不加载 WASM 的网络断言。两浏览器的图示与增量索引回归、基础 WebKit UI 通过；FATE 15 项正向通过、8 项预期拒绝，无失败。可见 WebKit 播放基准沿用默认 4 场景、每场景 3 次、请求每次 8 秒，12/12 通过；实际墙钟时长与正常 EOF 见逐项报告，未改变原阈值。

新增原生包 gate 对三种 codec 均执行区间分析、服务重启、不同起止点的缓存重用，并比较包括原始分析 metrics 在内的完整记录；仅结果非空不能通过。测试仍在现有 `release-analysis` 清单项内，随三平台原生包 CI 运行。原始代码与可运行验收通过 PR #58 提交。

## 真实几何补充验收

这批回归发现并修复了包解码自动裁剪丢失非零原点、旋转 MP4 脱离可追踪 AU 路径，以及 RGBA 把显示尺寸当作存储尺寸的问题。素材由已知黑白条纹编码，并二次 remux 保证 sample entry 与 SPS 尺寸一致；预期坐标来自素材参数，不引用产品变换函数。DPR 2 下比较实际 WebGL 像素、遮罩 alpha、tooltip 命中，以及改变分隔线前后实际截图中的遮罩颜色。RGBA 还单独验证裁剪行和旋转。

core 源码 `36bd666` 已推送并锁定，ST/MT 从干净提交重建；上游新增真实 H.264 YUV/RGBA crop ABI 回归。前一提交 `5ebdf55` 的 [CI](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/38338919542) 已通过三平台原生打包、发布契约及包内三 codec 分析/重启验收；此结论不替代本次几何修改的最终 CI。

几何修复后的本地回归：Node 全套 961/961、fast 39/39、contract 12/12、WebKit 基础 UI 与 FLV 用例通过；WebKit/Chromium 的新几何用例各 12 个分析组合、48 个视口检查及 3 个 RGBA 旋转全部通过。可见 WebKit 默认播放基准仍为 4 场景 × 3 次 × 8 秒，12/12 通过，不修改阈值。包/Range 像素对照比较所有可见 YUV 原始样本，保留位深，不把新增的 coded padding 当作图像差异。
