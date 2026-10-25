# 独立 ROI 测量与共享候选

播放器片源面板的“独立 ROI 测量”只借用已载入的同服务、锁定版本媒体引用。普通播放 `PresentedFrameToken` 的旧 AU 关联和缺失缓存 namespace/build 不足以证明质量身份，因此不预填所谓当前帧、不按相同 PTS 配对，也不隐式切换解码器、暂停、定位或完成索引。用户必须分别明确选择两侧缓存 AU；独立一次性 Worker 从可信缓存验证原始帧，严格检查源版本、namespace/build、producer document SHA、闭合解码窗口、opaque 输出身份、实际 PTS、色彩和精确 SPS 几何，再通过唯一 presenter 上屏。只显示新快照的身份，不宣称它就是旧播放画面。

支持已存在可信完整、单配置、未恢复的 FLV/Enhanced FLV，H.264/HEVC 8/10 位 YUV420，闭合 IDR 起点，每侧至多32AU；普通依赖、闭合 GOP 重排与 drain 共用已有规则。没有精确身份、未知色彩、非方形/未知 SAR、裁剪、旋转、版本或缓存变化明确拒绝。未认证引用图完整性，concealment 检测不可用，不意味着缺引用都拒绝。暂无容器扩展、序列、VMAF 或分布式。

ROI 为两侧相同的未旋转可见源网格。独立矩形拖选端点吸附最近偶数源像素，同时显示数值；CSS 缩放、原播放器平移/分割、DPR 不进入评分坐标。数值输入必须是网格内偶数整数。不从矢量笔迹推导 ROI。可伴随固定 FFmpeg 均匀8×8/步长4 SSIM 与至多64块 PSNR；仍由已有持久执行器计算，不用截图分数。快照核验独立30秒、32MiB/帧、64MiB保留快照与原桥读包/输出/WASM预算；取消/换媒体/换身份终止 Worker，实际退出后才复用准入。后台任务另按原服务准入预算运行。

提交复用 `QualityJobObserver`，发送前持久保存 actor/client/幂等键/完整正文。双击共享同一次请求；网络错误只表示观察失败，重试原正文。关闭视图仅停止观察；显式“取消任务”请求服务终止，服务仍等待 Worker 实际退出才释放容量。媒体代际或身份通知撤销对话框，迟到回复不得串写；服务 header/cookie actor 不匹配先409，前端围栏不能代替后端。

完成结果新增可选 `annotationContext`，来源是同一个已核验的完整 FLV 索引，记录 codec、文件名、mtime、首显示 PTS、索引派生时长及目标帧时长。时长为索引推导（末帧遵循既有估算规则），不是完整容器元数据认证；stat 身份不是内容认证。历史结果不回填/改写；缺此见证的新建命令409拒绝，可保留旧显式 put+attach 流程。

## GUI 与无 GUI Agent 共用原子命令

向 `/api/annotations/spaces/SPACE` 提交 `create-quality-candidate`，包含 revision0、新 id、稳定 operationId、client、`candidate:{text,severity}` 与 `evidence:{jobId,attemptId,digest,side}`。由自有可信完成结果派生媒体/源版本、实际与归一化 PTS、比较帧、ROI 和不可变证据；禁止 caller document/伪造分数。结果、来源变化后不偷偷重新测量。

候选的 `qualityCandidate.assessment=not-subjectively-assessed` 记录创建时的测量事实，不能暗示人工缺陷判断或置信度；它是不可变的创建来源标记，不代替后续文字、回复或 resolved 状态。文字/严重度必须由调用者填写，永不根据分数自动推导。标注、附件、回执、事件同一事务；触发事件失败全部回滚。回执在私有结果读取之前，结果回收/服务重启后相同 actor/operationId/body 仍返回原提交；换 actor 或正文冲突不可复用。显式共享发布测量事实，不披露私有提交/client/幂等键，不扩大非 owner 读取 job 的权限。

普通文本、回复、区域编辑保留候选与附件；锚点不能移动。导入/复制保留历史事实但 verification 降为 historical。候选工作区/评审必须 v3，普通附件保持 v2，无附件 v1；v1 附件与 v2 候选明确拒绝，不静默丢字段。活动深链接保留原身份和 v3 包装；原帧查看器仍重新核验来源/缓存/解码器/几何，历史附件不能冒充服务确认。

标注数据库提升为 v4；v3 数据保留迁移，旧服务必须拒绝新库，防止候选事实被旧实现静默丢弃。

## 可复现验收

- `node --test test/media/quality-annotation-http.test.ts`（Bun 使用 `bun test`）：真实 H2648/HEVC8/HEVC10、所属 actor/版本/ROI、并发重放、事务故障回滚、回复/区域编辑、导入降权、重启及实际结果回收。
- `node scripts/check-quality-roi-browser.mjs chromium 8`；另有 chromium10、webkit8、webkit10：真实 UI 选择 AU/核验/拖选/PSNR+SSIM/grid/原子候选/双窗口/原帧查看，与固定 native 原始像素及独立 SSE/SSIM 对照。Chromium8 还覆盖 A 播放时测 B/C、真实 Worker 取消/退出/容量和关闭只解除观察、缓存失效及无隐式 build。
- 四组登记完整 `ci-cache`（必须准备 core），不进入无 core 的 identity 套件。`check-quality-release.mjs` 对三平台实际编译包九类原始/前向/GOP/零 CTS 素材执行同一原子候选命令并重启重放；本地只覆盖本机平台，其他平台以精确候选 CI 为准。
- source/contract、shared/host 边界、构建及原 UI 回归保持必需；不因新入口移除旧断言、放宽限时或改性能门槛。
