# Node 测试目录

| 目录 | 实际实现 |
| --- | --- |
| `unit/` | 94 个纯逻辑、会话、服务、持久化与可控响应测试；其中 fast 的 24 个文件位于此处 |
| `contract/` | 9 个清单、runner、生命周期、发布依赖、分析/缩略图和像素签名契约 |
| `media/` | 24 个真实媒体、WASM、FLV、MP4、Range、GOP 与像素身份测试 |
| `helpers/` | 合成 FLV、HTTP 请求、包夹具、YUV 夹具和 Range Worker |

分域是文件职责，suite 是执行选择：`unit` suite 仍运行全部 127 个 Node 文件，包含 contract 与真实媒体；`fast` 只选择已明确不依赖重型环境的文件。

顶层 `*.test.ts` / `*.test.mjs` 为兼容入口，保留原来 npm、Node 单文件和 Bun 命令。`npm test` 只枚举这些入口，不递归再次执行实现；新 suite 也通过同一清单执行。新增用例登记实际文件和兼容入口，不能在两处维护断言。

`testing-coverage-baseline.json` 固定已有覆盖下限；`hevc-order-reference.json`、`http-smoke.mp4.base64` 与 `generate-fixtures.py` 保留原路径。详细准备、筛选、失败产物和 CI 对应关系见 [验证说明](../docs/testing.md)。
