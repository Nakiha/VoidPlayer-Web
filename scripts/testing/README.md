# 测试基础设施与领域用例

执行方式、准备条件和 CI 对应关系见 [验证说明](../../docs/testing.md)。

| 位置 | 职责 |
| --- | --- |
| `manifest.json` / `manifest.mjs` | 稳定 case ID、覆盖矩阵、前置条件、命令与清单校验；不是第二份断言实现 |
| `build.mjs` | 一次构建及显式准备凭据校验 |
| `browser-fixture.mjs` / `lifecycle.mjs` | case 独占临时数据、服务、浏览器、context，统一失败现场与逆序清理 |
| `http-origin.mjs` | 保留不安全 origin 的普通 HTTP 测试转发；不拦截 HTTPS |
| `browser/ui/` | 设置、菜单、主题、快捷键、反馈和标注卡片等 UI 断言 |
| `browser/annotations/` / `browser/media/` / `browser/workspace/` | 标注像素与交互、元数据/逐帧/时间轴、工作区往返断言 |
| `../../test/{unit,contract,media}/` / `../../test/helpers/` | Node 逻辑、基础设施契约、真实媒体、可复用夹具与 Worker |
| `../run-tests.mjs` / `../run-browser-regressions.mjs` | 选择清单与独立子进程执行、超时/取消、完整性明确的结果报告 |

顶层旧 `check-*-browser.mjs` 与 `test/*.test.*` 入口保留参数与默认引擎，只导入所属领域的实现。清单通过 `implementation` 关联入口与实际文件，两处都纳入契约检查；新增领域用例必须登记，不能用更换文件名逃过登记。

公共 fixture 的 `ready` 等待播放器 API 可用，`phase` 为有界操作记录阶段，`artifact` 将产物放进该 case 的目录。额外 context 使用 `newContext`，服务扩展在监听和 ready 前用 `defer` 登记部分资源；这些资源在断言失败、超时和取消后仍属于当前 case。Range、可信 HTTPS、重启与专用媒体环境保留专用扩展，逐批迁移后跑实际引擎回归。

127 个 Node 实现已按职责分域，旧入口保留兼容且不单独维护断言。工具分类见 [脚本职责索引](../README.md)，覆盖下限与保留专用场景见 [验证说明](../../docs/testing.md)。
