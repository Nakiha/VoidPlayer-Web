# HEVC execution transaction

Execution ABI1 is additive to block/reference ABI1. Old cores execute fully;
old clients also get full execution from new cores because mode defaults to zero.
The semantic `blocks-basic-v2` recipe, EXACT rules, GOP/picture/index identities,
resource limits and playback paths remain unchanged. Exact Core buildId/WASM
digest separates artifact caches; full and fast outputs must be equivalent.

Only a complete index and syntax-proven closed anchor admit fast execution.
`input.plan` supplies the actual reference preroll; dependent/open or incremental
full-film work stays on the original full path. Large block/legacy streams select
full before starting. Eligible summary work and bounded exact results may use the
new Core extension, whose existing FFmpeg VPS/SPS/PPS parser decides whether the
configuration really permits Main8 pruning. Main10/PCM/TQB/extensions stay full.

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

This choice delays the first publication of a cold summary GOP until commit;
measure first-result latency separately from total completion. Exact analysis
only stages its requested picture, after its own packet/suffix SEI processing
and necessary reference/reorder work; it does not validate unseen future AUs.

The upstream Core source is stacked on unmerged sorter PR9. Publishing requires
the FFmpeg analysis change, then its exact Core pin/artifact, then the Web analysis
pin. This local Web branch intentionally does not change the tracked release pin.
Execution media tests explicitly report a skip for the extension-only cases when
CI still supplies the old pinned Core; local candidate validation must run them
without skips before the dependency/pin advances.
