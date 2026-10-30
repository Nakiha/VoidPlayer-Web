# Exact reordered/delayed pictures in a bounded closed GOP

`packet-identity-gop-v1` extends the existing explicit single-frame-pair workflow.
It does not introduce sequence scoring, automatic frame alignment or a new
container. GUI and HTTP/Agent select the same cached candidate, submit the same
durable job and consume the same PSNR/optional SSIM/grid and immutable evidence.
Closing observation does not cancel execution. Ordinary playback is untouched.

## Input and window

The existing registered library source, stat-version/file descriptor checks,
complete server-produced cache, namespace/build identity, single configuration,
progressive H.264/HEVC, explicitly tagged native 8/10-bit YUV420 and ROI/color
admission remain. Stat identity is not content authentication. No implicit
probe, cache build, upload or alternate source is performed.

The selected target carries:

```json
{"decode":{"mode":"packet-identity-gop-v1","startAu":0,"endAu":15}}
```

Both endpoints are **inclusive**. `picture.au` is independently explicit and
may be anywhere in that window; `sourcePtsUs` is its actual source clock.
The window starts at an actual verified single closed IDR. It contains every
cached video AU through the next closed-IDR boundary or final source end, with
no interior key/configuration/discontinuity. The next boundary's actual tag,
NALs and repeated parameter sets are checked without feeding it to the decoder.
The source end is the existing complete producer-bound index, not an inferred
duration. Boundary reads count against the normal byte budget.

Each side has at most512 AUs. PTS must be known and globally unique; DTS must be
known and strictly increase in decode order. Nonzero CTS and reordered PTS are
allowed. Missing/duplicate clocks, incomplete/oversized windows, CRA/open starts,
unknown/multiple/field pictures and changed parameter sets are refused. A cached
candidate is not a decoder preflight: execution verifies the actual source.
The selector prefers this explicit token-bound mode for every complete bounded
GOP, including zero CTS. PTS=DTS cannot prove immediate output: valid H.264/HEVC
streams may release all pictures only during drain. Old explicitly submitted
isolated/forward requests retain their strict existing semantics; the service
does not silently change their decoder mode after a failure.

## Identity, pixels and work

The fixed core must expose packet identity ABI1. Each admitted AU is sent with
the uint64 token `au+1`, independent of clocks and output order. Its opaque
descriptor carries context generation, token, original PTS/DTS, byte count and
FNV payload checksum. The checksum is a tuple check, not authentication.

Every received output must identify one submitted AU in this context epoch,
exactly once, with the exact packet tuple and zero reported decoder error flags.
Actual raw-frame PTS is a cross-check; it never selects or substitutes an AU.
All receives are exhausted between sends, followed by explicit EOF/drain. Every
input must yield exactly one observed output overall, including post-target and
drain outputs; missing, unknown or duplicate output is a terminal failure.
Only the selected token's pixels are copied/retained. The host still checks the
native frame ABI, pixel allocation, color/bit depth and ROI before measurement.

All decoder inputs and observed outputs are charged: at most64 across the pair.
The same16MiB read,8MiB packet,32MiB retained-frame,256MiB WASM,4096×2304 pixel,
30s deadline and128KiB result/evidence ceilings remain. Decoder identity mode is
single-threaded even in the MT build. Deadline or cancellation revokes source IO
and physically terminates the owning Worker before admission is released;
kernel IO drain/exit can delay settlement while capacity remains occupied.

**This is attribution of the actual selected input-window output, not reference
graph integrity certification or proof of no concealment.** Reported error flags
are checked, but unreported concealment is not ruled out. The immutable guarantee
still says `referenceIntegrity=not-certified`, `concealmentDetection=unavailable`.
The earlier missing-reference counterexample is not reclassified as repaired.

## Durable evidence and inspection

The explicit window enters the original request fingerprint: changing or removing
it under the same actor/client/key conflicts. Old isolated-key and forward-mode
requests retain their old normalization, budgets and semantics.

The result declares decoder `packetIdentity=packet-identity-gop-v1` and
`packetIdentityAbi=1`. Each corresponding provenance has validation
`cached-closed-gop-packet-identity-v1`, complete dependency packets, boundary and
`outputIdentity` (ABI, generation, output AU/token/packet tuple/hash/error flags
and immediate/drain phase). Stored facts, result digest, annotation attachment,
export/historical import and original-frame inspection preserve these fields.
Deletion, changed membership or raised guarantees are rejected. Imported facts
remain historical and cannot acquire service verification.

Original-frame inspection replays the same entire window using the same fixed
decoder and compares all provenance. It never reads private jobs, re-scores,
builds caches or controls the original player. Its stricter exact square SAR,
uncropped and unrotated geometry remains; measurement support does not imply
display support.

## Verification

Committed synthetic H.2648/HEVC10 fixtures carry fixed native FFmpeg raw planes;
oracle AU attribution uses demux packet byte positions, not PTS matching.
The explicit fixture importer also requires fixed-revision native ffmpeg/ffprobe
arguments. Two-AU zero-CTS H.2648/HEVC10 fixtures are independently decoded and
byte-position attributed; their actual WASM outputs must all occur in drain.
Each existing GOP browser case additionally submits this delayed source through
GUI, attaches its result and compares raw snapshot Worker pixels with the oracle.
Node media tests compare every selected output including drain, metric/grid and
immutable identity fields, the historical 32/64 budgets (current ceilings are 512/1024) and actual native-send cancellation.
The registered Chromium/WebKit ×8/10 real GUI cases exercise submission through
the shared durable job, Agent facts, existing annotation and raw pair/block view,
including actor/client/space races, cache/source changes and playback isolation.
Native packaged acceptance also scores these fixtures with an empty PATH and
checks persisted jobs/evidence across restart. Full CI and independent review
remain the release gates; functional success is not a performance claim.

Current AU ceilings come from `FORWARD_PAIR_LIMITS` in `shared/analysis/quality/frame-pair.ts`: 512 per side and 1024 inputs/outputs per pair. These are ceilings, not an admission guarantee; explicit request, memory, source-byte and elapsed-time budgets can impose smaller windows. Historical 32/64 evidence above describes the limits at the time of that run.
