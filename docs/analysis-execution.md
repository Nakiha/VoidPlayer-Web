# HEVC and VVC execution transaction

Execution ABI1 is additive to block/reference ABI1. Old cores execute fully;
old clients also get full execution from new cores because mode defaults to zero.
The semantic `blocks-basic-v2` recipe, EXACT rules, GOP/picture/index identities,
resource limits and playback paths remain unchanged. Exact Core buildId/WASM
digest separates artifact caches; full and fast outputs must be equivalent.

An explicit single-picture `blocks` request can use fast execution with a
complete index and a syntax-proven closed anchor. `input.plan` supplies the
actual reference preroll. A cold continuous HEVC or VVC `blocks` request can also use
fast execution when the complete reference chain fits 128 pictures and the
32 MiB input budget, starts at a verified closed anchor, and has one decoder
configuration. The decoder carries syntax reference state across open GOPs.
VVC also supports progressive no-pixels execution for sealed summary streams
and blocks streams over 128 pictures. These streams retain one decoder across
dependent GOPs and commit each validated output through the existing per-picture
backpressure. The decoder checks the picture's AU, including suffix SEI, and
completes its reference work before making that picture available. A later
pixel requirement closes the pruned decoder and replays once with full pixels
from the same verified anchor. The host remembers committed AU identities and
suppresses duplicate publication and progress during replay.

The server's threaded Core factory retains the imported WebAssembly memory and
refreshes the host byte view when that memory grows. Pthread growth can leave
the main runtime's old fixed SharedArrayBuffer view shorter than valid output
pointers. Block/reference bounds checks use the current view; this does not
relax pointer validation, change decoder memory limits, or restart failed work.

VVC viewport requests with explicit summary or blocks output can use a bounded
private attempt per missing group, including the verified closed-anchor
preroll for a dependent group. A late retry preserves the existing one-retry
policy for the whole viewport. Other viewport, range and legacy requests keep
their full path. Unsealed streams and adapters that acknowledge input while
publishing retain their existing execution policy.
The Core extension's existing
FFmpeg parameter-set parser decides whether the
configuration really permits HEVC Main8/Main10 or VVC Main10 4:2:0 8..10 bit
pruning. PCM/TQB/extensions stay full; VVC in-band parameter changes, film grain
and decoded-picture-hash SEI restart the transaction exactly like their HEVC
counterparts and report the same reasons. Main10 retains `unsupported-qp-depth`,
unsupported QP
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

For bounded attempts, staged results and their coverage stay private until the
transaction completes. The winning owners then flow through existing awaited
per-picture backpressure. Publication
is outside the retry catch: cancellation or consumer error during commit cannot
start another generation. A cancelled commit may retain its already committed
exact pictures, which the existing cache/resume protocol can safely reuse.
Consequently the external worker/HTTP protocol needs no rollback/generation change.

Staging a cold summary GOP delayed the first publication and wasted decoded work
on pause, so continuous summaries keep incremental delivery. Exact analysis
stages its requested picture after packet and suffix SEI processing and necessary
reference/reorder work. Continuous blocks requests using the bounded transaction
publish after the chain completes, which can delay the first result.

The sorter dependency (Core PR9), FFmpeg analysis change (FFmpeg PR1), Core
execution change (Core PR10) and the VVC pruning change (FFmpeg PR3, Core PR12)
have merged into their analysis target branches. The current Core and FFmpeg
revisions are recorded in [the Web analysis lock](../scripts/release-analysis.json).
The pinned artifact enables HEVC and VVC pruning and H264 loop-filter discard.
VVC shares the playback decoder's optimized CABAC and Wasm SIMD kernels. The
pixel kernels accelerate full execution, while syntax-only execution continues
to skip reconstruction and filtering. The pinned artifact runs the execution
media tests with the extension enabled. The VVC cases require the synced h266
sample and report a skip if it is missing. Older cores use full execution.

H264 remains an incremental analysis path. The independent Core uses FFmpeg's
existing loop-filter discard policy because its macroblock hook already omits
pixel reconstruction. It is not an HEVC/VVC private transaction and still reports
fullOpen with no staged owners or fallback. QP/mode/reference semantics, full-GOP
cache identities, error handling and playback remain unchanged.
