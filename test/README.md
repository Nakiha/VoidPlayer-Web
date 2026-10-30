# Node 测试目录

| 目录 | 实际实现 |
| --- | --- |
| `unit/` | 纯逻辑、会话、服务、持久化与可控响应测试 |
| `contract/` | 清单、runner、生命周期、发布依赖、分析/缩略图和像素签名契约 |
| `media/` | 真实媒体、WASM、FLV、MP4、Range、GOP 与像素身份测试 |
| `helpers/` | 合成 FLV、HTTP 请求、包夹具、YUV 夹具和 Range Worker |

分域是文件职责，suite 是执行选择：`unit` suite 运行清单中的全部 Node 用例，包含 contract 与真实媒体；`fast` 只选择已明确不依赖重型环境的文件。目录文件数不是 suite 选择数；用 `npm test -- --list`、`npm run test:suite -- contract --list`、`npm run test:suite -- media --list` 查询当前清单与实际适用范围，不维护手工总数。

顶层 `*.test.ts` / `*.test.mjs` 保留 Node 单文件和 Bun 命令的兼容入口。`npm test` 委托统一 runner 的 `unit` suite，按清单直接执行唯一实现，不再枚举顶层 glob；`npm test -- --list` 查看当前适用用例。其他 suite 使用同一清单，不能同时执行兼容入口与实际文件。新增用例登记实际文件；确需保留旧路径时再登记兼容入口，不能在两处维护断言。

`testing-coverage-baseline.json` 固定已有覆盖下限；`hevc-order-reference.json`、`http-smoke.mp4.base64` 与 `generate-fixtures.py` 保留原路径。详细准备、筛选、失败产物和 CI 对应关系见 [验证说明](../docs/testing.md)。

Retired top-level forwarding paths are recorded in `docs/evidence/retired-test-entrypoints.json`; current forwarding files remain only where still referenced. `npm test` selects the complete canonical unit catalog and does not depend on a top-level glob. Npm compatibility plans are inspectable with `node scripts/run-tests.mjs --list --alias test:<name>`.
