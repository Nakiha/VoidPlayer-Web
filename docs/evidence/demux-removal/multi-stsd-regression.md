# Multi-stsd playback regression and repair

The MP4 demux migration exposed a previously supported playback regression on
Mac WebKit. The comparison uses identical FATE fixture bytes and the existing
headless FATE frame, RGB fingerprint and seek assertions. Main is
`c787553ed98818085fc49fc6cdc400a6ebd2261e`; `f4ae559` is an earlier PR head,
not a main baseline.

| FATE sample | Native reference and main local output | Failing PR WebKit native output |
| --- | --- | --- |
| `h264/extradata-reload-multi-stsd.mov` | Four frames at 0/40/80/120 ms; 256×128 twice, then 128×128 twice | Sometimes only the latter two frames, first source PTS 80 ms |
| `hevc/extradata-reload-multi-stsd.mov` | Four frames at 0/40/80/120 ms; 128×128 twice, then 128×256 twice | Sometimes only the latter two frames, first source PTS 80 ms |

Main local playback passes both samples using software decoding. Main WebKit
remote playback reports its existing cross-origin-isolation resource rejection;
that result is not counted as a successful remote comparison.

Mediabunny's track-level decoder configuration describes the last stsd entry,
while the JS packet table correctly maps samples to `[0, 0, 1, 1]`. Supplying
that configuration at startup can discard the initial segment. An experiment
using the first configuration restores count and geometry, but WebKit native
RGB fingerprints still differ by approximately 28–30 regional channel levels.
Those native pixels have not passed acceptance.

The repair preserves main's conservative software decoding for multi-stsd,
using the existing JS sample table and packet-fed WASM decoder. Configuration
changes drain and reconfigure the packet decoder. No FFmpeg container demuxer
is involved. Native multi-stsd remains unavailable pending per-entry metadata
and pixel validation; the files remain fully playable.

Validation retains all original assertions: both codecs × Chromium/WebKit ×
local/remote × two opens pass all four frames, RGB fingerprints and forward/
backward seeks. Node compares every actual visible plane at 0/40/80/120/0 ms
to independent pinned native9 seek/decode output, including both dimensions.
The native policy regression fails before the repair and passes afterward.

Focused reproduction uses `node scripts/check-fate-browser.mjs --engine=webkit --sample=h264/extradata-reload-multi-stsd.mov` (one shell command). Omit both
filters for the unchanged complete CI matrix. Detailed Mac logs remain in
`.run/ci-final-repair/`: `fate-browser-baseline.log`, `fate-browser-f4.log`,
`stsd-policy-before.log`, `stsd-pixels-final.log`, and the four
`stsd-policy-{webkit,chromium}-{h264,hevc}.{log,json}` reports.
