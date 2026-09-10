# SDR software/native color evidence

This branch collects evidence before changing color conversion. It does not
implement a new rendering policy. The production decoder, presenter and WASM
core remain unchanged. Run on the Windows machine/browser exhibiting the issue,
with the same original files; another machine's result does not establish parity.

## Run locally

Requires Node 24+, `npm ci`, the pinned core files in
`public/vendor/voidplayer-core/` (use `scripts/sync-wasm-core.sh` or copy the
matching release's core), and Chrome/Edge. `ffprobe` on PATH is optional but
strongly preferred to collect independent decoded-frame tags. Run from repo root:

```powershell
node scripts/diagnose-sdr-color.mjs --channel msedge --out color-evidence --times-us 0,1000000 "D:\media\uhd5.flv" "D:\media\Third0T200uhd6.flv"
```

Use `--channel chrome` for installed Chrome. Without a channel, Playwright's
bundled Chromium must be installed; its HEVC availability may differ from Edge.
Default is headed. `--headless` is available, but label it as a different device
path from the user's interactive session. Choose steady scenes and extend times
only as needed (maximum eight positions and four files).

The local Vite server binds only 127.0.0.1. The file input gives the real Blob to
the application's FLV reader; the video is not uploaded. Reports remain in the
chosen local directory. `--images` explicitly opts into PNG captures in that
directory; inspect them before forwarding. Reports contain filenames, browser
details and codec metadata and may include error paths; redact private values.

## What is measured

- Git/build/core identifiers, actual browser version, secure context and
  cross-origin isolation; file size/mtime before and after the run.
- Independent FFprobe stream and first decoded-frame tags, when available.
- Same FLV through automatic native attempt and forced WASM packet decoding.
  Native fallback to WASM is **unavailable**, never a successful parity result.
  `webcodecs` and hardware acceleration preferences do not prove GPU execution.
- Requested versus actual source PTS, dimensions, actual frame descriptions,
  source color tags and the production presenter's conversion policy.
- A bounded page of local diagnostic events (capability probes, fallback reasons
  and presentation decisions). The current core ABI exposes source frame tags,
  not the actual swscale coefficient table; these tags alone do not prove the
  effective conversion parameters. That boundary remains a follow-up probe if
  the native/WASM comparison implicates conversion.
- Source-sized presenter capture in sRGB byte values, without diagnostic resize,
  exposure changes, retagging, or a second color-correction shader.
- RGB mean/min/max, exact 0/255 populations, RGB MAE/RMSE, maximum difference,
  differing pixels and signed mean channel differences (WASM minus native).

Comparisons require matching actual source PTS and dimensions within the same
file and exclude detected HDR. Metrics are evidence, not pass/fail color grading;
unknown tags remain unknown. Hardware implementations can have small rounding
differences. Capture excludes OS/ICC/display composition. A failed launch or
decoder/capture failure remains visible in `report.json`.

At most a native and WASM capture pair is retained for one requested time; captures
over 16M pixels are rejected. This is an explicit diagnostic, not a per-frame
playback logger. Pauses/seeks are exercised; continuous-playback parity and
full native/WASM GPU resource accounting remain separate validation work.

## Interpreting the evidence

1. Compare the **same HEVC file** between native and WASM. If it differs, first
   inspect per-frame range/matrix/transfer/primaries, then pixel differences.
2. Compare HEVC and VVC FFprobe/frame metadata. Equal filenames or apparent scenes
   do not establish equal decoded pixels or equal color signalling.
3. If HEVC matches across backends but VVC differs, compare source YUV and VVC
   metadata before changing the renderer. This harness does not auto-score
   different encoded files as a hardware/software parity test.
4. Range-related errors often affect black/white levels; matrix errors affect
   colored areas. These appearances are clues, not proof. Do not apply a
   brightness or saturation patch based only on screenshots.

## Refactoring decision

The current WASM path applies a swscale YUV matrix/range conversion before
delivering RGBA8; native frames use browser conversion. This split is established
by source inspection, but the cause of a particular SDR discrepancy requires
the evidence above. Metadata resolution and conversion provenance should become
one explicit contract regardless of which renderer is chosen.

If evidence implicates the conversion split, prototype retained YUV/bit depth
from WASM and tagged VideoFrame construction through the same presentation path.
Capability-test pixel layouts and validate reference patterns before choosing it.
Opaque hardware resources mean a native Metal design cannot simply be copied into
WebGL. A deterministic custom high-precision renderer is a separate, larger
decision; this diagnostic does not assume it is already required.

References: [existing Web contract](color-pipeline.md),
[native contract](https://github.com/Nakiha/VoidPlayer/blob/881eb5ccd706c33aa1ff35ab3a67ac3a226ccfba/native/docs/COLOR_PIPELINE.md).
