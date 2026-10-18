# PR109 验证记录

2026-10-18 的本机验证记录，以及 2026-10-19 对修复提交的复核。仅覆盖固定的
8-bit YUV420、1920×1080、60 fps、600 帧 VVC 样片和短时 Chromium 播放。

## 源码与产物

- Web 起点：`c398124e66dbd8724060c4a514b22a5df82ad503`。
- 构建仓库：`Nakiha/VoidPlayer-FFmpeg-Build@71d2ccbd2c5175dfcdffb48f8428695067227a7c`。
- 旧 FFmpeg：`FFmpeg/FFmpeg@946fcce07b6dcd0331c8cc609192aeff5e1924f8`。
- 原 SIMD FFmpeg：`Nakiha/FFmpeg@01cba57fc16f1d194762e6d3fabf256e7904b7ab`。
- 测试修复：[8998a1a670c81a04d144c36f9e2d3aa680c10720](https://github.com/Nakiha/FFmpeg/commit/8998a1a670c81a04d144c36f9e2d3aa680c10720)，新标签 `n9.0.2-vpsimd-sad-testfix`；原标签未移动。

修复仅改动 `experiments/wasm-vvc-simd/{test-inter.c,README.md}`。
先推送依赖修复，再更新 Web 发布锁。19 日使用空构建目录、固定工具链与 Build 修订，
完整编译 FFmpeg、dav1d 并链接 ST/MT；四个 JS/WASM 文件均与原 SIMD 产物逐字节相同。
18 日的 `fixed` 记录仅重新链接原生产库，19 日的 `followup` 才是修复提交的完整重编。

[复核汇总](followup-summary.json) 记录当前 pin、体积、哈希及检查结果；
[来源清单](followup-provenance.json) 和 [ST](followup-manifest-st.json) /
[MT](followup-manifest-mt.json) manifest 分别绑定两种产物。
原取证目录只保留了最后复制的 MT manifest；这里从各自原始 dist 补齐了
[原 SIMD ST](original-simd-manifest-st.json) / [原 SIMD MT](original-simd-manifest-mt.json)。
[原产物来源](original-artifact-sources.json) 与
[旧 CI provenance 校验](baseline-provenance-verification.json) 保留对比来源。
日志中的用户主目录已替换为 `<home>`，并清理了行尾空白。

## 正确性与内存

原测试分别以 C-first 和 SIMD-first 顺序复现 ASan `heap-buffer-overflow`：
[原 C-first 日志](original-repro.log)、[原 SIMD-first 日志](original-simd-first-repro.log)。
修复后的全部 inter 2580 例、ALF/分类 2920 例均在 O1+ASan、O2 优化构建中通过：
[inter ASan](inter-asan.log)、[inter O2](inter-optimized.log)、
[ALF ASan](alf-asan.log)、[ALF O2](alf-optimized.log)。
这只对实验入口及 C reference 做 ASan，没有对整个生产解码器做 ASan。

[逐帧记录](frame-validation.json) 保留样片 SHA-256、native 600 帧可见像素哈希，
以及 direct core / App 各八组结果：旧、原 SIMD、仅重新链接、完整重编 × ST/MT。
汇总前逐项断言所有帧哈希与 native 相同，再记录各组完整序列的 SHA-256 和 PTS。
App 每组还通过 seek `599/1/360/0/598/2/599/0`、EOF 后恢复、尾帧后迭代结束。
完整重编两组在 19 日重新执行，native FFmpeg 8.1.2 也重新解码全部 600 帧。

native 的精确源码提交未独立确立，二进制 SHA-256 已记录。
App 的哈希前缀复用了 App descriptor，不能据此宣称独立 native 元数据等价。
生产发布的 ABI、能力注册表、无效输入和 AV1 接口检查见
[release-core 日志](followup-release-core.log)。Web 构建通过，契约套件 18/18 通过。

## 性能记录与边界

[core 原始样本](performance-samples.json)、[core 汇总](perf-summary.json)、
[浏览器样本](browser-samples.json)、[浏览器汇总](browser-summary.json)
来自 18 日已完成的独立 A/B；19 日复核原始样本和来源，未重新计时。
每种 ST/MT core 在 AB/BA 两个顺序各热身一次、计时两次；每侧四个有效样本。
core API 中位耗时减少 15.25% ST、14.80% MT2，包含包分配/复制及输出转换。
有窗口 Chromium 153 / Metal 12/12 通过，两侧约 60 fps；无窗口 SwiftShader
0/12 达标，约 15 fps，失败记录保留。没有复现 20.5% 或证明 App 全面加速。

[压缩体积](compression.json) 对实际 `.wasm` 使用 Node Brotli quality 9 / gzip level 9；
不包含 JS。不能将本次结果推广至 10/12-bit、4K/8K、其他 VVC 工具组合、其他浏览器、
动态分辨率或畸形码流。未做长期温控、功耗和实体屏幕 scanout 测试。

## 复现入口

1. 在上述 Build 修订中，预检出发布锁的 FFmpeg 与 dav1d 修订，并使用 Emscripten 6.0.9。
2. 运行 `scripts/build-wasm.sh --ffmpeg-ref n9.0.2-vpsimd-sad-testfix --ffmpeg-remote https://github.com/Nakiha/FFmpeg.git --skip-package`，再加 `--mt` 构建另一变体。
3. Web 仓库运行 `node scripts/prepare-release-core.mjs /path/to/build-repo` 和 `node scripts/check-release-core.mjs`，校验来源及真实接口。
4. 实验 DSP 测试命令见 FFmpeg 的 `experiments/wasm-vvc-simd/README.md`，分别运行 ASan 和优化构建。
5. Web 运行 `npm run test:contract`、`npm run build`。全帧/App 的原始本机脚本与完整日志随本次本地证据归档保留；本目录保存可审阅的来源、逐帧序列摘要和计时样本。
