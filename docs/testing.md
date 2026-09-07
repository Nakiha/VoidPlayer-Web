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

本次发布的 FLV 硬件优先策略回归使用 `FLV_CASE=standard-h264`，同时限定素材生成与浏览器用例，验证 WebCodecs、Range、seek 和播放。完整 FLV 回归仍默认覆盖所有编码，其中 H.266 素材生成需要支持 VVC 的新版 FFmpeg；Ubuntu 24.04 自带的 FFmpeg 6 无法生成该素材。

## 常规检查

```sh
npm test
npm run build
npm run test:browser
node --test test/range-reader.test.ts test/mp4-packets.test.ts test/range-media.test.ts
npm run test:range:browser
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

远程 HTTP 现在进入连接准备页，不再启动播放器或 WASM。对应检查为：

```sh
npm run test:connection:browser
npm run test:presentation:browser
```

前者检查 Windows/macOS 安装步骤、实际公开 CA 下载、HTTPS 链接与未配置状态，并确认未加载播放器或解码 Worker；后者在 Chromium/WebKit 中检查原生帧和 RGBA 直接上传、按需源像素、旋转、像素缓冲复用、无 WebGL 回退与资源清理。页面取源像素应使用 `window.voidPlayer.captureFrame(slot)`，不要直接读取可能尚未生成的隐藏 canvas。

发布工作流使用 `VOIDPLAYER_HTTPS_TEST=1 node scripts/check-http-playback.mjs` 验证可信 HTTPS 下的重复载入和播放：只在一次性 Actions runner 中导入测试根证书，结束后删除信任项；浏览器不使用忽略证书错误的参数。样片由 `node scripts/make-playback-fixtures.mjs` 生成，报告写入 `.run/playback-reports/`。Linux 和 Windows 还检查用户设置、重启恢复、解码出帧与标注。本机播放基准使用上文的 localhost 媒体服务，无需更改本机证书信任。

帧队列同时按数量和字节限制，播放报告的 `measurements.buffers` 记录每轨当前值、峰值及上限。这仅统计队列内已解码帧，不代表浏览器总内存；解码器、压缩文件、画布与 GPU 还会占用内存。

CI 将这两类检查分开运行：`--functional-only` 检查载入、解码路径、资源释放和队列边界，失败仍阻止发布汇总；`--benchmark-only` 单独输出性能报告，保留原阈值和非零失败退出码，但该步骤不阻止合并或发布汇总。无参数时仍依次运行全部检查。共享 runner 的绝对速度不是目标设备性能，也没有 main 的同环境对照，不能独自判定 PR 性能回退。身份工作流仅在 PR 和 main 推送时触发，避免同一 PR 分支推送重复运行。

这些是当前设备上的 canvas 呈现证据，不是物理显示扫描、所有 Safari 版本、HDR 保真或低端硬件性能保证。浏览器下载和剪贴板还受宿主权限影响，不能用“调用成功”代替实际文件/内容送达验证。

## 独立发布产物

使用 `.bun-version` 对应的 Bun 执行 `npm run release`，可用 `BUN_BIN` 指定可执行路径。`npm run test:release` 校验最新归档并在临时目录解压运行；也可传归档路径。测试服务使用空 PATH，不依赖源码或 node_modules，覆盖配置初始化、不同工作目录、HTTP/HEAD/Range、并发、中断、鉴权、上传日志、退出及升级保留数据。`RELEASE_BENCH=1 npm run test:release` 额外用 WebKit 在独立服务上跑四组真实播放基准，需要同步样片和浏览器。

远程 WASM 专项验证包含 MP4/VVC 索引不遍历 mdat、与原 FFmpeg 路径逐像素对比、B 帧/GOP 随机跳转和尾帧、5 GiB 稀疏来源、Range 响应校验与取消。`range-media.test.ts` 使用真实本地 HTTP 服务；`range-reader.test.ts` 使用可控响应检查缓存与 AVIO 桥接，不替代浏览器网络验证。私有 FLV 继续由 `test/flv.test.ts` 和 `test:flv:browser` 覆盖。

### FLV first-frame and shared index cache

`node --test test/flv-startup.test.ts test/frame-index-cache.test.ts` checks checkpoint resume, bounded reads, index deadlines, decoder retry, cache schema/version validation, persistence, deletion and offline storage.

After syncing the pinned core and generating `standard-h264.flv`, run `node --test test/flv-background.test.ts` and `npm run test:flv:startup`. The fixture appends a sparse 256 MiB audio tail and blocks reads beyond the initial 64 KiB. The first decoded/drawn frame must arrive while the tail remains blocked. After release, the worker uploads the complete index, a second opening reuses it without rescanning the tail, and playback plus administrator UI/WebMCP clearing are checked. Run `node scripts/check-flv-startup-browser.mjs webkit` for WebKit.

FLV startup reads the configuration and first video packet, then flushes the decoder to display that frame. The rest is scanned from the saved tag offset after the first frame; seeking outside the indexed prefix waits for completion. Duration is provisional until then, exposed as `indexState` in session metadata and the inspector. Cache lookup/upload is optional and never blocks the first frame.

Complete indexes are keyed by media ID + file version + schema and stored in the library SQLite database (schema 3). Downgrading to a schema-2-only build requires restoring the prior database backup or rebuilding the library index. Only version-pinned library URLs use the cache API. The same-origin client upload validates bounded packet offsets, codec configuration and timing; consumers check the cached prefix against freshly read source bytes. Missing/changed files and removed/relocated roots invalidate caches, while offline storage preserves them. Cache uploads are capped at 32 MiB; total live cache data is capped at 256 MiB with least-recently-used eviction. Clearing increments an epoch so an earlier in-flight upload cannot undo the clear. SQLite may retain reusable free pages after deletion.

Administrators can list/search and clear individual versions or all caches under **帧索引缓存**. `list_frame_indexes` and `clear_frame_indexes` are registered through WebMCP in both the player and administration page and share the same client functions and server authorization.


暂停续播回归：`test/session.test.ts` 验证双轨连续暂停/恢复不重新 seek 或创建迭代器；定位、替换及释放会销毁原队列。`test/playback.test.ts` 验证暂停期间未完成解码最多归还当前一帧、不继续拉取，且未显示的帧不会被丢弃。播放队列仍按 4 帧 / 64 MiB 双重背压限制，允许单帧超预算以保证进展；原生帧按 allocationSize 估算像素存储，格式不可见时才按 RGBA 估算。该值不包含解码器内部参考帧、Mediabunny 预解码队列或 GPU 的全部开销。暂停保留这些有界解码资源以便快速续播，移除轨道才完全释放。

`check-http-playback.mjs --functional-only` 在真实 MP4/WebCodecs 上验证暂停无时间推进、快速反复续播不重新 configure 解码器，并继续执行原有双轨内存与资源释放检查。性能基准仍独立记录，避免把续播改善等同于持续解码达到实时。

失败诊断：`test/media-diagnostics.test.ts` 覆盖带 CRC 的 PAT/PMT、跨包 PSI、连续计数缺口、188/192/204 字节 TS 包，以及 AVS3 (0xD4)、HEVC (0x24)、私有 PES (0x06) 不误识别。只有所有打开路径都失败且不是网络/资源错误时，才额外探测至多 64 KiB、远程读取至多等待 1.5 秒。诊断报告 PMT 声明的编码，不把声明当作码流有效性证明；探测失败保留原错误，不扩大下载范围。


FLV 尾部恢复：`test/flv-recovery.test.ts` 和 `test/flv.test.ts` 验证首帧优先后，尾部截断不再使后台索引失败。只将末尾未完成标签排除出索引；非零 stream ID、错误 PreviousTagSize 等依然失败，配置头或起始关键帧缺失不能冒充可播放文件。时长来自完整包的时间戳，UI 明示“尾部不完整”；不把源文件绝对时间戳当作可播放时长。共享 FLV 帧索引格式升级为 schema 2 以保存 truncatedAt，旧格式缓存读取时自动失效，无媒体库数据库迁移。

真实 HEVC/私有 VVC/AVC 回归在完整码流后追加残缺视频标签，验证连续取帧、前后定位、尾帧及警告。首帧浏览器夹具包含被阻塞的大尾部和最终残缺标签，验证后台恢复、播放基准、警告显示与服务器缓存复用。缺失包可能是其他完整包的参考帧，因此恢复不保证任意损坏流都能输出每一帧；解码失败保留上下文并停止重复调用失败的解码器。worker 原始异常堆栈进入现有本地诊断日志，不额外上传。


FLV 同编码配置/分辨率切换：索引记录每段配置和所属视频包，新配置从关键帧开始；解码或跨段定位时切换对应配置并在段末 drain，避免丢失旧段 B 帧。WASM 复用模块，通过既有 vp_packet_open 重建上下文；WebCodecs 重新 configure。`test/flv-resolution.test.ts` 生成真实 H.264/HEVC 双分辨率文件，验证顺序帧、来回定位和缓存序列化；浏览器夹具验证实际播放跨过切换点及 UI 尺寸。尺寸由 session 在显示帧时更新，不由后台预读提前改变。不支持中途更换视频编码种类；配置切换缺少关键帧仍明确报错。
