# 普通 HTTP Agent 冷启动评分

入口仍是 `/llms.txt` → `/api/agent`。新增 `/api/agent/tasks`、`/api/agent/tasks/{id}`、`/api/agent/operations/{id}`，分别为版本 1 的有界任务目录、任务摘要、逐操作契约。JSON/Markdown 全部嵌入服务，独立程序无 `dist` 也能 GET/HEAD；不会创建用户、准备媒体、规划或评分。旧 `/agent/quality.md` 保留为短选择首页，长文在 `/agent/quality/reference.md`。

standalone 缺网页时可提供 HTTP API/指南，manifest 的 frontend 能力关闭；评分仍需固定 decoder 资源。显式 `--init`/`--check` 继续校验完整网页部署；Node 生产网页入口的缺构建报错不变。

逐操作描述 method/path、请求约束与共享 domain limits、执行宿主、副作用、cookie/actor/Origin/action、幂等方式、游标、错误恢复、结果及下一步链接。Markdown 操作页由同一注册表生成；真实路由/validator 仍负责准入，文档不增加第二套 validator。发现字典已修正严格 MP4 的支持；MP4 native VMAF 是固定组件和连续整帧计划的条件能力；CAMBI 另行校验严格单源 MP4 与五尺度 v2 证据，不从 VMAF 或元数据成功继承准入。

元数据 stream ID、质量 cache stream/configuration、AU/sample ordinal、raw ticks/timebase 和呈现序号严格区分。probe 成功不表示评分就绪；不按名称/时长/相近 PTS 认证内容或填洞。缺缓存返回 `cache-miss` 和显式 preparation 下一步，读取不隐式建索引。错误附加恢复和操作链接，既有 HTTP 状态/code 不变。

## 可运行示例

`examples/http-quality.mjs` 仅依赖 Node 内置模块和普通 HTTP，不导入应用库、不使用浏览器、不保存 cookie。先运行：

```sh
node examples/http-quality.mjs http://127.0.0.1:9000
node examples/http-quality.mjs http://127.0.0.1:9000 input.json
```

默认只读发现。填写 `examples/http-quality.input.example.json` 的真实媒体 ID/version、已有 identity ID、声明/分段时钟、区间/ROI/预算和候选策略。全零 ID 是待替换占位符，不能直接评分。不要把凭据写入输入；内网身份是归属声明，不是认证。

每类写操作分别授权：

```sh
node examples/http-quality.mjs http://127.0.0.1:9000 input.json \
  --allow-identity --allow-prepare --allow-plan
```

以上到 C 计划为止。加 `--allow-compute` 才评分，加 `--allow-candidate` 才按完整 policy 发布。mode 可选 single/range/vmaf：single 要求一个精确 pair；range 使用 C execute 固定跨数据库回执；vmaf 要求显式 model/cadenceUs/metrics/native budget 和已安装组件，且 ROI 为整帧，无 grid/stride/holes。组件不可用停止，不自动换指标。配置文件必须按所选模式显式改写，示例不会推断几何、帧率或政策。

观察、请求、响应字节和分页均有界；客户端不是服务队列。停止观察不取消 durable job，只有显式 cancel 请求物理退出。

## 不确定响应

保留原始输入和稳定 `key`。`--allow-retry-unknown` 只允许一次未知响应的原字节 body/原 key 重放，之前再次检查原 actor。C execute 重放原 digest，候选重放原 policy/operationId。明确验证错误不重试，身份创建不自动重试；绝不能换 key 逃避未知结果。

未授权自动重放或一次重放仍未知时，示例输出 `unknown-post-outcome` 及原 operation/path/actor/key/body，不含 cookie。用这些冻结事实和原身份解析回执；不要在 cache/source 已变时重建不同请求去碰原 key。无回执的身份创建须人工解析用户列表，不自动重建身份。

POST 发送后，空/结构缺失的 2xx、截断/非 JSON、读体失败（包括原 4MiB 响应上限）都不能视为提交失败，必须保留冻结请求。错误附加响应阶段/状态；已知 4xx 拒绝（即使错误体损坏）不自动重放。跨 actor 拒绝仍保留原请求，但绝不转交新 actor。成功回执只检查后续追溯必需的 envelope，不另造领域输入 validator。

身份成功还须收到唯一 `voidplayer-user` cookie，解码后的非空值与返回 actor 一致；正常 Path/Expires/HttpOnly/SameSite/Secure 属性不混入后续 Cookie 请求。错名、空值、错 actor 或重复歧义都保留为未知身份结果，不保存或打印 cookie，也不盲目重建账号。

已确认取消/失败/interrupted 后的新尝试须明确授权。actor 变化停止；source/cache 变化要求显式重选和修订计划。discovery cursor 失效只同查询重取第一页一次，不触发变更；事件 resetRequired 读取 snapshotUrl，不重放 mutation。

输出包含结果、共享候选及事件事实，原帧复核使用既有独立 viewer。GUI 不参与提交确认或移动其他播放轨。关系不认证内容，候选不是人工缺陷；reference integrity 未认证、concealment unavailable、负 PTS/VFR E2E 与独立 stat witness 的证据边界不扩大，性能负结果保留。

## 定向验收

```sh
node --test test/unit/agent-http.test.ts
node scripts/native/run-vmaf-tests.mjs node --test test/media/agent-quality-workflow.test.ts
```

后者从冷缓存和 llms.txt 开始，用真实 FLV single、MP4→FLV range、FLV→MP4 native VMAF 完成闭环。native 仅 Linux x64，沿用固定组件核验；包含无组件、缺缓存、unknown、source/actor 变化、真实提交后丢响应、cursor 失效及观察停止。逐帧/池化 VMAF 对照现有官方 oracle。其他 codec、compiled 三平台和 GUI/viewer 继续由现有正式回归覆盖，不声称此例认证全部矩阵。

CAMBI 的独立无参考工作流从 `/api/agent/tasks/quality.cambi`、
`/agent/quality/cambi.md` 开始：只需一份明确的可信 FLV 或严格 MP4 绑定与有界区间/抽样（MP4 avc1 H2648 / hvc1 HEVC8/10，精确恒定时钟，v2 sample/table/producer 见证），
不要求参考关系或 C 计划，不继承 VMAF/XPSNR 的 MP4 准入。任务中心的
`kind=cambi` / `metric=cambi` 使用原存储的单源身份、阶段、覆盖与结果可用性，
显式取消仍委托原服务。逐帧五尺度热图、固定 recipe、区域统计和候选回执
由 CAMBI 原端点按需读取；组件缺失保持 CAMBI unavailable，不静默替代指标。

CAMBI 的显式重算沿用相同操作发现、费用确认和唯一后继回执，仅针对已有完整冻结单源见证并物理停止的 failed/interrupted/cancelled 任务，不新增 partial。缺旧见证、源/cache/producer/core、实际 AU 选择排序、固定组件/recipe 漂移必须新建意图；不准备索引、不创建参考关系、不自动发布候选。GUI 指标页与任务中心同源追溯，原 actor/body/key 回执先于来源和结果查询；普通 HTTP 示例的 `mode:cambi` 支持既有任务的只读预览与显式 `--allow-reexecute`，新 CAMBI 提交仍按其独立单源指南操作。
