# WASM 9.0.2 升级与体积实验（2026-10-13）

播放/FFmpeg 容器索引共用 `voidplayer-core` 产物，各 Worker 使用独立实例；
MP4/FLV 包索引仍走已有 TypeScript 路径。码流分析使用独立的
`voidplayer-analysis`，保持单线程和按需加载。

## 固定来源

- 播放构建仓库：`Nakiha/VoidPlayer-FFmpeg-Build@71d2ccbd2c5175dfcdffb48f8428695067227a7c`（选择并校验播放 SIMD backend）。
- 播放/索引：`Nakiha/FFmpeg@8998a1a670c81a04d144c36f9e2d3aa680c10720`（标签 `n9.0.2-vpsimd-sad-testfix`），n9.0.2 加 VVC WebAssembly SIMD128 ALF/inter/分类后端；固定 8-bit 1080p 样片全帧比对通过，范围见下。
- 分析：构建仓库及 FFmpeg 修订由 `scripts/release-analysis.json` 独立固定；本次未改动分析锁。
- Emscripten 6.0.9、dav1d 1.5.1，未同时升级工具链或引入新解码功能。

分析原基于 n8.1，播放原基于 n9.0.1；两者现在对齐 9.0.2。
具体发布输入以 `scripts/release-{core,analysis}.json` 为准，源码先推送再更新锁。
构建脚本拒绝源码版本、工具链或优化选项不同的旧缓存，输出记录优化参数。

## 传输体积

播放 `.wasm` 文件字节数（不含 JS），Brotli quality 9 / gzip level 9；
以 PR109 复核产物为准，文件哈希及分开的 ST/MT manifest 见 [验证记录](validation/pr109/README.md)：

| 核心 | 原文件 | Brotli | gzip |
| --- | ---: | ---: | ---: |
| 播放/索引 ST | 6,096,217 | 1,522,651 | 1,869,234 |
| 播放/索引 MT | 6,148,397 | 1,529,954 | 1,880,344 |

Brotli 减少约 75% 下载字节。这是 HTTP 传输收益，不是 WASM 解压后内存或原文件同比缩小。
保留原文件与两种压缩表示会增加发布包磁盘占用。压缩在构建时完成，不占用请求处理 CPU。
客户端按各文件 SHA-256 生成版本 URL；服务端校验实际字节后才提供不可变缓存和压缩表示。
HTML 重新验证，视频 Range 语义不变。Vite Worker 同样注入版本映射；Emscripten pthread 入口保留完整脚本 URL。部署要求见 `deploy/operations.md`。

## 编译实验

环境：macOS ARM64、Node 24.15、Emscripten 6.0.9。分析固定三份样片中的第 40 个包目标，
每项预热一次、计时四次，以下取排序后第三项（上中位数），包括输入读取和目标图像分析。
三个方案输出的块和 picture 元数据哈希一致；此小样本不能代表所有浏览器和内容。

| 分析编译选项 | 原文件大小 | H.264 | HEVC | VVC |
| --- | ---: | ---: | ---: | ---: |
| O3，原策略 | 2.90 MB | 91 ms | 293 ms | 848 ms |
| O3 + LTO | 3.29 MB | 90 ms | 289 ms | 833 ms |
| Oz + LTO | 1.34 MB | 95 ms | 422 ms | 1,250 ms |

保留 O3：O3 + LTO 的小幅耗时差不足以抵消体积增加，Oz 的 HEVC/VVC 耗时增加约 44%–48%。
播放核心的 O3 + LTO 同样从 6.30 MB 增至 7.23 MB；保留原来的 O3 编译、O2 链接策略。
SIMD 继续开启。编译仓库保留显式实验选项和隔离构建目录检查，后续优化可复现比较。

10 月 13 日编译实验的原始数据位于本地 `.run/wasm-refresh/`；
PR109 的来源、逐帧结果、性能样本和 ASan 日志见 [验证记录](validation/pr109/README.md)。

## PR109 本地复核（2026-10-18/19，macOS ARM64）

`experiments/wasm-vvc-simd/test-inter.c` 的 SAD 输入原来只分配并初始化 6 行，
而 `h=16, dy=0/4` 会访问到第 18 行（从 0 起）。WASM AddressSanitizer
分别确认 C reference 和 SIMD 函数越界；原 1780 例的“两边相等”不足以证明正确。
测试修复按 `h+4` 行分配并初始化，新增 800 个末行独立预期值用例；
修复后 inter 2580 例、ALF/分类 2920 例在 ASan 和优化构建均通过。

固定 `h266_10s_1920x1080.mp4` 为 8-bit YUV420、1920×1080、60 fps、600 帧。
旧 pin、新 pin、测试修复后的 ST/MT 六组都比较了全部 600 帧的可见像素，
与独立 native FFmpeg 8.1.2 一致；App 包解码路径的前后 seek、尾帧和 EOF 通过。
本次没有发现需要修改的生产解码代码；测试补丁不参与 core 编译，重新链接的
四个 JS/WASM 文件与新 pin 的产物 SHA-256 完全相同。

以上仅覆盖这一固定样片，不能推广到 10/12-bit、其他分辨率、VVC 全部工具组合或浏览器。
性能必须使用不同来源哈希的新旧 core，在相同配置下热身并交换顺序测量；
将 feature core 同时复制给 baseline 的 informational CI 性能任务不构成新旧 core A/B 证据。
测试修复已推送为 `8998a1a670c81a04d144c36f9e2d3aa680c10720`，
`release-core.json` 已固定该提交与新标签 `n9.0.2-vpsimd-sad-testfix`；原标签未移动。
构建仓库和生产 DSP 源码保持原修订；修复只涉及实验测试及其说明。
19 日从该修复提交全新编译 FFmpeg/dav1d 并链接 ST/MT，四个产物也与原 SIMD
产物逐字节一致；两组重新通过全部 600 帧可见像素、App seek/EOF 和发布来源校验。
原六组与本次两组的证据分别记录于上述验证目录。

本机 Apple M5、macOS 27.2、Node 24.15.0 的独立 A/B，每个顺序先热身一次、
再测两次，交换 AB/BA，共每个 core 四次计时。600 包 core API 路径中位耗时：
ST 11,953 → 10,130 ms（减少 15.25%），MT 两线程 6,774 → 5,771 ms（减少 14.80%）。
计时包含包分配/复制、解码和输出转换，不包含文件 IO、初始化或像素哈希；不是纯解码 CPU 时间。

同源代码、独立旧新 core 构建的有窗口 Chromium 153（Apple M5 Metal、默认 MT）
AB/BA 12 轮检查全部通过，热身后播放均约 59.6–59.7 fps、0.997×，不能据此宣称
App 播放加速 15% 或复现 20.5%。无窗口 Chromium 使用 SwiftShader，两组全部未达实时
（约 15 fps）；单独记录为环境限制，不作为生产 core 回归或新旧性能收益证据。
