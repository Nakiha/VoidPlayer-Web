# Windows 色彩验证

本页是可重复执行的呈现验证入口。当前转换、硬件准入与回退规则以 [色彩链路契约](color-pipeline.md) 为准；历史失败及环境见该文档的 [历史负面证据](color-pipeline.md#历史负面证据的边界)，不能把旧阶段结论当作当前状态。

## 运行

需要 Node 24+、`npm ci`、含 libx264/libx265 的 ffmpeg 和 ffprobe，以及 Windows 上的 Chrome/Edge。默认有窗口运行；脚本记录实际浏览器版本、OS 与 WebGPU adapter 字段，不自动查询驱动版本或系统 HDR 开关。驱动版本和用户手动确认的 HDR 状态需另行记录，并标明来源。

```powershell
npm run test:webgpu:browser -- chrome msedge
npm run test:color:windows
npm run test:color:windows -- chrome msedge --file 'D:\media\sample.mp4'
```

可只传 `msedge`。使用官方 Chrome for Testing 时设置 `CHROME_EXECUTABLE_PATH` 指向其 chrome.exe；报告中的路径覆盖不能当作安装版 Chrome 验收。显式统一平面对照使用 `--pipeline unified`，呈现回归对应 `npm run test:webgpu:browser -- chrome msedge --unified`。

本地报告位于 `artifacts/color/presentation-chrome-msedge.json`、`artifacts/color/windows/report.json`、`artifacts/color/windows-file/report.json`；统一模式对应 `windows-unified/`、`windows-file-unified/`。合成视频、原片参考平面和详细像素统计只存本地，不自动上传。原片模式限 4:2:0 8/10-bit SDR、前三秒可取三帧、选中帧的布局/色彩标签不变；不支持时明确失败。

需要同时检查真实 WASM 解码时，在相同命令后加 `--wasm`，并先准备锁定 core。该模式先将真实 WASM 帧字节与独立 FFmpeg 参考逐字节核对，再呈现；报告目录增加 `-wasm` 后缀。它仍不代替独立发布包或完整编解码矩阵验收。

## 判读边界

- 原生侧必须实际产出 WebCodecs 资源；软件参考是 FFmpeg CLI 解码同一压缩文件的原精度 YUV，进入生产 presenter。默认不计作实际 WASM core、ABI 或独立发布包验收；后者须另跑 [真实媒体与发布检查](testing.md)。
- 比较前核对实际 source PTS、尺寸、资源色彩与平面布局。硬件偏好、非软件 WebGPU 适配器都不能单独证明物理硬件视频解码器执行。
- 合成输入覆盖 H264 BT.709 limited/full、BT.601、BT.2020 SDR，以及 HEVC BT.709 8/10-bit。默认色块内部每通道门限为 2 个 8-bit 码值，边缘留 8 像素；完整帧误差仍须保留。统一模式检查完整帧，不能把内部色块通过说成整帧一致。
- 原片对照不排除边缘。可读原生平面与独立参考相同，只能排除被测帧的 YUV 码值差异，不能证明浏览器 RGB 转换正确；format=null 时不得宣称拿到原始高位深平面。
- 不根据文件名或公开标签覆盖已转换资源，不按浏览器品牌拟合补偿。平均差小不能掩盖局部最大差；应用内截图不包含 OS/ICC/物理显示输出。
- `COLOR_TRACE=1` 可记录 `CreateExternalTexture` 事件；trace 的 VideoFrame 标签并不暴露完整 SharedImage 色彩状态。独立、仅含合成素材的复现见 [Edge 原生 YUV 复现](edge-native-yuv-repro.md)。
- 未通过的门限保持失败；模式切换、短片吞吐、功能门禁与色彩一致性分别报告。长时间双轨、真实目标设备、显示器 HDR 输出均须单独验收。

## 原始平面读回拆测

Windows 上可运行以下有窗口的 Chrome/Edge 诊断；使用同一原片和版本比较，报告留在本地。流水线对照还需要锁定的真实 WASM core 及 PowerShell 进程采样。

```powershell
node scripts/bench-native-readback.mjs 'D:\media\sample.mp4'
node scripts/bench-yuv-pipeline.mjs 'D:\media\sample.mp4'
```

串行拆测报告为 `artifacts/color/native-readback.json`，比较主线程/Worker 和 ArrayBuffer/SharedArrayBuffer；首帧哈希相等不认证所有帧。流水线报告为 `artifacts/color/yuv-pipeline/report.json`，比较 WASM、主线程与 Worker 的 1/2/4/8 深度，检查完整 PTS 顺序、每帧抽样 YUV 和队列上限。

串行耗时不含取得下一解码帧；流水线是无播放时钟限速的单轨吞吐，画布为 960×540，两者不能当作实际 UI 双轨 fps。CPU 时间是被枚举进程各核时间之和，工作集求和可能重复计算共享页且不含独立显存；均不等于整机占用率或精确内存节省。这些实验不补全所有色度元数据，也不认证最终 RGB 或动态高位深边界；不得直接据此开启生产路径。实际会话另跑播放基准，并验证 seek、取消与释放。
