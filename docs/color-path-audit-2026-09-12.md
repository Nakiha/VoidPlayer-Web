# 上屏路径审计（2026-09-12，macOS）

## 实际结构

用户模式是色彩转换的归属，不是 CPU/GPU 二选一。

| 用户模式 / 解码偏好 | 解码输出与呈现 | 验证边界 |
| --- | --- | --- |
| reference / software | WASM 原始 YUV → 自有 SDR 转换；WebGPU 优先，WebGL / CPU 降级 | 软件解码不等于软件上屏。拒绝不支持的 HDR / RGBA 资源，不偷偷改走浏览器颜色。 |
| reference / hardware | WebCodecs 原始平面读回 → 同一自有转换 | 优先请求硬件，不证明实际硬件使用。当前原生准入为 NV12/I420、8 位 SDR；软件首帧同 PTS 全平面核对，失败回退 WASM。FLV 在此模式始终软件解码。 |
| browser / native | WebCodecs sample → 浏览器外部纹理 / 原生绘制 | 色彩转换交给浏览器；无 WebGPU 也应保留此归属。 |
| browser / WASM fallback | 原始软件 YUV → 自有 shader 近似浏览器输出 | 中性探针选择有限的 Apple/CV/普通 SDR 候选，不是通用浏览器模拟器。不保证跨编码、位深、资源、设备逐像素相等；探针不可用保留普通 SDR。 |

reference 的“正确”指 `color-pipeline.md` 约定的 SDR 转换，不是完整的显示器校准、HDR 输出或所有色彩空间认证。首帧硬件核对也不是逐帧软件重解码认证；后续有资源格式/色彩标签变化保护。

模式切换由 `session.setColorMode` / `setReferenceDecode` 统一重载轨道，保留时间、轨道身份、偏移和标注；失败恢复旧模式和资源并暂停。

## 本轮发现及处理

1. 本机消费了旧 WASM ABI v1/72 字节，而前端要求 v2/160 字节。真实软件解码测试原先全部报版本不兼容。已从 `VoidPlayer.worktrees/unified-color-core` 的干净工作目录（修订 `1ba3ef8`，匹配 `scripts/release-core.json`）同步单线程及多线程产物；没有修改解码器源码或放宽 ABI 检查。默认 sibling 的 `wasm` 分支仍是旧产物，后续同步必须使用锁定版本产物。
2. `prepareYuvFrame` 原先只根据 GPU 状态保留 native sample，无 WebGPU 时 browser 用户模式会被转成自有 YUV。已改为先遵守用户色彩归属，覆盖切换模式准备首帧时旧 GPU 尚未更新的情况，并补资源所有权回归。
3. 开发服务的 Vite 模块 304 响应遗漏隔离头，WebKit 重用 Worker 依赖时触发 COEP 拦截。已在早期中间件设置隔离响应头，覆盖 200/304；统一同源资源声明。实际硬件优先载入由 Worker 异常恢复为可正常校验及回退。补 Vite 缓存响应与服务响应头检查。

## 本轮验证

- 色彩/资源/原生核对/真实 WASM：18 项通过。真实 core 与独立 FFmpeg 原始解码对照，包含单线程、多线程、seek/reset、10 位与奇数尺寸 16 位平面。
- Session：61 项通过，包含模式重载、时间/标注/偏移保留与失败回滚。
- 开发路由与 TLS 响应：4 项通过，包含缓存 304 隔离头。
- Chromium、WebKit 呈现回归通过：各 57 个 YUV 参考用例，以及原生/RGBA、PQ/HLG 既有呈现、旋转、缓冲回收和 Canvas 降级。
- Chromium、WebKit WebGPU 回归通过：资源归属、clone 生命周期、同步截图、四方向旋转、暂停缩放、10 个高位深/布局用例及 RGBA 降级恢复。
- WebKit 无界面短测（每项 2 秒）：H.264 browser 原生、reference 软件、browser 强制 WASM 均通过实时播放阈值。reference 硬件优先的 H.264/HEVC 也通过，但实际均为 WASM 回退，不能据此认证硬件路径成功。
- Chromium 无界面硬件优先 H.264 实际回退 WASM，约 0.37 倍实时，未通过性能阈值。短测不是长期性能或跨平台验收。
- Chromium 有窗口复核：相同 H.264 在 reference / hardware 下实际走 WebCodecs，通过软件首帧核对后使用原始平面上屏；约 0.99 倍实时，通过播放阈值。这验证了原生读回路径在当前样片与环境可用，不证明浏览器底层一定使用物理硬件解码器。
- 构建与差异格式检查通过。

未在本轮完成 Windows Chrome/Edge 真机验证、所有编码组合的硬件准入或浏览器拟合逐像素认证。既有 Windows 色彩证据中的未通过项仍有效。

## 对设置页的约束

一级选择应表达“自有 SDR 色彩转换 / 浏览器色彩转换”；解码偏好放在前者之下。实际状态必须独立显示软件、原生及回退结果，不能把“硬件优先”显示成“正在硬件解码”。浏览器模式可减少原生帧读回，但不是始终更快的承诺；其软件回退只能标为近似匹配。当前“性能”名称不足以表达这个页面的主要职责。
