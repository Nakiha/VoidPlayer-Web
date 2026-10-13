# VVC 独立参考答案

`bitstream-analysis-vtm.json` 来自 JVET VTM 官方参考解码器的内置 `D_BLOCK_STATISTICS_ALL`，不导入 VoidPlayer/FFmpeg 的采集代码。固定 VTM 修订为 `69f5112bae8c0f91f3cbc5ba0f44b58986080f16`；仅用编译选项开启原有 tracing，没有修改解码算法或块统计实现。

原始样片 `h266_10s_1920x1080.mp4` 的 SHA-256、抽取的 Annex B、原始 trace 哈希均在 JSON 中。抽取前 17 个编码包，成功解码完成后，冻结 POC 0、16、1（AU 0、1、5），涵盖 I/B 帧及 intra/inter/skip。总计 32983 个 CU 的 `[x,y,width,height,lumaQP,mode]` 按坐标排序，以紧凑 JSON 计算全量哈希，同时保留可人工检查的具体块记录。每帧覆盖面积须为 1920×1080；core 回归还执行完整块覆盖/无重叠校验。

参考列表来自 VTM 解码日志的 `[L0 ...] [L1 ...]`。日志解码输出顺序给出 AU；将 POC 转换成该顺序中的稳定 AU，然后比较每个列表的成员集合。尾缀 `c` 只标记 collocated reference，不改变 picture 身份。这证明的是当前 API 声明的 active-list 参考集合，不声明 per-block MV 或参考索引顺序。

VTM 的局部双树可能输出 `[0x0]` 的空 luma 区域（实际是 chroma-only CU）；提取器明确排除零面积记录，只保留完整有效的 luma CU。标准内置统计中的 `PredMode=0/1` 映射为 inter/intra，`SkipFlag=1` 优先映射为 skip；未知模式或缺失记录会使生成失败。不能忽略冲突重复记录或用默认 QP 补值。

## 复现

需要 Git、CMake、C++17 编译器、FFmpeg（含 `vvc_mp4toannexb`）、Python 3.11+ 与已同步 QA 样片。以仓库根目录执行：

```sh
git clone https://vcgit.hhi.fraunhofer.de/jvet/VVCSoftware_VTM.git .run/issue56-vtm/source
git -C .run/issue56-vtm/source checkout 69f5112bae8c0f91f3cbc5ba0f44b58986080f16
cmake -S .run/issue56-vtm/source -B .run/issue56-vtm/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-DENABLE_TRACING=1
cmake --build .run/issue56-vtm/build --target DecoderApp -j 4
ffmpeg -y -hide_banner -loglevel error -i fixtures/video/h266_10s_1920x1080.mp4 -map 0:v:0 -frames:v 17 -c copy -bsf:v vvc_mp4toannexb -f vvc .run/issue56-vtm/first17.vvc
```

用 CMake 输出路径中的 `DecoderApp` 执行（下例为本次 macOS ARM64/Clang 路径）：

```sh
.run/issue56-vtm/source/bin/umake/clang-21.0/arm64/release/DecoderApp -b .run/issue56-vtm/first17.vvc --TraceFile=.run/issue56-vtm/all-blocks.vtmbmsstats '--TraceRule=D_BLOCK_STATISTICS_ALL:poc>=0' > .run/issue56-vtm/decode-all.log 2>&1
python3 scripts/tools/fixtures/read-vtm-analysis.py .run/issue56-vtm/source .run/issue56-vtm/all-blocks.vtmbmsstats .run/issue56-vtm/decode-all.log fixtures/video/h266_10s_1920x1080.mp4 .run/issue56-vtm/first17.vvc .run/issue56-vtm/regenerated.json
diff -u docs/fixtures/bitstream-analysis-vtm.json .run/issue56-vtm/regenerated.json
node --test --test-name-pattern='independent VTM' test/bitstream-analysis-core.test.ts
```

本次 VTM 全 17 帧成功退出，原始 trace 约 288 MiB，约 9 秒解码。必须对所有 POC 开启 tracing：仅筛部分 POC 会在此 VTM 修订遗留 geo context，触发内置统计断言，不能用异常退出的片段生成答案。生成器拒绝含 ERROR 或缺少正常结束标记的日志。日常 CI 只读已冻结答案运行真实 WASM，不在每次测试下载或编译 VTM。

该证据验证选定 picture 的全部基本块记录与参考关系；不据此扩大复杂 VVC 工具、MV、field/layer、多 slice 或高位深 QP 的支持范围。
