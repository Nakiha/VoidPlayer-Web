# Windows 色彩验证：2026-09-10

Windows 验证已补，但**当前色彩一致性验收未通过**。H264 中性探针通过不代表 HEVC、BT.2020 SDR 或彩色边缘均能对齐。此次只增加测试入口与证据，没有修改生产转换算法、启用条件或误差门限。

后续已实现显式统一平面实验：原片整帧色差为 0，但 4K 双轨性能未通过，见 [设计审查与实验结果](color-pipeline-design-review.md)。本页表格继续记录原自动 profile 的基线。

## 环境与方法

- Windows x64，系统 build 26200；NVIDIA RTX 5080，驱动 32.0.16.1664。WebGPU 返回 `nvidia / blackwell`，`isFallbackAdapter=false`。
- Chrome for Testing **153.0.8010.36**，Edge 安装版 **152.0.4191.66**；均有窗口，未强制软件 GPU。两者版本不同，差异不能仅归因于浏览器品牌。
- 正常 URL，生产 `initializeGpuPresentation` 自动选择 `planes`；未指定 Apple/CV 实验 profile。
- Node 24.13.0，FFmpeg CLI 7.1.1；起始提交 `768ca4101b337947498d4a4e97645e4013d130f7`。完整本地报告保存 sourceDigest、浏览器版本、资源标签和参考平面 SHA-256。
- 原生侧通过 `openMedia`，必须产出 WebCodecs 原生资源；软件侧是 **FFmpeg CLI 解码同一压缩文件所得原精度 YUV**，交给生产 `paintFrame` 的 YUV 入口。两侧通过 `captureFrame` 读取源尺寸 sRGB RGB；执行器必须为 `webgpu-external` / `webgpu-yuv`。
- 比较前断言实际 source PTS 和尺寸一致；另按需复制可读原生 NV12/I420，逐样本比较 YUV。资源复制仅在诊断中执行。

本机缺少 ABI v2 WASM core，因此这证明的是原生与软件平面的**呈现对比**，不能计作真实 WASM 解码、core ABI 或独立发布包验收。WebCodecs 请求 `prefer-hardware`，并不等于独立证明硬件视频解码器实际执行；非软件 WebGPU 适配器仅证明 GPU 呈现端。也不包含 OS/显示器扫描输出。

## 合成彩色回归

测试自行生成 192×144、4:2:0 对齐的 12 色块视频，含中性端点、中间亮度及彩色块。H264/HEVC 各使用真实编码和独立解码参考；每例比较 0s、1s、回到 0s 三次。共每浏览器 6 例、18 对帧。

固定门限为色块内部每通道最多 **2** 个 8-bit 码值。块边缘各留 8 像素用于隔离色度重建差异，同时完整记录整帧误差；内部通过不代表整帧一致。

| 样片 | Chrome 内部最大差 | Edge 内部最大差 |
| --- | ---: | ---: |
| H264 BT.709 limited | 0 | 0 |
| H264 BT.709 full | 0 | 0 |
| H264 BT.601 | 0 | 0 |
| H264 BT.2020 SDR | **83** | **83** |
| HEVC BT.709 8-bit | 0 | **23** |
| HEVC BT.709 10-bit | 2 | **23** |

可读 8-bit 资源的 YUV 码值均与软件参考完全相同。10-bit 原生资源 `format=null`，没有伪称完成原生平面读取。BT.2020 样片的原生资源报告 `primaries=bt709`，码流/FFmpeg 参考为 BT.2020；它是需要继续核查的资源约定差异，不能直接覆盖标签。

即使色块内部通过，整帧最大差仍可达 76–91；BT.2020 达 115。边缘差异仍需独立检查，当前门限只验收色块内部，不掩盖整帧数字。两浏览器的整套测试均以非零状态退出。

## 用户原片

`mhw_hevc_fullrange_bt709_3s.mp4`，3840×2160 HEVC。文件名含 fullrange，但 FFmpeg 解码帧为 **limited range、BT.709 matrix/transfer/primaries**；容器流摘要缺少 matrix，测试使用解码帧标签。没有按文件名推断或修改片源。

三次实际 source PTS 为 6,000、988,407、1,985,868 µs。原生与独立软件参考每对各 **12,441,600 个 YUV 样本完全一致**，Chrome、Edge 均如此。

| source PTS (µs) | Chrome RGB MAE | Chrome 最大差 | Edge RGB MAE | Edge 最大差 |
| --- | ---: | ---: | ---: | ---: |
| 6,000 | 0.1783 | 77 | 3.8238 | 79 |
| 988,407 | 0.1919 | 94 | 4.2564 | 93 |
| 1,985,868 | 0.2206 | 80 | 3.9333 | 78 |

原片对比使用整帧，不排除边缘。原生 external texture 与同资源 Canvas 2D 的最大差：Chrome 0、Edge 1。Edge 原生资源 `transfer=null`，Chrome 为 `bt709`。这些证据将问题收敛到资源转换/呈现，而非这三帧的解码码值差异；尚未证明具体驱动/浏览器转换函数的根因。Chrome 的小平均误差也不能消除其局部大差异。

## HDR 关闭对照

用户确认关闭 Windows HDR 后，重新启动同版本 Chrome/Edge 进程，复跑全部合成样片和用户原片。HDR 状态来自用户操作确认，脚本没有独立查询系统显示设置。

36 对合成帧和 6 对原片帧的 RGB 全帧/内部误差统计、原生 external 对 Canvas 统计、可读 YUV 差异统计及资源色彩标签，与关闭前全部一致；浏览器版本与参考平面 SHA-256 也一致。这里比较的是完整统计对象，没有保存两轮完整 RGBA 来声称逐像素相同。

因此，在本机这次对照中，关闭 HDR **没有改变或消除应用内部读回的色偏**。无需据此添加 HDR 开关补偿；继续定位浏览器原生资源转换和两路色度重建规则。该实验不评价显示器端的亮度/观感变化，也不排除其他设备的显示状态影响。

关闭前报告保留在 `artifacts/color/hdr-on-baseline/`，关闭后报告保留在 `artifacts/color/hdr-off/`；逐对比较记录为 `artifacts/color/hdr-comparison.json`。两个目录的 HDR 标签按用户提供的状态命名。

## 复跑

需要 Node 24+、`npm ci`、含 libx264/libx265 的 ffmpeg 和 ffprobe，以及本机 Chrome/Edge。

```powershell
npm run test:webgpu:browser -- chrome msedge
npm run test:color:windows
npm run test:color:windows -- chrome msedge --file 'D:\Code\yorune\agent\VoidPlayer\resources\video\mhw_hevc_fullrange_bt709_3s.mp4'
```

也可只传 `msedge`。本次 Chrome 安装版不可用，使用下载到 gitignored artifacts 的官方 Chrome for Testing，通过以下变量选择；报告会标出路径覆盖，不能当作安装版 Chrome 验收：

```powershell
$env:CHROME_EXECUTABLE_PATH = (Resolve-Path artifacts/browsers/chrome-win64/chrome.exe).Path
```

本地报告：`artifacts/color/presentation-chrome-msedge.json`、`artifacts/color/windows/report.json`、`artifacts/color/windows-file/report.json`。合成视频、原片参考平面和详细像素统计仅存本地，不提交、不上传。原片模式限 4:2:0 8/10-bit SDR、前三秒可取三帧、选中帧的布局/色彩标签不变；不支持时明确失败。

已通过：Chrome/Edge 自动 profile、clone 生命周期、按需截图、四旋转、暂停缩放、10 个高位深/对齐/布局用例、RGBA 回退及重新进入、释放；10 项色彩/平面/证据单元测试；`npm run build`。

仍未通过：上述彩色和原片误差门限。仍未覆盖：真实 WASM core/发布包、长时间双轨稳定性、GPU 丢失、系统 Safari、其他 Windows GPU/驱动、显示器/HDR 输出。合入前应处理或明确限制 Windows 的启用范围；本记录不能作为 Windows 全面放行。
