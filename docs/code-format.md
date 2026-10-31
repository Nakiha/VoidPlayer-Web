# 紧凑格式与检索

声明紧凑，执行顺序清楚。基础使用 2 空格、LF、单引号和分号；普通代码目标约 140 字符，超过 160 时检查语义分组。字符串、SQL、模板和元数据允许合理例外。行宽不是强制换行算法，也不能替代对语法结构的判断。

以下短结构都允许保持一行，不能因为格式器偏好而强制展开：

```ts
import { first, second } from './module.ts';
const journal = new FrozenSubmissionJournal(sessionStorage, storage, cambiInput);
const sx = x + d.visibleRect.x, sy = y + d.visibleRect.y;
const e = clamp(signal), a = 0.17883277, b = 1 - 4 * a, c = 0.5 - a * Math.log(4 * a);
type Point = { x: number; y: number };
interface Rect { x: number; y: number; width: number; height: number; }
get terminationCallbackErrors(): readonly unknown[] { return this.cleanupCallbackErrors; }
frameAt(pts: number) { return this.source.frameAt(pts); }
if (closed) return;
if (closed) { return; }
```

多步副作用、await、状态变更、监听器注册/移除、资源获取/释放清楚分行；循环、复杂分支和 try/catch/finally 保留可审查的块结构：

```ts
const lease = acquire();
try {
  await run();
  commit();
} finally {
  await stop();
  lease.release();
}
```

修一个条件不要求迁移文件其余布局。格式迁移必须明确列出范围、说明目的，并单独审查；不得顺带全文件重排，也不按文件行数拆职责。本轮仅保留 `server/analysis/cambi/routes.ts` 的显式排版整理，让原来挤在一行的读取、取消和 finally 流程可审查。其余既有文件保留未修改部分的布局。

```sh
npm run format:check                         # 只读检查本地改动行和新文件
npm run format:check -- --base origin/main   # 也覆盖本分支已经提交的改动行
npm run format:check -- src/path/file.ts     # 显式检查选中文件的基础卫生
```

CI 取 PR 的 base SHA 或 main 推送前的 SHA，只检查新增/修改行的 LF、缩进 Tab 和尾随空白。没有已管理文件清单、整文件 Prettier 相等检查或自动写入模式；未修改的旧布局不会阻止小修复，检查也不会拒绝上述紧凑结构。暂不采用格式器强制完整布局，`printWidth` 和 `objectWrap` 不能表达这里的全部偏好。

`test/contract/format.test.mjs` 覆盖上述紧凑样例、只改旧文件一行、提交/暂存/工作树插入后的行号、新文件、显式全文件检查和只读行为。必要的源码结构断言使用 TypeScript AST，不能把 `env.PATH=empty` 的空格或调用参数换行当作契约。

默认按职责限定检索范围，避免大 JSON 和历史证据淹没结果：

```sh
rg -n -C 2 -g '!**/generated/**' '目标符号' src server shared
rg -n -g '*.ts' -g '*.mjs' '目标符号' test scripts
```

需要 manifest、release lock、fixture 或历史证据时再进入对应目录。兼容转发入口不以减少行数为由删除。
