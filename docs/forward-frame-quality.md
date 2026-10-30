# Exact bounded forward-dependent frame measurement

This extends the existing single-pair workflow in #114/#115/#121. It delivers
ordinary dependent pictures, not just more controls for closed key pictures.
GUI and HTTP/Agent select the same source/cache-bound AU candidates, submit the
same durable job, consume PSNR/optional SSIM/grid facts, explicitly attach them
to an existing shared annotation, and open the same read-only original-pair view.
No live playback session is consulted, paused or sought.

## Supported execution, and explicit refusals

Sources remain registered, version-pinned, server-produced complete single-config
unrecovered FLV/Enhanced FLV, progressive H.264/HEVC, fully tagged 8/10-bit YUV420.
This is a conservative forward subset: **PTS equals DTS, strictly increases, and
is unique in the source**. The chosen target carries its exact decode start:

```json
{"decode":{"mode":"forward-one-output-per-au-v1","startAu":0}}
```

The strict forward request remains available to explicit clients. Current cached
candidates prefer the complete token-bound GOP mode described in
[reordered-frame-quality.md](reordered-frame-quality.md), even with PTS=DTS:
equal clocks alone do not prove that the decoder emits immediately.

The field belongs to each reference/distorted target next to `picture` and
`sourcePtsUs`. Preserve it from `/api/media/{id}/psnr-frames?v=...`; do not derive it
from a playback token. For example, choose AU2/PTS2200000 and AU5/PTS2500000 in the
committed fixtures; explicit forward requests both start at AU0, but have different
decode windows (the preferred GOP candidates instead carry the complete end).
The candidate selector reads only the existing trusted cache and reports absolute
AU ordinals, exact source PTS, cache namespace/build and the bounded start. It does
not decode, build an index, claim content correspondence or certify the key flag.

Execution verifies the selected window before decoding:

- Start is an earlier container-key candidate proven from actual NALs to be a
  single closed IDR picture. Subsequent AUs are non-key single pictures through
  the exact target. The window has every intervening cached video AU, with no
  configuration change, recovered gap or clock discontinuity.
- Source configuration/prefix, every FLV tag/key/codec/timestamp/footer, every AU
  payload, and byte-identical repeated parameter sets are checked against the
  pinned cache. Source/file/cache checks remain active through final publication.
- A fresh single-thread WASM packet context decodes each side independently.
  Receive is exhausted after **each** input, before sending the next. Each input
  must yield **exactly one immediate output whose actual source PTS equals that
  input's independently checked PTS**. Only the target's pixels are copied and
  retained. Final drain must yield no residual frame.

This establishes identity by the single outstanding input/output association,
with exact clocks as a cross-check; it does not search outputs for a matching or
nearest PTS. No reference graph is inferred, and no opaque per-packet identity ABI
is claimed: the existing packet ABI does not expose such provenance. A delayed,
reordered or multi-picture output cannot be given a target identity and is refused.
Typical no-B-frame P streams are covered; **B-frame reordering, delayed-output
streams, open GOP/CRA starts, duplicate/missing clocks, non-forward CTS, missing
starts, changed parameters and longer windows are unsupported**. This is not all
ordinary frames, a frame sequence scorer, a new container path or automatic pairing.
Malformed/decode-error input is not repaired by finding a nearby frame. The
existing packet ABI does not expose per-frame decode_error_flags: this is an
identity and exact-input execution contract, not a new proof of reference-graph
integrity or an assertion that the pinned decoder never performs concealment.

This limit is exposed directly in API discovery and each immutable forward-side
`dependency.guarantee`: `pixels=exact-decoder-output-of-verified-input-window`,
`referenceIntegrity=not-certified`, `concealmentDetection=unavailable`. GUI frame
selection, task/shared-evidence results and the original-frame viewer display
the same distinction next to the relevant controls/facts. A complete trusted
cache proves index coverage, not coded reference completeness: the fixed H.264
counterexample deletes an intermediate reference AU, builds its actual trusted
cache, and completes an HTTP job whose pixels differ from the undamaged stream.
Its persisted guarantee still explicitly says not-certified/unavailable. Some
missing-reference streams are rejected by decoding; absence of a rejection is
never a certificate that no concealment occurred.

Measurement still uses the visible native-code-value grid and explicit even ROI.
The original-frame viewer additionally requires exact SPS square SAR, no crop and
no rotation. These geometry gates and source color/chroma-location gates are
unchanged. Scores do not assert that displayed screen pixels are the measured
native pixels.

## Budgets and ownership

Each forward side is at most **512 AUs including the start and target**; a pair
at most **1024 inputs and 1024 observed outputs**. A mixed isolated/forward pair charges
both paths. `budget.maxPackets` and `budget.maxOutputFrames` may only tighten the
forward defaults. Old isolated requests retain defaults of 2/2, including their
serialized idempotency fingerprints.

Existing limits remain: 16MiB total charged source reads, 8MiB per packet, 32MiB per
retained frame, 4096×2304 pixels, 256MiB WASM heap, 30 seconds including source and
final checks, 16KiB request and 128KiB immutable result/evidence. Intermediate
frames are charged but not copied into JavaScript. Dependency compressed buffers
are within the charged read cap. SSIM's additional numerical/window/scratch limits
and the grid maximum64 are unchanged. The service owns execution; closing a page
only removes an observer. Explicit cancel/deadline still revokes source IO and
waits for actual Worker termination before returning capacity. No retries, shared
work, automatic index build, external decoder executable or playback cursor is added.

## Durable provenance and compatibility

The input's optional decode mode/start participates in the original transactional
idempotency fingerprint; changing/omitting it with the same key conflicts. The
result records `packetIdentity: forward-one-output-per-au-v1` if either side uses
this mode. Each forward side records validation
`cached-contiguous-forward-one-output-per-au-v1`, its original target binding,
and `dependency.packets`: every AU's ordinal, byte offset/size, PTS/DTS and key flag,
plus observed output count. The target's original packet and decoded description
remain separate. Work and completed-task progress include **all decoded outputs**,
not just the two retained targets.

The immutable digest includes these facts. Attachments, normal edits, history,
plain/gzip workspace export and historical import retain them. Structural checks
reject incoherent windows/counts/decoder modes; imported facts never acquire
service verification. Viewing a confirmed shared attachment rechecks the source,
cache/producer document and entire original decode window with the same decoder,
then compares full provenance before presentation. It does not access the private
job, score, write an annotation, move a playback cursor or reuse its buffers.

Old targets without `decode`, old 2-packet results, old decoder validation and old
attachments keep the isolated closed-AU path. The result/workspace schemas retain
their versions as compatible optional fields; older strict readers may reject the
new forward evidence rather than silently discard it. Broader source formats,
SAR/crop/rotation, dependencies with reorder, sequences, VMAF and distributed work
remain outside this batch. Stat-derived source versions are not content authentication.

## Reproducible verification

`node scripts/tools/fixtures/quality-forward.mjs` generates committed H.2648 and
HEVC10 fixtures from eight real encoded frames (IDR plus seven non-key AUs), with
nonzero exact FLV timestamps and correct non-key tag flags. FFmpeg decodes the
original encoded MP4 independently; raw all-frame and selected AU2/AU5 planes,
fixture hashes, clocks and generator version are recorded in
`test/helpers/quality-forward-samples.json`. The production path never runs FFmpeg.

`test/media/quality-forward.test.ts` checks every dependent target against those
native frames, independent BigInt SSE/SSIM, live FFmpeg→registered media→explicit
cache→candidate HTTP→durable job→shared evidence→restart, fingerprint conflicts,
forged windows, duplicate/wrong PTS, dependency tag changes, read/packet/output
budgets, real reordered B-stream refusal and the historical 32/64 boundary (current ceilings are 512/1024).

The full Chromium/WebKit × H.2648/HEVC10 matrix uses **real GUI clicks** to submit
forward AU2/AU5, then checks Agent/job/result equality, actual Worker raw planes in
the original viewer, PSNR/SSIM/grid/ROI, shared evidence and import/export, identity
switch/lost-response fences, close/cancel/physical exit, cache rebuild/version
refusal, and independent playback A with no seek/restore. It is registered as
required in the existing core-backed `ci-ssim` job, alongside all four old SSIM
cases; identity CI remains core-free. The compiled native acceptance includes the
two forward fixtures on all three platform jobs with empty PATH and persistent
history/annotation restart checks. Functional acceptance does not certify playback
performance or resolve historical CI timeout causes.

The separate [packet-identity closed-GOP mode](reordered-frame-quality.md) supports
a bounded reordered/delayed subset using the fixed additive core ABI. This does
not alter the legacy forward mode, its provenance or admission rules.

Current AU ceilings come from `FORWARD_PAIR_LIMITS` in `shared/analysis/quality/frame-pair.ts`: 512 per side and 1024 inputs/outputs per pair. These are ceilings, not an admission guarantee; explicit request, memory, source-byte and elapsed-time budgets can impose smaller windows. Historical 32/64 evidence above describes the limits at the time of that run.
