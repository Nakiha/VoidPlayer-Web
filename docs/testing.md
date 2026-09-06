# 验证说明

验证命令以 `package.json` 为准。不要把某次历史测试数量或构建成功当作当前兼容性结论。

## 准备

```sh
npm ci
bash scripts/sync-wasm-core.sh
bash scripts/sync-samples.sh
npx playwright install webkit chromium
npm run fixtures:flv
```

FLV 样片生成需要 Python 3、ffmpeg 和 ffprobe。`fixtures/`、`dist/` 和 `public/vendor/voidplayer-core/` 是本机产物，不进入 Git。需要基础合成样片时运行 `python3 test/generate-fixtures.py`。

## 常规检查

```sh
npm test
npm run build
npm run test:browser
```

单元测试使用 Node test runner，包含真实 WASM 和 FLV 解码。浏览器脚本启动独立的临时媒体服务并清理，不需要刷新用户页面或重启后台服务。浏览器脚本默认 WebKit，可用末尾参数 `-- chromium` 切换。

| 改动 | 补充验证 |
| --- | --- |
| 标注交互、采样与图层 | `npm run test:annotations:browser`、`npm run test:annotations:rendering` |
| 设置窗口、分类导航、焦点、日志及窄屏布局 | `npm run test:settings:browser` |
| 工作区导入导出、失败回滚、外观设置及进度回跳 | `npm run test:workspace:browser` |
| 亮暗主题、系统跟随、外观持久化 | `npm run test:theme:browser` |
| 菜单、色盘、工具条 | `npm run test:menus:browser` |
| 标记身份、卡片、缩略图 | `npm run test:mark-cards:browser` |
| 快捷键与 tooltip | `npm run test:shortcuts:browser`、`npm run test:feedback:browser` |
| 混合帧率步进 | `npm run test:stepping:browser` |
| 时长、进度、子轨道 | `npm run test:timeline:browser` |
| 像素格式与色彩元数据 | `npm run test:metadata:browser` |
| FLV 文件路径 | `npm run test:flv:browser` |

修改播放或解码路径后还必须跑播放基准。修改视图尺寸调度、轨道操作或片源 UI 后跑 `test:browser`。

## 播放基准

先构建并启动包含 QA 媒体库的服务，然后运行：

```sh
node scripts/bench-playback.mjs webkit
node scripts/bench-playback.mjs chromium
```

`BASE_URL` 选择服务地址，`BENCH_REPEATS` 默认 3，`BENCH_DURATION_MS` 默认 8000。`--headless` 为离屏自动化运行。场景和阈值分别以 `scripts/bench-playback.mjs`、`src/benchmark.ts` 为准。

应用内“快捷键与说明”的性能检查、Agent `benchmark_review` 和脚本共用同一个实现。它检查呈现帧、速度、等待、卡顿、同步和暂停后的旧帧；失败场景使脚本返回非零退出码。

这些是当前设备上的 canvas 呈现证据，不是物理显示扫描、所有 Safari 版本、HDR 保真或低端硬件性能保证。浏览器下载和剪贴板还受宿主权限影响，不能用“调用成功”代替实际文件/内容送达验证。

## 独立发布产物

使用 `.bun-version` 对应的 Bun 执行 `npm run release`，可用 `BUN_BIN` 指定可执行路径。`npm run test:release` 校验最新归档并在临时目录解压运行；也可传归档路径。测试服务使用空 PATH，不依赖源码或 node_modules，覆盖配置初始化、不同工作目录、HTTP/HEAD/Range、并发、中断、鉴权、上传日志、退出及升级保留数据。`RELEASE_BENCH=1 npm run test:release` 额外用 WebKit 在独立服务上跑四组真实播放基准，需要同步样片和浏览器。
