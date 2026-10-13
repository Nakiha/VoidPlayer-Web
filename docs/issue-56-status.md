# Issue #56 验收状态（2026-10-13）

[Issue #56](https://github.com/Nakiha/VoidPlayer-Web/issues/56) 保持开放。本表区分已实现的 MP4 MVP、关闭前仍需补足的证据与明确排除的扩展能力。不能用随机/顺序或本地/服务端相互一致代替独立答案，也不能用短时测试声称默认 8 路持续运行没有资源争用。

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
| 能力语义 | 固定 `blocks-basic-v2`，检查版本及 blocks/modes，8-bit luma QP；高位深 QP unsupported 不算完成该能力 | core 缓存拒绝用例、server 高位深用例 |
| 发布来源 | FFmpeg 9.0.2；两个 core 源分支已推送；Web 固定源码/ABI/工具链与哈希 | `scripts/release-{core,analysis}.json`、[WASM 实验](wasm-refresh.md) |

缓存查询仍做有界元数据读取；需要参考的缓存帧仍可能被解码。整片连续请求尚不跳过缓存覆盖的完整 GOP，也不恢复服务重启前的流式游标。当前补缺实现适用于单帧和不超过 1 秒/32 picture 的区间，不能声称整片恢复已经完成。

## 关闭前剩余项

1. **真实几何组合验收**：已有几何纯逻辑测试、DPR 2 和旋转索引场景；补真实 coded crop、非 1:1 SAR、90/270° 旋转组合，并核对实际遮罩像素/命中与分屏、高倍缩放。纯合成矩阵不能替代此端到端证据。
2. **持续争用与默认预算依据**：已有四类场景、本地/库、软硬解、单双轨的短时报告；补默认 8 路及配置变更下的长时分析，记录 CPU/RSS/I/O、Range、seek、掉帧/吞吐与取消延迟，沿用播放阈值。单靠 Worker 数量有界不能证明 RSS 或播放体验达标。
3. **流式恢复与按需能力扩展**：明确并验证重新连接后的消费游标边界；跨服务重启当前只能按 picture/区间命中。若继续承诺整片缺口恢复，需按安全 GOP 补缺并保留所需参考解码。未来增加独立 recipe/能力请求时应扩展覆盖契约，不能把现有固定 recipe 当作任意能力集合已完成。
4. **三平台本次源码验收**：本次 macOS ARM64 原生包已通过空 PATH 启动、三 codec 分析、重启后的重叠区间复用，以及独立发布包契约检查。Linux x64、Windows x64、macOS ARM64 的正式依据是 `release-preview.yml` 对当前提交的原生打包、真实分析与浏览器结果，本地通过不能替代 CI。

FLV/TS/MKV、fragmented MP4、field/layer、VVC 多 slice、复杂工具和 MV 可视化已排除在首批矩阵外。扩展这些功能无需阻塞声明范围内的 MVP，但不得把排除项勾成“已验证支持”。

## 本轮本地验证

macOS ARM64 / Node 24.15 / Bun 1.4.2：fast 39/39、contract 12/12、Node 全套 960 项；WebKit 本地/媒体库 × browser/software × H.264/HEVC/VVC 的 12 格矩阵通过，包含缓存区间不加载 WASM 的网络断言。可见 WebKit 播放基准沿用默认 4 场景、每场景 3 次、每次 8 秒，12/12 通过，未改变原阈值。

新增原生包 gate 对三种 codec 均执行区间分析、服务重启、不同起止点的缓存重用，并比较包括原始分析 metrics 在内的完整记录；仅结果非空不能通过。测试仍在现有 `release-analysis` 清单项内，随三平台原生包 CI 运行。当前分支通过草稿 PR #58 提交，issue 仍保持开放。
