# 单实例评分资源管理

管理页概览中的「评分资源」与 HTTP `GET/PUT /api/admin/quality-resources`
使用同一 `QualityAdmission`。原 `analysisConcurrency` 仍只管理码流分析。

默认总并发 1，可设 1–8；PSNR/SSIM、VMAF、XPSNR、CAMBI 分别可设 1–4。
准备、规划、检查各固定 1 路。实际执行须同时满足总并发、算法、内存预留、
累计读取预留和内部线程上限。默认内存预留 2 GiB、读取预留 8 GiB、线程 4。
提高并发不会提高其他预算。单项预留超过总量返回 `413 quality-resource-limit`；
暂时占满返回 `503 quality-busy`，持久任务保持 queued，不产生虚假 attempt。
降限只约束后续准入；取消/截止/关闭等待真实 Worker 和 IO 退出才释放预留。

预算是保守预留，不是进程 RSS、OS CPU 限额或实时带宽整形。评分 Worker
单线程交替解码/评分，预留 1 线程、1280 MiB（JS heap、解码/分析 WASM、
像素、索引及结果）和 2 GiB 累计读取；单帧/规划/检查预留 640 MiB、64 MiB
读取，质量索引准备预留 192 MiB 读取。probe 为 256 MiB、4 MiB 读取。
执行器原有更紧的输入、WASM、时间和 IO 预算仍有效。不是全部最大值可同时取满。
索引构建/上传和码流分析维持明确的独占配额，与评分双向排斥，避免独立上限叠加。
播放器和只读媒体库查询不占后台计算许可。

跨评分、准备、规划存储的未完成计算默认总量 32，每 actor 8。
先查原幂等回执再检查总量，队列满仍可重放原请求。各领域更紧的队列、
actor 和存储限制保留。range 是有界父协调器，只在创建子任务时计入计算队列，
不重复持有执行许可。

PUT 正文 `{revision,limits}`，严格结构见 `shared/service/quality-resources.ts`。
沿用实际部署的可信内网管理规则，同源 `X-VoidPlayer-Action: admin` 必需；
提供的捕获 actor 必须与当前身份相同。使用现有 revision/原子替换，外部修改
或旧版本返回冲突。配置文件持久保留最近 32 次操作者、requestId、时间、前后
限制和原 revision，重启读取相同限制，不伪装恢复活跃 Worker。

回归覆盖聚合准入/预算、持久队列和原回执、实际 VMAF 双 Worker 降限/取消、
配置 HTTP 归属/来源/revision/重载，以及双浏览器管理页保存和响应式布局。
排队/执行时间来自持久时间戳，实际 heap 来自算法结果；准入快照不冒充 CPU/RSS 实测。
