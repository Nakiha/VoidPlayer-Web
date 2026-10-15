# HEVC execution transaction

Execution ABI1 is additive to block/reference ABI1. Old cores execute fully;
old clients also get full execution from new cores because mode defaults to zero.
The semantic `blocks-basic-v2` recipe, EXACT rules, GOP/picture/index identities,
resource limits and playback paths remain unchanged. Exact Core buildId/WASM
digest separates artifact caches; full and fast outputs must be equivalent.

Only an explicit single-picture `blocks` request with a complete index and
syntax-proven closed anchor admits fast execution.
`input.plan` supplies the actual reference preroll; dependent/open or incremental
full-film work stays on the original full path. Summary, range, viewport and legacy
requests also keep full, incremental publication, even with one cache miss left in
a GOP. This preserves summary first-result latency and pause/resume work while
retaining the measured precise-frame benefit. The new Core extension's existing
FFmpeg VPS/SPS/PPS parser decides whether the
configuration really permits Main8 or strictly 10-bit Main10 pruning. PCM/TQB/
extensions stay full. Main10 retains `unsupported-qp-depth`, unsupported QP
capability, null block QP and null mean. Existing exact block/mode/reference
semantics do not imply accurate Main10 QP; the clipped unsigned callback cannot
represent its signed range. This is an execution optimization, with no ABI or
result-capability extension.

Fast picture owners are private in the worker. Before allocating a block payload
or legacy block array, the producer reserves metadata+payload ownership under the
existing 32 MiB in-flight limit. On overflow it allocates no new payload, drops
all speculative owners, and chooses the full streaming attempt. This temporary
capacity signal is distinct from a decoder/resource failure.

Only the Core's fixed RETRY_FULL tag or that temporary capacity signal restarts.
The failed decoder is closed before a fresh full context replays the same proven
anchor and required preroll. An execution policy shared by all groups limits the
whole request to one retry; subsequent groups stay full. Cancel, source change,
invalid requests, corrupt data, missing references and ENOMEM are not general
retry triggers. Malformed new parameter sets preserve their parser error.

No speculative result or coverage/progress increment reaches a cache, chart,
server store or overlay. Once decoding the requested transaction succeeds, the
winning owners flow through existing awaited per-picture backpressure. Publication
is outside the retry catch: cancellation or consumer error during commit cannot
start another generation. A cancelled commit may retain its already committed
exact pictures, which the existing cache/resume protocol can safely reuse.
Consequently the external worker/HTTP protocol needs no rollback/generation change.

Staging a cold summary GOP delayed the first publication and wasted decoded work
on pause, so that experiment is not the product policy. Exact analysis only
stages its requested picture, after its own packet/suffix SEI processing
and necessary reference/reorder work; it does not validate unseen future AUs.

The sorter dependency (Core PR9), FFmpeg analysis change (FFmpeg PR1) and Core
execution change (Core PR10) have merged into their analysis target branches.
The Web analysis lock pins tested Core source
`7331ad4ef11af8b7e30e1e5db1ee1b55a38c1681` and FFmpeg source
`653cf4becc91425be3021a3f0347f6cdd3fd14ec`; both exact commits remain in the merged
history. The clean exact-source CI artifact enables both HEVC pruning and H264
loop-filter discard. Execution media tests must run without extension-only skips
against this pinned artifact. Older cores remain supported through full execution.

H264 remains an incremental analysis path. The independent Core uses FFmpeg's
existing loop-filter discard policy because its macroblock hook already omits
pixel reconstruction. It is not an HEVC private transaction and still reports
fullOpen with no staged owners or fallback. QP/mode/reference semantics, full-GOP
cache identities, error handling and playback remain unchanged.
