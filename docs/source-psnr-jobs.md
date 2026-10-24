# 单帧 PSNR 持久任务 v1

这是 #121 的最小纵向切片，复用 [媒体库单帧执行器](source-library-psnr.md)，没有扩大像素、编解码器或来源范围。候选阶段仍保持 `quality.jobs` unavailable；只有真实 Linux/macOS/Windows 编译包验收完成后才更新发现能力。不要把本文的候选接口理解为 main 已开放的能力。

仅支持一个显式 reference/distorted 帧对、PSNR、偶数对齐 ROI、已有可信 FLV 缓存。H264/HEVC、渐进闭合关键 AU、明确色彩/色度位置、8/10 位 YUV420 和所有来源/预算限制保持不变。来源版本和缓存 token 由调用者明确指定；不自动配对、探测、建索引、重试、共享计算或恢复续算。不包含 SSIM/VMAF/CAMBI、帧序列、分布式、调高并发或后台评分 GUI；#114/#121 仍未整体完成。

## HTTP

使用现有内网身份 cookie，所有写操作要求同源 Origin、`Content-Type: application/json`、`X-VoidPlayer-Action: quality-job`。身份和 client 均是自述归属，不是认证或权限凭据；按 actor 过滤只用于归属分组，不是安全隔离。服务仍应置于部署已有的访问边界内。GET 不创建用户或任务。

先按一次性执行器文档注册来源、显式构建服务端可信缓存、发现两侧绑定并选定 AU/实际源 PTS。然后提交：

```http
POST /api/quality/jobs
Idempotency-Key: review-pair-001
X-VoidPlayer-Action: quality-job
Content-Type: application/json
```

```json
{
  "schema": "voidplayer-psnr-frame-job",
  "version": 1,
  "client": { "id": "review-agent", "kind": "agent" },
  "request": {
    "pairing": "caller-specified",
    "reference": "<完整 reference PairTarget 对象>",
    "distorted": "<完整 distorted PairTarget 对象>",
    "roi": { "x": 2, "y": 4, "width": 24, "height": 20 }
  }
}
```

上面两个 placeholder 必须替换为 [一次性调用示例](source-library-psnr.md#调用) 中的完整对象，不能发送字符串。`client.id` 为 1–80 个 ASCII 字母/数字/`._:-`，kind 为 agent/browser/other；未知字段拒绝。可选 request.budget 沿用原始桥且只能降低上限。

- 首次提交返回 202、`{job,replayed:false}` 和 Location。返回成功意味着提交事务已落盘，不意味着评分完成。接收完整请求后，即使提交者没收到响应，任务也由服务持有。
- 幂等键为 1–128 个 ASCII 字母/数字/`._:-`，按 actor ID + client ID + key 绑定。v1 固定字段顺序和默认预算形成请求摘要；同键同请求返回 200 原 job，不替换原提交者、请求 ID、时间或 attempt。顺序不同或显式写出同一默认预算仍是同一请求。同键不同请求返回 409 idempotency-conflict，不执行新计算。
- `GET /api/quality/jobs/{jobId}` 读取自己的任务详情；`GET .../{jobId}/result` 读取不可变版本化结果。未完成/失败/取消/中断返回 409 result-unavailable，不伪造分数。
- `GET /api/quality/jobs?after=0&limit=50` 返回归属当前 actor 的最新记录快照、全局单调 cursor/head 和 more。处理整页并保存 cursor，more=true 时继续；按 job ID/revision 去重。记录后续更新可能再次出现；没有事件历史或订阅租约。cursor 领先数据库返回 409 cursor-ahead，重新从零同步。列表不含完整 input/result；详情与结果使用各自 URL。列表同时提供实例资源状态和固定限制。
- `POST /api/quality/jobs/{jobId}/cancel`，JSON `{}`，显式请求取消自己的任务。重复取消或取消已结束任务返回当前记录，不改写终态。该请求的 ID/actor/时间独立保存。

观察没有控制权：关闭页面、放弃轮询、断开 GET 或提交响应连接都不取消任务。一次性 `/api/quality/psnr-pair` 继续保留断线取消的原契约，二者不混用。没有 retry 入口；需要重新计算时，调用者明确使用新键创建新 job，不能把失败回执当成“再次执行”的指令。

## 状态与原子性

`queued → preparing → running → completed/failed`。preparing 在共享实例准入成功后、创建 Worker 前提交唯一 attempt；没有计算许可就只有 queued，不制造空 attempt 或“重试次数”。真实 Worker 报告 source/resolve/decode/publish 阶段。已评分帧对只在完成事务后为 1/1，未获完整输出时 decodedFrames 为 null；不把未知量表示成零或百分比。

显式取消 queued 可立即提交 cancelled，无 attempt。运行任务先提交 cancelling/stopping，禁止迟到阶段推进，然后撤销新 IO、排空同步文件读取范围并终止 Worker。只有物理退出完成才提交 cancelled 和释放容量。结果与 attempt/job 终态在同一事务写入；取消先提交则迟到结果丢弃，完成先提交则后到取消只返回 completed。不同/旧 attempt ID 不能覆盖当前记录。

每个 job 只有一个计算 work、至多一个 attempt。没有跨提交共享，也没有把命中旧幂等回执记录成新计算。完成结果保存实际算法/decoder build/frame ABI、runtime、像素域、ROI、精确 SSE/MSE/PSNR、源/缓存/producer provenance，及原提交者/client/request ID。观察请求的新 HTTP request ID 不覆盖历史归属。归档结果说明测量时的来源；之后源变化不重写历史，也不意味着新版本可复用旧分数。stat 身份仍不等于内容认证。

Worker 退出不确定时保持 cancelling，记录 worker-stop-uncertain、拒绝新任务，原共享容量与数据库所有权继续保留；close 失败而非假装清理完成。原始错误值为 null/false/0/空串也必须保持失败。恢复这类进程故障依赖进程退出；不尝试后台偷偷重启 Worker。

## 持久化、重启与预算

任务库为媒体索引旁的 `<indexDatabase>.quality.sqlite`，独立于可清理的帧索引缓存。复用现有独立 SQLite EXCLUSIVE 事务锁：持锁后才初始化/恢复历史，另一进程不能恢复活跃实例的状态。生产服务在监听前打开任务库；锁由正常关闭或 OS 进程退出释放，不使用 PID 猜测或过期心跳偷取。未来 schema 明确拒绝，不清空或降级数据库。

正常关闭停止接收提交，等待当前 Worker 的真实退出，将未结束任务记为 interrupted 后关闭数据库/锁。崩溃重启在持锁事务中将所有 queued/preparing/running/cancelling 记录及未结束 attempt 标为 interrupted，保留原 ID、输入、来源版本与取消请求。即使原来只是 queued，也不自动续作。已提交的完成结果/失败/取消不变。相同幂等键仍返回历史状态，新键才创建新执行。

固定一个执行槽、最多四个 queued、每个 actor 最多两个未结束任务；与一次性质量、索引构建/上传和码流工作共用既有实例准入。无许可时保留有界 queued，空闲时没有任务库轮询。队列等待最多 5 分钟，进程内以单调时钟锚定的毫秒时间计算，过期 failed/queue-expired，未启动的记录没有 attempt。执行 deadline 沿用最高 30 秒，在提交 attempt 后覆盖 Worker 启动、源/文件/数据库前提、解码、PSNR 和最终验证；排队与持久提交分别计时。请求体另有 10 秒与 16 KiB 上限。

取消/超时后安全排空与线程物理退出仍可能被 OS 阻塞 IO 延迟，容量保持占用；不承诺 deadline 时刻前一定返回。Node V8 限制不代表 Bun 的资源保证，显式输入/输出/线性内存预算也不等于进程 RSS 限额。API 返回 activeAttempts/queued 等领域计数，不把整个进程 RSS 伪称为某个任务的内存峰值。

结果 JSON 最高 128 KiB，历史最多 1000 行、总逻辑预留 64 MiB；每次提交预留请求字节和最大结果空间。额度满返回 429 quality-history-full，不删除旧回执/结果腾位。没有自动保留期或垃圾回收入口；物理 SQLite/WAL/文件系统占用不等于逻辑预留额度。队列满和 actor 上限分别返回 quality-queue-full / quality-actor-limit。幂等旧回执查询优先于新提交额度检查。

## 验收

- Node/Bun 存储/执行器单测：规范化幂等、冲突与过载、事务终态竞争、迟到 attempt、未来 schema、历史预算、游标、准入与关闭围栏。
- 真实 HTTP：现场编码/原生参考或固定哈希素材的 H264 8、HEVC 8/10 位逐平面 SSE/provenance、归属、重启结果和源变化。
- 独立进程 HTTP：完整提交响应未读取即断线、观察者断开、真实源阶段挂起、显式取消与 Worker 实际 exit 顺序、队列/actor 上限、第二实例、SIGKILL 后 interrupted、回执重放不重算；terminate 拒绝 null 时真实 Worker 仍存活且容量不释放。测试屏障只存在测试入口，不来自生产 HTTP/配置/环境。
- 现有三平台 required `release-quality`：真实编译 Bun 程序、空 PATH、不同 cwd、三种像素路径、持久 job 结果、幂等与重启历史、第二编译实例拒绝。
- Chromium/WebKit：在另一 GUI 源保持轨道/游标/布局/视图时实际完成一次性与持久评分；不代表评分面板已经交付。

性能不足与旧 WebKit 故障的未知根因不因本切片通过而消失。
