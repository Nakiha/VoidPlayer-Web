# 普通 HTTP Agent 冷启动评分

入口仍是 `/llms.txt` → `/api/agent`。新增 `/api/agent/tasks`、`/api/agent/tasks/{id}`、`/api/agent/operations/{id}`，分别为版本 1 的有界任务目录、任务摘要、逐操作契约。JSON/Markdown 全部嵌入服务，独立程序无 `dist` 也能 GET/HEAD；不会创建用户、准备媒体、规划或评分。旧 `/agent/quality.md` 保留为短选择首页，长文在 `/agent/quality/reference.md`。

逐操作描述 method/path、请求约束与共享 domain limits、执行宿主、副作用、cookie/actor/Origin/action、幂等方式、游标、错误恢复、结果及下一步链接。Markdown 操作页由同一注册表生成；真实路由/validator 仍负责准入，文档不增加第二套 validator。发现字典已修正严格 MP4 的支持；MP4 native VMAF 是固定组件和连续整帧计划的条件能力，不表示 CAMBI 就绪。

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

已确认取消/失败/interrupted 后的新尝试须明确授权。actor 变化停止；source/cache 变化要求显式重选和修订计划。discovery cursor 失效只同查询重取第一页一次，不触发变更；事件 resetRequired 读取 snapshotUrl，不重放 mutation。

输出包含结果、共享候选及事件事实，原帧复核使用既有独立 viewer。GUI 不参与提交确认或移动其他播放轨。关系不认证内容，候选不是人工缺陷；reference integrity 未认证、concealment unavailable、负 PTS/VFR E2E 与独立 stat witness 的证据边界不扩大，性能负结果保留。

## 定向验收

```sh
node --test test/unit/agent-http.test.ts
node scripts/native/run-vmaf-tests.mjs node --test test/media/agent-quality-workflow.test.ts
```

后者从冷缓存和 llms.txt 开始，用真实 FLV single、MP4→FLV range、FLV→MP4 native VMAF 完成闭环。native 仅 Linux x64，沿用固定组件核验；包含无组件、缺缓存、unknown、source/actor 变化、真实提交后丢响应、cursor 失效及观察停止。逐帧/池化 VMAF 对照现有官方 oracle。其他 codec、compiled 三平台和 GUI/viewer 继续由现有正式回归覆盖，不声称此例认证全部矩阵。
