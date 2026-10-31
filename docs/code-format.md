# 紧凑格式与检索

代码格式由固定版本 Prettier 和 `.prettierrc.json` 决定：2 空格、LF、单引号、分号，目标宽度 140，短对象使用 `objectWrap: collapse`。短 import、类型和调用能放下时保持一行；超过 160 字符应检查语义分组。字符串、SQL、模板和元数据允许合理超宽，格式器不改写嵌入语言。

声明紧凑，执行顺序清楚。副作用、await、状态变更、监听器注册/移除、资源获取/释放分别展示；循环、复杂分支和 try/catch/finally 使用可审查的块结构。简单 guard 可保持短式。不要用文件行数上限拆职责，也不要把完整流程压成一行。

```sh
npm run format                         # 写入已迁移文件及本地改动、新增的代码文件
npm run format:check                   # 只检查，不改文件
npm run format:check -- --base origin/main # 加上本分支已提交的改动
npm run format -- src/path/file.ts     # 显式迁移另一个文件
```

`scripts/testing/format-files.json` 是首批迁移集合，包含评分服务、代表性面板、路由、边界检查及本轮修改。日常 CI 取 PR 的 base SHA 或 main 推送前的 SHA，对该次改动的所有代码文件整文件检查，也检查首批集合。既有未触碰文件不全仓重排；以后触碰即迁移，后续再修改也不能回到旧格式。找不到比较提交时明确失败，不静默跳过。生成目录、vendor、翻译数据、JSON 样本及历史取证不属于格式集合。

`test/contract/format.test.mjs` 检查短声明、执行/释放顺序、幂等格式及提交/工作树/新增文件的门禁。必要的源码结构断言使用 TypeScript AST，不能把 `env.PATH=empty` 的空格或调用参数的换行当作契约。

默认按职责限定检索范围，避免单行大 JSON 和历史证据淹没结果：

```sh
rg -n -C 2 -g '!**/generated/**' '目标符号' src server shared
rg -n -g '*.ts' -g '*.mjs' '目标符号' test scripts
```

需要 manifest、release lock、fixture 或历史证据时再进入对应目录。兼容转发入口不以减少行数为由删除。
