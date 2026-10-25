# 媒体库单帧 PSNR 一次性 HTTP 闭环

这是 #112 / #114 的受限纵向切片：注册媒体 → 显式服务端索引构建 → 缓存身份发现 → 独立 Node/Bun Worker 原始解码 → PSNR 与完整 provenance。评分不依赖 Session、已加载轨道、播放游标或 GUI 确认。`quality.frame-pair` 是逐源判断的一次性调用；独立的持久单帧 PSNR 入口见 [任务 v1](source-psnr-jobs.md)，`compute.workers` 仍为 unavailable，#114 / #121 没有整体完成。

本文的一次性接口不创建持久 job/attempt/result 或任务 ID，也不提供队列、恢复、结果缓存、自动重试、断线续作、帧序列、自动对齐、评分 GUI、SSIM/VMAF、分布式或性能达标承诺。连接断开取消本次调用；独立 durable job 的观察断线不取消，两种契约分开。

## 调用

使用现有内网身份 cookie；它用于归属，不是认证。POST 必须有匹配 scheme/host 的 `Origin`、`Content-Type: application/json` 和 `X-VoidPlayer-Action: quality`。沿用现有媒体库根目录，不接受调用者的文件路径、Blob、缓存 JSON、core 地址或执行代码。

1. 从 `/api/library` 选择明确的 `id / version`。
2. 显式 `GET /api/media/ID/frame-index?v=VERSION&build=1` 构建完整 FLV 缓存。读取响应的 `index.packets[au][2]` 作为实际源 PTS，单位为整数微秒。评分自身从不调用索引构建器。
3. `GET /api/media/ID/psnr-source?v=VERSION` 返回 `{ binding, producer }`。需要身份 cookie；不传未知 query 参数，不修改缓存的 LRU/构建状态。两侧分别发现，不能互换绑定。
4. `POST /api/quality/psnr-pair`，JSON 形状如下（每个 placeholder 来自对应侧，不猜测）：

```json
{
  "pairing": "caller-specified",
  "reference": {
    "mediaId": "<24 hex>", "mediaVersion": "<24 hex>", "size": 1234,
    "indexIdentity": { "kind": "flv", "streamKey": "video:0", "schemaVersion": 3, "indexerBuild": "flv-demux-v3" },
    "indexBuildId": "<opaque token from binding>",
    "picture": { "sourceVersion": "<id>@<version>", "stream": "video", "configuration": 0, "au": 0, "picture": 0, "layer": 0, "field": "frame" },
    "sourcePtsUs": 2000000
  },
  "distorted": {
    "mediaId": "<other 24 hex>", "mediaVersion": "<other 24 hex>", "size": 2345,
    "indexIdentity": { "kind": "flv", "streamKey": "video:0", "schemaVersion": 3, "indexerBuild": "flv-demux-v3" },
    "indexBuildId": "<other opaque token from binding>",
    "picture": { "sourceVersion": "<other id>@<other version>", "stream": "video", "configuration": 0, "au": 1, "picture": 0, "layer": 0, "field": "frame" },
    "sourcePtsUs": 3000000
  },
  "roi": { "x": 2, "y": 4, "width": 24, "height": 20 },
  "budget": { "maxElapsedMs": 30000 }
}
```

示例中的占位值须由各侧发现响应替换。ROI 是未旋转的可见亮度网格；YUV420 要求偶数边界。请求最多 16 KiB，未知字段拒绝。源格式、严格 8/10 位 YUV420、色彩/色度位置和闭合关键 AU 限制沿用 [内部执行桥](source-frame-pair-psnr.md) 与 [PSNR 数值契约](source-plane-psnr.md)。重复 PTS、开放 GOP/CRA、依赖 VCL、多配置、恢复缺口、场/多层等明确拒绝。跨源对应完全由调用者指定，既不按同 PTS 自动配对，也不声称证明内容对应。

成功响应为 `voidplayer-library-frame-pair-psnr` v1：`request` 给出 HTTP request ID 与归属 actor ID（不代表认证）；`result` 是原始桥的分量/aggregate SSE、MSE、可 JSON 表示的 PSNR、ROI、码值域、算法和 decoder build/frame ABI；`sources.reference/distorted` 返回完整缓存绑定与 producer evidence；`execution` 标明 Node/Bun 实际 runtime 版本、服务端 Worker 与 `stat-version-v1` 来源身份。没有原始像素、服务器路径或原始堆栈。无分数的错误不会伪装为零分。

错误包括：400 格式/身份参数错误，401 缺身份，403 Origin/action 错误，409 cache-miss/untrusted-cache/source-changed/identity-mismatch，413 budget-exceeded，422 unsupported-source，503 quality-busy 或 decoder-unavailable；PSNR 色彩/布局错误保留原始 code。按 code 判断具体前提，不把所有 409 当成可自动重建的指令。

## 可信缓存与文件身份

FLV 缓存允许客户端上传，所以“JSON 校验通过”和“有 commit/hash”不等于服务端解析过该源。只有 `frame-index-build-worker` 完成无恢复/截断的全文件扫描，并核对源文件身份后，才能在同一 SQLite 提交写入独立的 `producer_json`。该可空列以现有逐列检测方式迁移，不改变普通 FLV stream-manifest 的 `metadata=null` 语义。HTTP 的 `put` 路径无法传入这份内部参数，上传 JSON 内的仿冒字段不能 mint evidence；已有缓存的 first-winner 路径不会给客户端缓存补盖印章。

Producer evidence 绑定 `server-flv-scan-v1`、媒体版本/大小、完整 namespace、epoch、实际 packet-storage commitId、完整索引文档 SHA256，以及构建时的 `size/dev/ino/mtimeNs/ctimeNs` 字符串见证。绑定 token 是这些字段的摘要，不把分片 FLV 中为 NULL 的 manifest.build_id 编造成有效 ID。评分在单个 SQLite 读事务读取证据、存储 manifest 和可选完整索引；先检查缓存字节/包预算，再重组、校验分片和文档 digest。

旧缓存缺证据时返回 untrusted-cache。调用者需通过原有缓存管理显式清理并单独构建；对已存在的客户端缓存执行 `build=1` 的 no-op 不会把它变可信。清理/重新提交的 epoch/commit 改变会使旧绑定失效。普通播放仍可使用原先支持的恢复/截断缓存，评分不会改动其准入规则。

主媒体 version 仍是现有 stat 派生身份，不是全文件内容哈希或任意不可信输入的认证。来源发现、前置/最终检查与原始解码均在同一个受拥有的 Worker 中；主线程不再 await library.resolve、独立数据库 RPC 或 fs.stat。Worker 从注册根目录与数据库权威行解析来源，整条链路统一使用严格 realpathSync canonicalization，不混用异步/同步路径字符串，也不通过 lowercase、删路径或删 stat 校验接受别名。每次 positional read 在一个无 await 的同步段内开/验/读/验/关描述符；读取前后、解码后和返回前检查媒体行、根目录/存储类型、realpath、当前路径 stat、描述符 fstat、精确 stat 见证和缓存绑定。高精度见证补充现有四舍五入毫秒版本的粒度；仍不能称为密码学内容认证。源替换、改写、根目录调整、短读、版本或缓存绑定变化都拒绝旧结果。最终检查保证检查时的绑定，不能保证响应发出后文件永不改变。

## Worker、准入与预算

生产服务用真正 `node:worker_threads` Worker；Bun 独立包编译其单独入口并从包内固定 core 资产目录装载。无浏览器 fetch shim、Canvas、GUI 或外部 ffmpeg 子进程。`shared/wasm/frame.ts`、`shared/media/ffmpeg-color.ts` 和 `shared/analysis/quality/wasm-decoder.ts` 与浏览器共用帧 ABI、色彩映射和原始平面执行体，宿主不互相 import。core 路径由服务实例配置注入，独立程序不依赖启动 cwd；缺资产直接拒绝。

来源发现 GET 和评分 POST 都使用同一实例质量许可、一个真实 Worker 和完整 deadline；来源发现也可能返回 busy。一般媒体/缓存只读接口仍沿用原有读取准入。同一媒体库实例的质量许可一次只接受一个请求，无新队列。它与服务端索引构建/上传、待提交/排队/运行的码流分析保守互斥；开始质量工作前检查全部 blocker，持有期间拒绝新的上述重工作。只读缓存查询仍可用。索引构建在错误、成功和取消后的真实 Worker 退出前保留占用，避免旧异步 terminate 与新质量 Worker 重叠。此策略覆盖这些应用入口，不是 OS 全局 CPU/RSS 限额，也不把其它独立元数据 IO 进程说成受同一许可控制。

执行限制沿用桥的硬上限且只能降低：两侧源读取合计 16 MiB、每 AU 8 MiB、每侧索引最多 250,000 包/32 MiB 存储与文档预算、每输出帧 32 MiB、coded 像素 4096×2304、单 core 256 MiB 线性内存、两包/两输出帧、执行 30 秒。源读取按实际精确 slice 长度计费，没有隐藏块预取。Node Worker 还设置 V8 old-generation 资源限制；Bun 忽略 Node 的 resourceLimits 与 trackUnmanagedFds 选项，不能把它们当作 Bun 的硬资源保证。跨宿主保证是显式输入/输出/线性内存预算，不声称是整个进程 RSS 上限。

HTTP body 另有 10 秒上限；执行 deadline 从 body 校验和准入后开始，覆盖 Worker 启动、全部来源/路径/数据库前提检查、解码及最终检查，不再存在主线程 60 秒 RPC 或无 deadline stat 的缺口。来源发现 GET 的 deadline 同为 30 秒。到期后不再返回成功，取消先通过共享原子标记禁止新媒体 IO；主线程等正在执行的同步描述符范围关完，再实际 terminate，物理退出后才释放质量容量。Bun 强制终止不自动关闭未托管 fd，因此不能跨 await 保留原始媒体描述符，也不能跳过这道 IO 排空围栏。同步 WASM/PSNR 不能靠取消消息抢占，因此直接终止 Worker。原始 AbortSignal.reason（含 null/false/0/空字符串）保持失败语义。挂起的异步检查、迟到恢复与迟到消息均不能再启动后续 IO 或输出分数。deadline 是停止执行/拒绝成功的时点，不承诺 OS 阻塞 IO 和线程物理退出一定在该时点前完成；如内核 IO 不返回，close 会继续等待安全排空/物理退出，许可仍占用，不用“响应及时”掩盖残留操作。若终止失败，许可保持占用、close 明确失败，不猜测线程已死或自动重用；需要处理进程故障，而不是盲重试请求。

## 验收

- `test/unit/library-pair-runner.test.ts`：四种假值取消、所有 Worker 终态、终止失败的保守占用、来源查询 deadline/close、迟到成功、源 IO 原子排空/未知退出、索引物理退出围栏和 bitstream/index 的共享准入。
- `test/media/library-pair-http.test.ts`：真实注册媒体、显式服务端缓存、HTTP 来源发现/执行、Node/Bun Worker、AVC 8 位/HEVC 8/10 位的原生 FFmpeg 平面精确 SSE；实际重复/变化参数集、缺色彩、重复 PTS/错误 AU/namespace、ROI/预算、伪造 producer/客户端缓存、缺缓存不重建、执行中源变化/清缓存、Origin/身份、断线/超时与实际不合作 Worker 退出前容量保持；来源 GET 与评分 POST 在 source/resolve/decode/final 阶段实际挂起，覆盖取消、deadline、close、强制退出和迟到恢复，Linux 下还验证媒体/数据库描述符数不泄漏。
- Node 媒体验收现场编码与原生解码参考。Bun 和独立包使用提交的四份微型真实编码/原生平面 fixture（`test/helpers/quality-http-samples.json`，含生成版本、方法与双 SHA256），无需外部 ffmpeg；生成方法为 `test/helpers/library-pair-fixture.ts:encodedPair`。这不是 mock 解码路径。
- `scripts/check-quality-release.mjs`：三平台 CI 的真实解压包、空 PATH、不同 cwd、编译 Bun Worker，独立循环逐分量累加参考平面 SSE 与完整 provenance 对照。
- `scripts/testing/browser/media/library-pair.mjs chromium|webkit`：GUI 另开一份源，实际 HTTP 评分 8/10 位源，验证轨道、游标、布局和视图不变。只证明隔离，没有评分面板或 GUI 流程交付。

共享帧读取的迁移还运行现有解码回归和播放 bench。原性能不足与旧 WebKit 错误的未知根因不因本切片通过而消失。

Bun Node 兼容性边界的上游说明：[node:worker_threads](https://github.com/oven-sh/bun/blob/main/docs/runtime/nodejs-compat.mdx#nodeworker_threads)。原始 fd 问题还在本仓库 Bun 1.4.2 的实际强制取消回归中复现；该回归保留完整描述符断言。

Optional bounded source-pixel block measurement and immutable spatial evidence: [PSNR block evidence](psnr-spatial-evidence.md). Scalar requests and existing source/geometry admission remain unchanged.
