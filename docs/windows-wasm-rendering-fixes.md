# Windows 真实 WASM 呈现与续接修复（2026-09-11）

后续已接入两个用户模式：默认“正确颜色（SDR）”显式走 WASM，另一个是“匹配浏览器（近似拟合）”。设置、切换和能力边界以 [色彩契约](color-pipeline.md) 为准，下面记录的是加入菜单之前的修复证据。

使用 Actions 34499068492 的固定 ABI v2 core，在 Windows RTX 5080、Chrome 153.0.8010.36 / Edge 152.0.4191.66 上测量。原片为 3840×2160 HEVC，约 3 秒。记录的是应用帧提交和源尺寸 RGB 读回，不是物理屏幕扫描输出，也不是长时间稳定性测试。

## 已修复

1. 软件色度由 nearest-block 改为按资源 AVChromaLocation 双线性重建。8–16-bit 完整码值参与插值，保留 source/resource 标签；未知位置采用明确的 center 默认。WebGPU、WebGL、CPU 同步实现。
2. packet WASM 已有显示帧之后开始播放时，session 使用 `framesFollowing` 继续读取，避免 `framesFrom` 再定位同一 GOP。其他后端和包含起始帧的原 API 不变，seek 仍可重定位。真实单/多线程回归验证续接像素与独立 seek 输出一致。
3. Windows 对照新增 `--wasm`，使用真实 core 输出绘制，并逐字节验证独立 FFmpeg 参考。测试 HTML 添加 COOP/COEP；首次缺少这些头的试跑是 single-thread，正式结果已重跑为 multi-thread。基准支持 `BENCH_FORCE_WASM=1`，通过禁用测试页面的 VideoDecoder 走实际应用失败回退，不修改生产解码策略。

## 原片画质

三帧 source PTS 为 6000 / 988407 / 1985868 µs；WASM 原始字节均与 FFmpeg 参考相同。

| 浏览器 | 改前 RGB MAE | 改后 RGB MAE | 改前最大差 | 改后最大差 |
| --- | --- | --- | --- | --- |
| Chrome | 0.1783 / 0.1919 / 0.2206 | 0.0907 / 0.0987 / 0.1142 | 77 / 94 / 80 | 45 / 47 / 44 |
| Edge | 3.8238 / 4.2564 / 3.9333 | 3.7878 / 4.2206 / 3.8971 | 79 / 93 / 78 | 48 / 49 / 48 |

这是更合理的色度重建带来的改善，**不是跨路径逐像素一致已经通过**。Edge 的原生矩阵/transfer 差异仍然存在。BT2020 SDR 合成色块仍失败：内部最大差 83；新重建下整帧边缘最大差 162（旧独立参考测试 115），不能声称所有素材的原生对齐误差都下降。原生资源标签与码值语义问题不通过覆盖源标签或反向拟合解决。

## 性能

实际 session benchmark，4K 单/双轨，修改前每场景一次；修改后各三次，全部启用多线程 core。阈值未改；不同重复间有系统负载波动。

| 模式 | 修改后 fps | 结果 |
| --- | --- | --- |
| Chrome WASM 单轨 | 59.57–59.60 | 3/3 通过 |
| Chrome WASM 双轨 | 56.45–58.89 | 3/3 通过 |
| Edge WASM 单轨 | 57.23–59.52 | 3/3 通过 |
| Edge WASM 双轨 | 53.88–57.33 | 3/3 通过 |

修改前双轨 Chrome 51.88 fps、Edge 52.34 fps，均 below-realtime。修改后 Edge 双轨最低速度 0.902，接近 0.9 门限，仍有优化空间，不能保证所有硬件 60 fps。原生单/双轨另外四次基准全部通过。软件 GPU 上传通常低于 1 ms；解码等待不能计成纯 GPU shader 耗时。

## 验证与限制

- 78 项 Node 测试通过，包括真实 WASM 原始平面、seek/reset/续接、16-bit、session 和播放队列。
- 两浏览器各 42 组色度位置/位深/planar/NV12 用例，WebGPU 与 WebGL 均对 CPU 参考最多 1 码值；独立手算测试区别 left/center、边界和位置枚举。构建通过。
- 原生/真实 WASM 的颜色验收继续明确失败；不放宽最大差门限。
- 未实现自动更换解码器或严格色彩模式，未改浏览器代码。Edge 原生 HEVC 的全局色偏和 BT2020 原生资源语义仍是未解决项，现有 GPU 导入绕行候选已证明无效。

产物：`artifacts/color/windows-file-wasm/report.json`、`windows-wasm/report.json`、`wasm-nearest-baseline.json`、`bench-wasm-{chrome,msedge}-fixed.json`、`bench-native-chroma-{chrome,msedge}.json`。
