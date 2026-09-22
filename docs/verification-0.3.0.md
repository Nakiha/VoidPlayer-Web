# v0.3.0 开发分支验证记录

日期：2026-09-22。基线：`a12e513977404de0d18ee0350666f5e8444788da`（v0.2.3）。本记录是开发验证，不代表正式发布验收通过。

## 环境与素材

- Linux 容器，Node 24.19.0、Bun 1.4.2、无头 Chromium 153.0.8010.0；未验证硬件解码，混合播放使用 CPU YUV 呈现。
- WASM 来自已有便携包，其 provenance 与 `scripts/release-core.json` 的固定修订一致。
- 本机没有完整上游 QA 素材。本轮浏览器用例使用生成的 640×360 素材，即使兼容脚本所需的文件名含 1080p/4K，也不代表实际测过该分辨率。FLV open-GOP、分辨率变化用例另行生成自己的素材。

## 已执行

| 检查 | 结果与范围 |
| --- | --- |
| `npm run build` | 通过 TypeScript 和 Vite 构建 |
| 下列定向 Node 测试 | 129 项，128 通过，1 项因 root 权限跳过，0 失败 |
| `flv-open-gop`、`flv-resolution`、Worker、资源预算组合 | 11 项通过，包含真实固定版本 WASM |
| Chromium `check-browser.mjs` | 八轨 UI、取消/停滞载入、目录与主题等现有场景通过 |
| Chromium `check-recovery-browser.mjs` | 检查点事务完成后刷新、显式恢复、比较条件、缺失轨道保留标注/偏移、稍后关联通过 |
| Chromium 缩略图与工作区浏览器脚本 | 通过 |
| Linux Bun 便携包打包与 `check-release.mjs` | 通过；空 PATH、异目录运行，实际索引 POST/GET 验证内嵌 Worker |

定向测试入口：

```sh
node --test test/session.test.ts test/playback.test.ts test/resource-budget.test.ts \
  test/workspace-file.test.ts test/workspace-storage.test.ts \
  test/frame-index-cache.test.ts test/frame-index-worker.test.ts \
  test/thumbnails-contract.test.ts test/thumbnail-offer.test.ts \
  test/thumbnail-session.test.ts test/library-index.test.ts \
  test/saved-workspaces.test.ts test/release-pipeline.test.mjs
```

关键回归包含：清理 epoch/媒体版本变化拒绝旧任务、单任务准入、跨轨预算与帧关闭、压力取消可选任务、可见 URL 引用、旧缩略图缓存迁移与淘汰不影响工作区、比较条件失败回滚、全部片源不可用仍保留现场位置与时长。

## 本轮索引争用实验

运行 `node scripts/bench-index-contention.mjs`，独立客户端/服务端进程，500,000 包、约 18 MiB 合法索引。单次局部结果：

| 指标 | 本轮结果 |
| --- | ---: |
| 无上传 Range p95 / 最大延迟 | 7.12 / 31.75 ms |
| 上传期间 Range p95 / 最大延迟 | 6.24 / 31.85 ms |
| 服务端事件循环最大延迟 | 17.17 ms |
| 上传用时 | 1691.79 ms |
| 服务端峰值 RSS（含 Worker） | 546.35 MiB |

这些是本轮重测结果，不能直接和 v0.2.1 文档的另一环境做百分比比较，也不能换算成播放器卡顿时长。Worker 隔离降低主事件循环上的重工作，但没有消除解析对象的内存开销；本实现以单个大任务准入限制并发放大。管理/扫描的 SQLite 同步元数据操作仍可能遇到锁竞争，尚未承诺所有管理操作都无阻塞。

## 播放对照与尚未通过的验收

同容器、相同生成素材、相同 Chromium、browser 色彩模式，以应用 `benchmark_review` 实际绘制为准，每场景两次、每次请求 2 秒：

| 场景 | v0.2.3 基线速度 | 开发分支速度 | 门槛结果 |
| --- | --- | --- | --- |
| 单轨 H.264 | 0.9965、0.9967 | 0.9966、0.9967 | 两侧均通过 |
| MPEG-2 WASM + H.264 | 0.2939、0.3012 | 0.3094、0.3113 | 两侧均失败 |

混合场景的 A 轨绘制间隔 p95：基线 213.16/197.43 ms，开发分支 212.93/199.31 ms；呈现诊断显示 CPU YUV 路径。此对照确认该环境在基线也未达标，不构成 GPU 环境、八轨 4K 或性能提升的验收。

`npm test` 全量未通过：缺少完整 QA/FATE 素材；此外 `file-drop.test.ts` 的异步回调断言失败、`protocol-server.test.ts` 的 `networkInterfaces` 受容器限制。后两项在未修改的 v0.2.3 worktree 中复现了相同失败，不能把定向通过写成全量通过。

WebKit 所需系统依赖在本环境不可用。Windows/macOS 原生便携包、WebKit、完整真实素材和 GPU/八轨高分辨率压力测试仍待对应环境验证。CI 已接入恢复浏览器用例及 Worker/资源/存储测试；CI 配置存在不等于这些门槛已通过。

## 产品与资源边界

- 256 MiB 是会话已知帧、解码预留、读回与派生任务的协调目标。必需评审帧可形成可观测超额；解码器内部、WASM 堆及全部 GPU 内存不在精确计量范围。
- 缩略图本地缓存为 32 MiB/512 条 LRU，闲置 Object URL 为 8 MiB/128 条；可见消费者持有的图片直到离屏/移除才释放，不为满足闲置预算破坏当前显示。
- 自动检查点与标注草稿不属于可再生缓存清理范围。检查点为本机周期性尽力保存，服务器保持显式保存；浏览器清理站点数据或最后一次写入未完成仍可能丢失现场。
- 工作区记录比较条件与 SDR 呈现契约，不保证不同浏览器/软硬解路径逐像素相同，也不宣称 HDR 参考显示。

## 追加：reference 默认硬件优先与 FLV 原生路径

未保存解码偏好时改为 hardware/depth=2；已有 software 选择及工作区比较条件继续生效。删除 reference 对 FLV 的强制 WASM 例外，本地文件嗅探与远程 FLV 都接入共同的 Worker 原始平面读回、软件同 PTS 首帧核对及按失败阶段回退。特殊包索引 MP4 也保持原生帧到该准入阶段；读回包装保留码流分析接口。

本轮构建和 100 项定向测试通过（native-yuv-source、decoder-policy、session、playback、resource-budget、workspace-file、workspace-storage、flv-open-gop、flv-resolution）。Chromium 的新增 `node scripts/check-reference-flv-browser.mjs chromium` 使用自动生成的 128×96 SDR 素材，验证结果：

- AV1 非标 FLV 本地改名文件与远程文件实际选用 WebCodecs，输出为读回的 I420 YUV，并通过真实 WASM 首帧逐样本核对。
- AV1 注入能力拒绝、读回拒绝、首帧样本不同三种情形，均回退到真实 WASM，日志区分失败原因。
- HEVC 非标 FLV 的本地/远程入口均实际发起原生能力探测。本容器 Chromium 对该配置的 prefer-hardware/no-preference 都返回 unsupported，验证的是正确回退，**尚未验证此环境中的 HEVC 原生成功路径**。
- H.264 实际尝试原生，但浏览器给出的 coded=128×98 与软件的 128×96 不一致，仍按原有严格核对规则回退；没有为了选择原生而放宽几何或颜色检查。核对日志现在区分 PTS、平面格式、编码尺寸、裁剪、色彩条件和样本不一致。
- 已保存的软件偏好保持 WASM，并且不发起原生探测。
- 实际应用 AV1 WebCodecs → YUV 播放基准通过：请求 1.2 秒，速度约 0.996、绘制间隔 p95 50.71 ms，暂停后无陈旧帧。此为小尺寸合成素材，不代表高分辨率实时性或物理硬件使用证明。

恢复/工作区浏览器回归继续通过。新增测试接入 Chromium/WebKit CI；本地 WebKit、Windows/macOS HEVC 硬件与 WebGPU 呈现仍待对应环境验证。
