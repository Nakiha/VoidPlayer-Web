# 测试组织迁移验收（issue #37）

逐格对照以 [覆盖下限](../test/testing-coverage-baseline.json) 和 [当前清单](../scripts/testing/manifest.json) 为准。下限固定迁移前 219 个已有执行项的稳定 ID、命令、引擎、平台、输入、required 和 CI 归属；[清单契约](../test/contract/test-manifest.test.mjs) 对每项逐字段比较。新增基础设施测试和工具登记可以追加，不能用替换下限文件掩盖覆盖减少。

下表统计原有执行项在各轴上的登记次数；内部多引擎/多输入循环保留整项执行，不把计数误作测试断言总数。

| 覆盖轴 | 迁移前 | 迁移后（原有项） |
| --- | --- | --- |
| 稳定执行项 | 219 | 219 |
| Node / Bun | 129 / 8 | 129 / 8 |
| Chromium / WebKit | 44 / 42 | 44 / 42 |
| Linux / macOS / Windows | 218 / 214 / 218 | 218 / 214 / 218 |
| 源码 / 合成素材 / 本地固定素材 | 100 / 9 / 23 | 100 / 9 / 23 |
| UI / 媒体库 | 14 / 46 | 14 / 46 |
| 本地 / 远程 / 脚本内部矩阵 | 9 / 11 / 4 | 9 / 11 / 4 |
| 可信 HTTPS / HTTP / HTTPS / HTTP 引导 | 2 / 1 / 1 / 1 | 2 / 1 / 1 / 1 |
| 原生包 / core 来源 / 三平台归档 | 3 / 1 / 1 | 3 / 1 / 1 |

真实 WASM 单线程/多线程、独立 FFmpeg 平面对照、FATE 固定指纹、FLV 首帧/后台索引、HLG 尾帧/seek、HEVC 本地与远程四格、可信 HTTPS 及三平台 Node/Bun 原生包验证均保留。未修改解码器、core、媒体、参考指纹或功能/像素/性能阈值。

## 生命周期与执行验收

公共 fixture 已用于 13 类回归，覆盖 Chromium/WebKit 共 25 个执行项（color-settings 原本固定 WebKit）。每项独占临时 SQLite、随机端口、浏览器/context 与产物；主题受限存储、设置 DPR 2 和标注第二页面使用登记的额外 context。普通 HTTP 引导/身份复用 origin 转发；可信 HTTPS、重启、Vite、Range 故障注入和原生包保留专用扩展与原有矩阵，由统一 runner 监督。

契约注入了断言失败、监听/启动失败、context 失败、执行超时、取消、子进程/后代清理故障及迟到资源关闭失败。其他独立项仍收集结果；required 失败、取消和结果缺失仍阻断；清理异常单独记录，原始异常保持不变。报告的未完成通过前缀不能算通过。发布契约检查原生依赖与草稿重跑边界。

同一套件的多个 case 共用一次构建；CI job 的准备凭据校验源码、配置、core 和 dist 实际字节、Node 与平台，过期时失败。普通运行不读取旧凭据；只读媒体准备由 job 执行一次，可写数据按 case 隔离。构建证据在报告目录 `build/results.json` 和 `build/build.log`，完整选择与结果位于 `selection.json` / `results.json`。

## 目录与兼容验收

Node 实现分批归入 94 个 unit、9 个 contract、24 个 media 文件及 helpers；13 类浏览器实现按 ui、annotations、media、workspace 分域。开发、夹具、诊断、性能和发布工具按职责分开，并有 [脚本索引](../scripts/README.md)。顶层旧脚本、Node 文件、helper 导入和 Worker URL 保留兼容，固定参考文件不搬动。

新贡献者的准备顺序、完整套件和单项筛选、平台范围、报告定位及 CI 映射见 [验证说明](testing.md)。新增漏登记用例、工具或悬空实现会失败；同一 Node 实现只有一个兼容入口归属，不通过递归执行两套文件来增加计数。
