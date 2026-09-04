# VoidPlayer browser experiment

Standalone, local-file video review prototype on `codex/web-version`.
It does not build or call Flutter, native C++, a local media service, or WASM.
The web bundle can be served as static files over HTTPS; localhost is for development.

## Run

```sh
cd browser
npm ci
npm run dev -- --port 5178 --strictPort
```

Open http://127.0.0.1:5178/. Choose video A, then B. Playback is silent.
Drop one file onto a video pane to replace that track; elsewhere it fills A,
then B. Drop two files together to load A and B in the supplied order. More than
two files are rejected. Loading proceeds in order; if the second file fails,
the successful first load remains and the old second source is preserved.
Use the shared timeline, left/right arrows to step against A, and Space to play/pause.
The sidebar button opens annotations; drag on a paused frame to select a region.
Export before closing: annotations currently live only in memory.

The interface follows the desktop player's edge-to-edge layout, with compact
macOS-style controls and the system light/dark preference. Unsupported desktop
features are omitted rather than presented as nonfunctional controls.

## Implementation and boundaries

- `src/media.ts`: Mediabunny `BlobSource` (default 8 MiB byte cache), demuxing,
  WebCodecs capability detection, actual decoded samples and explicit release.
- `src/session.ts`: a shared session for UI and agents; newest-request-wins
  mutations, synchronized seek, actual frame stepping, annotations and exports.
- `src/main.ts` / `src/style.css`: DOM controls, canvas viewports and region picking.
- `src/agent.ts`: feature-detected imperative WebMCP tools using the same session.

Time values are integer microseconds. Each file's first video timestamp maps to
session time zero. The comparison ends at the shorter track. Stepping uses the
reference frame's duration and decoded timestamp, not an assumed frame rate.
Rounding is handled at sub-microsecond boundaries. Other tracks are sampled at
the selected reference frame's start, which matters when frame rates differ.
This is reference-track stepping, not the native fair/greedy multi-track planner
in `native/renderer/track/track_step_policy.cpp`. That planner considers candidate
timestamps across tracks, maximizes the number that can step legally, and breaks
ties by temporal proximity in the chosen direction. Its lookahead, offsets and
presentation-commit semantics have not been ported to this browser experiment.

Seek resolves after every loaded track decodes and draws its selected frame to
canvas. `frameEvidence: decoded-and-drawn-to-canvas` does **not** certify OS display
scanout. The requested timeline position may differ from a frame's start timestamp.
Playback follows elapsed wall time and may skip frames; it is a correctness
prototype, not a guaranteed real-time multi-track scheduler. Decoding currently
runs through sparse sample retrieval on the main JS thread; sequential buffering
and workers are follow-up performance work.

Files are not uploaded or transcoded. There is no universal codec fallback.
Browser-managed color, HDR, audio, 4K performance, large-file memory behavior,
codec coverage and cross-browser equivalence are not certified by this prototype.
The renderer requests a default Canvas 2D context; it does not configure an HDR
output surface or implement the native HDR/color pipeline. Decoding an HDR input
successfully must not be interpreted as validated HDR display output.

Exports use `schema: voidplayer-web-review`, version 1. IDs are session UUIDs plus
file metadata, **not content hashes**. A mark records its target media, source and
relative frame timestamps, normalized region, severity, origin, and comparison
frames from both tracks. Replacing a track preserves existing annotation lineage.
This format is not claimed to be compatible with the desktop marks importer.

## Agent surface

`window.voidPlayer` exposes `getState()`, `loadFile('A' | 'B', File)`, `seek(ptsUs)`,
`step(-1 | 1, slot)`, `play()`, `pause()`, `addMark(input)`, `deleteMark(id)`, and
`exportReview()`. File access requires user selection or an existing File object;
an agent cannot load arbitrary local paths through the page.

When the browser provides `document.modelContext` or `navigator.modelContext`,
these tools are registered: `get_review_session`, `seek_review`, `step_review`,
`pause_review`, `add_review_mark`, `export_review`. Inputs are validated at execution;
filenames and note text are untrusted data. Standard DOM controls remain usable
when WebMCP is unavailable. Export tools return JSON without starting a download;
the visible Export button downloads the same document.

## Verification

```sh
npm test
npm run build
python3 test/generate-fixtures.py
```

The generator requires ffmpeg only for **development fixtures**, not for users.
Files under `fixtures/` and `dist/` are ignored by Git.

Unit coverage: VFR stepping, fractional 30 fps boundaries, different-rate backward
alignment, canceled seeks, replacement failures, resource release, mark lineage,
input validation, per-class media load diagnostics and the WebMCP action contract.

Manual browser regression using the generated files:

1. Load A=`a.mp4` (30 fps) and B=`b.mp4` (24 fps). Confirm actual nonblank frames.
2. Seek to 1,000,000 µs, step forward on A: A=1,033,333 µs, B=1,000,000 µs.
   Step backward: both frames and session position return to 1,000,000 µs.
3. Play/pause; verify time advances and remains still after pausing.
4. Draw a region, add a human note, add an agent note, export and compare frame anchors.
5. Invalid seek/slot/note parameters must fail without adding marks or changing media.
6. Replace B with `invalid.mp4`: show a failure and preserve the previous source.
7. Replace A with `vfr.mp4`; step across the 30-to-15 fps transition using actual PTS.

A successful build is not evidence for codec/visual/browser compatibility.

Verified on 2026-09-05 in the macOS Codex in-app browser: both generated H.264
videos rendered; mixed-rate forward/backward stepping returned the expected PTS;
playback advanced; pause retained the frame; the VFR transition used the decoded
frame duration; an invalid replacement preserved the previous source. All six
WebMCP tools registered, and invalid parameter probes were rejected. A real
pointer drag and form submission produced a human mark with a normalized region;
an agent mark and the JSON export retained both tracks' matching frame anchors.
All 10 unit tests and the production build passed.

Download verification remains open: clicking Export produced no page error, but
the in-app browser did not report a download event or save the file in Downloads.
The JSON returned by `export_review` was verified; this does not establish that
the visible download action works in a regular browser. Safari/Chrome download,
HDR, audio, large files and sustained performance still need separate verification.

File-drop follow-up: all 14 tests and the build passed. Event-handler tests cover
slot routing, file-list snapshotting, navigation prevention, overflow rejection,
nested drag feedback and cleanup. The shared file-picker import path rendered a
real fixture in the in-app browser. An OS Finder-to-page drag remains unverified:
the available browser automation API has no external-file drag injection action.

Sample compatibility, verified on 2026-09-05 against `resources/video/` (14
files) via the file picker in the macOS Codex in-app browser: 8 loaded and
rendered — H.264 (both 1080p samples), H.264 High 4:2:2, HEVC (`hev1` in MP4
and MKV, including the full-range BT.709 sample), AV1 and VP9 in WebM. 6 failed:
4 FFV1 MKV, 1 H.266/VVC MP4 and 1 MPEG-2 TS. The failures are codec/library
gaps, not container gaps: Mediabunny identifies the MP4/MKV/WebM/TS containers,
but exposes no decodable track for FFV1 or VVC, and skips the MPEG-2 TS video
stream entirely. Whether these reach the decoder is browser-dependent; HEVC and
4:2:2 H.264 decoded in this browser and may not elsewhere. `src/media.ts` now
reports each case distinctly (unrecognized container, container recognized but
no readable video track, known-but-unsupported codec, codec unsupported by the
browser) instead of `unknown` or a blanket "no video track"; `test/media.test.ts`
locks these diagnostics per failure class.
