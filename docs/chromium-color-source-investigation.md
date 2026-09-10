# Chromium 源码与运行时色彩取证

2026-09-10。读取 Chrome for Testing 对应的 Chromium tag `153.0.8010.36`；Dawn 固定为该 tag 的 DEPS 中 `225a7ba1bcb997d26de3e894e04fb341638e8c5a`，Skia 为 `4f574af2444846ceca4d277a8095c5d4229d175f`。Edge 安装版为 152.0.4191.66，其定制实现不能由这个 Chromium tag 完全代替。下文分别标识源码事实、运行时事实和数学推断。

## 源码事实

1. [CreateExternalTexture](https://github.com/chromium/chromium/blob/153.0.8010.36/third_party/blink/renderer/modules/webgpu/external_texture_helper.cc#L209) 存在不同资源入口。零复制分支要求 NV12、SharedImage、Dawn 多平面支持和 `is_webgpu_compatible` 等条件。它内部可以创建 Y/UV plane view，并向 Dawn 提供 YUV 矩阵、源/目标 transfer 和 gamut 矩阵；这些底层入口不是网页公开 API。
2. 相同函数的复制分支经过 `PaintCanvasVideoRenderer` 产生 RGB SharedImage，再由 Dawn 做剩余色彩转换。因此调用 `importExternalTexture` 不证明浏览器内部零复制；浏览器内部 GPU 复制也不等于应用通过 `copyTo` 读回 CPU。
3. [gfx::ColorSpace::GetTransferFunction](https://github.com/chromium/chromium/blob/153.0.8010.36/ui/gfx/color_space.cc#L969) 将 `GAMMA22` 映射到纯 2.2 transfer，而普通 `BT709` 的显示实现采用 sRGB transfer；Apple BT709 是独立内部枚举。
4. [Blink VideoColorSpace](https://github.com/chromium/chromium/blob/153.0.8010.36/third_party/blink/renderer/modules/webcodecs/video_color_space.cc#L54) 没有把内部 `GAMMA22` 映射到 JS transfer 枚举，落入 unspecified。内部 BT709 与 BT709_APPLE 又都暴露为 `bt709`。因此 `transfer=null` 不证明内部没有 transfer，同一个公开 `bt709` 也不唯一确定内部数学。
5. [CopyVideoFrameToSharedImage](https://github.com/chromium/chromium/blob/153.0.8010.36/media/renderers/paint_canvas_video_renderer.cc#L1756) 对纹理帧使用源/目标 SharedImage 的 mailbox 执行 `CopySharedImage`；调用参数不另行传递 VideoFrame 的颜色字段。这使 SharedImage 的色彩元数据成为下一步需要检查的对象，不能只看 JS VideoFrame 标签。

## 运行时事实

诊断脚本新增可选 `COLOR_TRACE=1`，使用 CDP 的 `disabled-by-default-webgpu` trace，只保存 `CreateExternalTexture` 事件，不上传。重新启动两浏览器后，对用户原片 6,000 / 988,407 / 1,985,868 µs 取证。

| 资源 | Chrome 内部 transfer | Edge 内部 transfer | 本次 zero_copy |
| --- | --- | --- | --- |
| 启动 H264 中性校准片 | BT709 | BT709 | 两者 false |
| 用户 4K HEVC 原片，三帧 | BT709 | **GAMMA22** | 两者 false |

原片在两者内部均为 NV12、BT709 primaries/matrix、limited range。Edge 的 JS transfer 为 null，与源码中缺少 GAMMA22 映射吻合。

合成 HEVC 8/10-bit 的 Edge 内部 transfer 是 BT709，matrix 也是 BT709；8-bit 内部 NV12，10-bit 内部 P010LE。它们与原片不能按“所有 HEVC 一种 profile”合并解释。10-bit 的 JS format=null 并不代表浏览器内部不知道其格式。

以上直接反证了以一个 H264 中性资源探针认证整个页面所有资源的做法。同时更正之前“原生路径是零复制”的简化表述：应用没有读回，但本机 trace 表明浏览器内部选择了复制分支。

## 固定公式预测，尚非生产修复

只在显式取证下，用既有软件平面 shader 产生标准 BT.601 矩阵候选，并用源码定义的纯 gamma 2.2 解码、sRGB 编码作候选转换。没有求解参数、搜索最佳 gamma 或修改源标签；原生/参考验收对仍保持原值。

| 原片 source PTS (µs) | 原 Edge MAE | 仅 GAMMA22 候选 MAE | BT.601 + GAMMA22 候选 MAE |
| --- | ---: | ---: | ---: |
| 6,000 | 3.8238 | 1.2522 | **0.2099** |
| 988,407 | 4.2564 | 1.2528 | **0.2178** |
| 1,985,868 | 3.9333 | 1.4869 | **0.2525** |

Edge 合成 HEVC 8-bit 的内部色块差异在 BT.601 候选下从 23 降至 **0**，10-bit 从 23 降至 **2**；Chrome 同样的 BT.709 样片反而被 BT.601 候选改坏。可读 8-bit 的原始 YUV 已确认两路一致。

结论分层：

- **已确认**：Edge 原片存在 JS 无法表达的 GAMMA22 内部资源标签；校准片与原片不同；本次均走非零复制入口。
- **强数学证据支持**：Edge 被测 HEVC 的 RGB 结果表现得像用了 BT.601 矩阵；原片另叠加 GAMMA22→sRGB。
- **尚未确认**：矩阵差异具体来自哪一级 SharedImage 标签、Edge 定制代码或驱动路径。trace 的 VideoFrame matrix 仍是 BT709，不能把数学吻合写成已经捕获 BT.601 执行调用。
- **仍未解决**：候选整帧局部最大差仍为 78–95；采样、量化、边缘和其他资源边界尚未统一。因此没有将候选参数加入生产 shader，也没有把 `transfer=null` 硬编码为 GAMMA22。

已补独立最小复现，见 [Edge 本地问题草稿](edge-native-yuv-repro.md)。HEVC BT709 的原生帧与相同字节、相同公开标签的内存帧，用同一 WebGPU shader 呈现：Chrome 内部色块最大差 0，Edge 为 23；两者原生 YUV 都与独立 FFmpeg 参考完全一致。播放器代码与颜色拟合已从复现中移除。

进一步核查发现，SharedImage 的 Ganesh `CreateSkImage` 使用 representation 的颜色标签决定 YUV 矩阵，并有 BT601 默认值；CopySharedImage 后续还会 reinterpret RGB 色彩空间以禁止额外 RGB 转换。这解释了为何 VideoFrame matrix=BT709 不能证明复制链路也采用 BT709。不过本机 trace 尚未暴露 SharedImage 内部颜色标签，不能认定 Edge 一定命中默认分支。最终兼容策略仍须按可验证资源条件限定，不能按浏览器品牌或片名套用。

## 复跑与产物

```powershell
$env:COLOR_TRACE = '1'
npm run test:color:windows -- chrome msedge
npm run test:color:windows -- chrome msedge --file 'D:\Code\yorune\agent\VoidPlayer\resources\video\mhw_hevc_fullrange_bt709_3s.mp4'
```

本机 Chrome for Testing 仍需 `CHROME_EXECUTABLE_PATH`。`report.json` 增加 `externalTextureTrace` 与 `sourceHypotheses`；原验收门限不变，测试仍报告未通过。源文件快照仅放在 gitignored `artifacts/color/chromium-source/`，运行时报告另保存在 `artifacts/color/chromium-trace/`。
