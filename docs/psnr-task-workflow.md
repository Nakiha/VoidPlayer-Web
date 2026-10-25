# 单帧 PSNR：GUI 到持久任务和标注证据

播放器工具栏的“单帧 PSNR 任务”、共享标注卡的“测量并关联 PSNR”，以及服务管理的同名分类，打开同一独立管理页面。它调用 [持久任务 HTTP](source-psnr-jobs.md)、既有 `attach-quality-result` 命令和[原帧对查看器](annotation-psnr-pair-view.md)，不启动浏览器评分引擎，不读取或改变播放器轨道、播放游标、CSS 选区或 presenter token。GUI 和 HTTP Agent 的请求、attempt、状态、预算和不可变结果来自同一个服务；页面不限制 Agent 的来源选择或更低的执行预算。

## 使用

1. 选择服务身份；实例必须有持久数据库。临时数据库明确显示不可用，不回退到页面内临时任务。身份和 client 是可信内网中的自述归属，不是安全认证。
2. 两侧分别搜索已注册媒体，点击来源，再**明确选择**缓存 AU 和实际源 PTS。只支持已有服务端可信 producer 的完整单配置 FLV/Enhanced FLV 缓存、H264/HEVC 渐进闭合关键 AU、8/10 位 YUV420、完整颜色和色度位置标签。没有缓存时先到缓存管理显式构建；评分和候选查询都不暗中构建。
3. 在未旋转可见源像素网格填写偶数整数 `x/y/width/height`。完整帧按钮只使用两侧 SPS 的相同偶数可见尺寸，不做缩放、坐标猜测或最近 PTS 配对。两侧帧对应关系始终由调用者指定。
4. 发起持久测量。页面显示服务端排队、来源检查、执行、停止和终态，以及已评分对数与已知/未知的解码帧数，不编造百分比。历史同时显示当前 actor 的 browser、agent、other client 提交；选择条目可查看完整输入、attempt、错误、ROI、分数、SSE 和 provenance。
5. 已完成结果可显式选择评审空间、已有标注和来源侧进行共享。服务仍核验 job 所属、attempt/digest、标注版本/源 PTS/ROI。不会自动创建标注。挂接会向标注读者共享两侧来源与不可变事实；原 job 的私有提交元数据不会随附件公开。成功后链接复用既有只读原帧对/ROI 查看器。

测量与查看的支持范围不同。测量可接受符合执行契约的源平面 crop/SAR；候选页单独说明查看几何是否受支持。原帧查看仍要求精确显式方形 SPS SAR、无 SPS crop、无旋转等既有条件；测量完成或关联成功都不会放宽查看门槛。颜色、真实 AU 和实际原始帧在执行时才验证，容器 key flag 不是可测承诺。

## 提交、观察与作用域

页面为每个 tab 保存 client ID。开始提交前先把 actor/client、幂等键和完整请求写入 sessionStorage，再 POST。双击共享在途提交；断网或丢响应后，显式重试使用冻结的同一键和请求，即使重载页面也不自动 POST。无法保存重试状态时不发请求。“结束此提交的重试”只是允许准备新的请求，不能证明旧请求没有创建任务，也不会取消旧任务。

服务端在受理、取消或读取私有任务事实前，校验可选 captured-actor header 与该请求 cookie。跨窗口通知即使迟到，冲突也以 `409 actor-changed` 在副作用之前拒绝；header 不会覆盖 cookie 的身份。切换用户或应用另一个 client ID 会撤销旧观察作用域；来源、detail、结果和标注列表的迟到响应不能填入新作用域。跨窗口身份通知到达时先撤销发布，再向服务确认身份。评审空间、来源侧、标注和 job 的挂接命令也捕获作用域及操作 ID；丢响应重试保留原命令，修订冲突须显式刷新目标。导入/复制附件继续只保留历史事实，不能继承服务核验。

关闭页面、切换管理分类或断开观察只停止 HTTP 读取，不取消已受理任务。取消按钮调用持久取消命令；完成/取消竞争只看服务端终态。Worker 物理退出前不把执行容量视为可用。网络错误独立显示，不把运行中的任务改成 failed。服务重启的 interrupted、幂等回执和结果保留沿用持久任务契约。

## 共用候选查询

`GET /api/media/{id}/psnr-frames?v={version}&afterAu=0&limit=50` 需要已有服务身份，仅读取已有可信缓存。返回：

- `source.binding` 和 producer evidence，包括媒体 ID/version、索引 namespace/build；身份展开在 GUI 的来源见证中。
- 精确 SPS 可见/编码尺寸、SAR 及 `inspection.supported/reason`。
- 带完整 `PairTarget` 的 `entries`，保留绝对 AU 与原始源 PTS；不自动选择或跨源配对。
- `nextAu` 和本页检查包数。后续页必须带最初 `source.binding.indexBuildId` 为 `buildId`；缓存变化拒绝，不能把不同构建的页合并。

每次最多返回 50 个候选、检查 2048 个位置、64 KiB 输出；完整可信缓存仍受 250000 包/32 MiB 输入、Node 的 256 MiB Worker 堆配置和原 30 秒执行预算约束。响应的 `eligibility` 明确是容器候选，执行仍核验字节、AU、颜色和实际帧。重复 PTS、非 key、错误配置不成为候选；空页但有 nextAu 时可显式继续。查询与一次性来源检查复用同一独立 Worker、源版本/最终检查、物理退出和实例准入；繁忙可明确失败。这不是进程 RSS 或 Bun 的堆保证。它不解码、不评分、不扫描建索引，也不构成内容哈希认证：文件身份仍是原有 stat/version 见证。

## 验证边界

真实浏览器额外延迟跨窗口身份通知，仅改变真实共享 cookie：同一请求/键依次得到 `409 → 202（丢响应）→ 409 → 200 replay`；只有原 actor 一个任务和一次真实执行，另一个 actor 无任务，随后才交付延迟通知。HTTP 测试覆盖匹配、不匹配、取消和正常 cookie-only Agent 调用。已有标注命令原有 captured-actor 围栏也保留并回归。

定向单元测试验证候选身份/分页、重复 PTS、提交持久化先于 POST、双击与丢响应原键重放、观察错误/迟到回复和作用域围栏。媒体 HTTP 测试验证真实 8/10 位缓存候选端点及执行。

`check-quality-workflow-browser.mjs` 的 Chromium/WebKit × H2648/HEVC10 矩阵登记在完整 `ci-cache`，要求真实 core，不能放入无 core 的 identity 套件。由 UI 点击首次提交，独立 HTTP Agent 核对同一 job/attempt/结果和原平面 SSE；测试既有标注显式挂接、丢响应命令重放、原帧对/ROI、播放 A 同时测 B/C 隔离。取消/关窗用测试专用 Worker 阶段闸门暂停**真实服务任务**，没有替换 DB、解码或计分逻辑；取消终态必须在实际线程退出后才能出现。模拟迟到 HTTP 回复只用于观察作用域测试，不冒充真实计算验收。

可显式选择 [SSIM 伴随度量](source-plane-ssim.md)，结果和附件共用后台事实。仍不支持普通依赖帧、序列、自动配对/标注、VMAF、热图、自动重试或分布式任务。#112/#114/#115/#121 的更广验收仍未全部完成，性能既有负结果也未因此改变。

Optional bounded source-pixel block measurement and immutable spatial evidence: [PSNR block evidence](psnr-spatial-evidence.md). Scalar requests and existing source/geometry admission remain unchanged.

Optional SSIM companion semantics, coverage, limits and shared evidence: [SSIM](source-plane-ssim.md).
