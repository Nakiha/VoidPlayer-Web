# FATE 集成审查（2026-09-07）

> 以下正文保留 PR #2 时的历史发现。后续四批重构及当前验收见
> [帧契约 Roadmap](frame-contract-roadmap.md)：已冻结逐帧 PTS、尺寸与 SDR 像素指纹，
> 修复输出描述、配置切换和包/显示时间线边界，并统一元数据更新。
> core 锁定 `c0d3c36` 后，本地 Node 15 个适用组合及 40 次浏览器检查通过；
> 8 个不适用 Node 入口仍按预期阶段拒绝。当前没有已知失败豁免，CI 已改为阻塞门禁。
> 这些结果不是任意片源兼容性、HDR 色准或播放性能全部达标的结论。

## 结论

当前风险集中在边界契约，而非单一解码器：首帧可用不代表整条时间线可解码；包索引不等同于显示帧索引；像素、尺寸和色彩信息没有始终随同一输出帧传递；缓存签名和诊断状态又分别手写。这些条件组合起来，容易出现无异常的错画面，或首帧成功后起播失败。

此轮下载 FFmpeg 官方 FATE suite 的 8 个样本（合计约 1.7 MB），固定 URL、字节数和 SHA-256。FATE 是 FFmpeg 回归集，包含有意损坏的输入；本项目不应将所有样本都必须能播放作为目标。参考资料：[FATE 文档](https://ffmpeg.org/fate.html)、[H.264 样本目录](https://fate-suite.ffmpeg.org/h264/)、[HEVC 样本目录](https://fate-suite.ffmpeg.org/hevc/)。未复制用户内网文件或日志。

## 本地实测

使用项目锁定 core `115f3653`，分别检查普通 FFmpeg 单/多线程和适用的 TS 包路径：首帧、完整顺序解码、0/中间/末尾/0 定位，另用 ffprobe 的逐帧尺寸和帧数对照。23 个组合中 8 个通过全部这些检查。这不是兼容率，也不是官方 FATE pass 数；没有逐像素色彩正确性或硬件解码性能结论。

| 样本 | 发现 |
| --- | --- |
| `h264/brokensps.flv` | FLV 包路径完成 79 帧及往返定位。普通 FFmpeg core 没有 FLV 解封装入口，那个入口失败不是回归。 |
| `h264/test-4867.flv` | 系统 FFmpeg 可输出 359 帧；播放器严格拒绝 PreviousTagSize 不一致。需要明确录播容错策略，不能直接删除校验。 |
| `h264/extradata-reload-multi-stsd.mov` | 三条路径都可输出 4 帧，但参考尺寸从 256×128 变为 128×128，播放器始终标成 128×128。只检查帧数会误报通过。 |
| `hevc/extradata-reload-multi-stsd.mov` | 普通回退的尺寸标记也不随参考帧变化；包路径首帧之后出现目标 PTS 不匹配。 |
| `h264/crop-to-container-dims-canon.mov` | 普通回退完成一帧及定位；包路径按 container 阶段拒绝，属于已有可路由的能力边界。 |
| `h264/h264_4bf_pyramid_nobsrestriction.mp4` | 普通回退两种 core 完成 25 帧；包路径首帧成功，随后目标 40000µs 却得到 120000µs。 |
| `h264/interlaced_crop.mp4` | 三条路径均完成 126 帧、尺寸和定位检查；不代表验证了去隔行视觉质量。 |
| `hevc/paramchange_yuv420p_yuv420p10.hevc` | 系统 FFmpeg 能解析变尺寸/位深；裁剪版 core 拒绝裸 HEVC 封装入口。本轮没有将其重新封装后宣称测过原文件。 |

## 已确认的结构问题和修复边界

1. **输出帧 ABI 不完整（高优先级）**。core `vp_convert()` 依据 AVFrame 的尺寸生成 RGBA，而 `vp_width/vp_height` 返回 AVCodecContext 尺寸；重排、预读和配置变更时两者可能不同。普通 worker 又只传 ArrayBuffer，客户端使用 init.width/height。仅修改 JS 的每帧尺寸传输不能彻底修复。本轮核验后没有保留这种不完整的修补。应在 core 新增完整的帧描述：实际输出尺寸、像素长度/stride、PTS、像素格式/色彩及配置版本，客户端在边界验证后再显示。
2. **显示索引过早承诺**。MP4/FLV 以每包 PTS 构造帧索引；缺少重排约束、前导帧、多图像包、多 sample description 都可能破坏这个假设。已抓到 B 帧样本反例。需要显式区分压缩包索引、可寻址显示帧和解码预滚，不能遇到目标不匹配就随便显示下一帧。
3. **配置切换实现不对称**。FLV 已有配置段；MP4 包路径只取一次 decoderConfig，且普通容器回退没有完整逐帧描述。应共享配置段/输出帧契约；支持能力应在打开阶段检查，避免首帧成功后才暴露配置不可用。本轮未宣称已经修复多 stsd 或 B 帧反例。
4. **可变 MediaInfo + 手写刷新签名**。时长、尺寸、索引、格式分别变化，UI 容易漏字段。状态日志之前仅记 slot/id，使索引完成与动态尺寸更新不可追溯。本轮补记 durationUs、firstPtsUs、offsetUs、indexState/indexError、width/height、decoder/coreVariant；不逐帧记录 PTS，不记录媒体内容。建议后续统一元数据版本/变更事件，由 UI 和诊断共同消费。
5. **目标帧与实际送包被混淆**。原 FLV 异常中的“包位置”属于目标帧，真正失败可能是向前找关键帧后的另一个包。本轮补上实际 offset/size、PTS/DTS、配置段、目标 PTS 与锚点 PTS，保留阶段分类。
6. **成功指标偏向控制面**。不报错、首帧上屏、时间推进、队列释放都不能证明画面正确。应增加每帧尺寸/像素长度断言、静态 HDR 图案前后像素一致性、元数据变更后 UI 检查；颜色正确性还需参考转换和真实显示设备验证。

## 可重跑入口

```
node scripts/sync-fate-samples.mjs
node scripts/check-fate.mjs
node scripts/check-fate-browser.mjs
```

需已有锁定的单/多线程 WASM core、ffmpeg/ffprobe；浏览器检查另需 Playwright Chromium/WebKit。二进制仅放 gitignored fixtures/fate，仓库只提交清单和脚本。Node 报告为 `.run/playback-reports/fate-report.json`；浏览器报告为 `fate-browser-report.json`。浏览器检查 5 个重点样本 × 2 个浏览器 × 本地/HTTP 两条路径，每组合连续关闭重开两次，逐帧经过实际 presenter；记录阶段、尺寸/传递特性和错误，不冒充实时播放基准。

CI 新增探索性报告步骤，保留失败记录并上传产物，不将已知缺陷伪装成 release gate 通过。原有功能门禁和性能报告保留。此次浏览器实测结果以相应 CI artifact 为准；本地 Chromium 下载超时，未声称本机已完成浏览器测试。

## 浏览器实测补充

[CI 34129807720](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/34129807720) 已完成。5 个重点样本 × Chromium/WebKit × 本地/HTTP，共 20 个组合，每组合关闭重开两轮，共 40 次。完整明细在该次 `https-playback-reports` 的 `fate-browser-report.json`。没有将 phase=complete 等同于像素/尺寸正确。

- Chromium：HEVC 多 stsd 的本地路径使用普通 WASM 回退，可以完成 4 帧但尺寸仍固定错误；HTTP 包路径每轮都在首帧之后失败，目标 0µs 得到 40000µs。验证了本地/远程后端分流引出的行为差异。
- Chromium：H.264 无重排约束的 B 帧样本，本地/HTTP 每轮都正常结束但只输出 23 帧；firstPtsUs=0，durationUs=1000000。参考和 WebKit 为 25 帧。这是静默少帧现象，尚未断定责任属于浏览器、Mediabunny 还是调用方式。
- WebKit：隔行裁剪样本本地/HTTP 均能完整输出 126 帧，之后往返定位阶段每轮报 `Decode error`。仅测试顺序播放会漏报。
- WebKit：brokensps FLV 输出 79 帧但始终标记 192×144；Chromium 软件路径同样输出 79 帧，记录了 192×144→320×240。多 stsd 的两种 MOV 在 WebKit 也固定为最后一段尺寸，没有抛异常。帧数一致不能代替尺寸/图像验证。

本轮确认了问题并补强日志和测试基础设施，未修复以上全部解码/尺寸问题。下一批修复应以这些公开样本为验收：先统一输出帧 ABI，再处理配置切换与显示顺序；对容错恢复策略独立决策。原有功能与三平台产物汇总通过，持续双轨性能报告仍为非阻塞且有未达标项。
