# VoidPlayer browser experiment

Standalone, local-file video review prototype on `codex/web-version`.
It runs without Flutter or a local media service; unsupported browser codecs use
the bundled FFmpeg WASM decoder in the page.
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
Use the shared timeline, left/right arrows to step every track by one fair frame
step, and Space to play/pause.
The sidebar button opens annotations; drag on a paused frame to select a region.
Export before closing: annotations currently live only in memory.

The interface follows the desktop player's edge-to-edge layout, with compact
macOS-style controls and the system light/dark preference. Unsupported desktop
features are omitted rather than presented as nonfunctional controls.

## Implementation and boundaries

- `src/media.ts`: Mediabunny `BlobSource` (default 8 MiB byte cache), demuxing,
  WebCodecs capability detection, actual decoded samples and explicit release.
  Tracks mediabunny cannot demux or WebCodecs cannot decode fall back to
  `src/ffmpeg-media.ts`: the self-built trimmed FFmpeg WASM core (`n9.0.1`,
  ~4.7 MB, from the `VoidPlayer-FFmpeg-Build` repo's `wasm` branch; synced into
  `public/vendor/voidplayer-core/` by `scripts/sync-wasm-core.sh`, fetched
  lazily on first need). Besides FFV1/MPEG-2/VVC it also carries H.264, HEVC,
  VP8 and VP9, because browsers support those codecs only in specific profiles
  (e.g. H.264 High 4:2:2 fails WebCodecs everywhere and must fall back).
  The core links libavcodec/libavformat/libswscale
  directly (no CLI) and exposes a `vp_*` API: a demux-only frame index (packets
  carry pts/duration/keyframe flags), then exact-PTS extraction with
  decoder-state continuation — sequential stepping decodes each frame once,
  backward/random steps pay at most a GOP re-decode, and a seek that overshoots
  retries from the start. Output is RGBA via swscale with the tagged
  colorspace/range honored (BT.601/709 guess for untagged). The core runs in a
  Web Worker (`src/ffmpeg-worker.ts`) with transferred pixel buffers, so decode
  never blocks the UI thread. Fallback limits: the whole file is copied into
  WASM memory (512 MiB cap), output is 8-bit, no 10-bit/HDR fidelity, and no
  audio is decoded. Fallback tracks show `WASM` next to the codec.
- `src/session.ts`: a shared session for UI and agents; newest-request-wins
  mutations, synchronized seek, actual frame stepping, annotations and exports.
- `src/main.ts` / `src/style.css`: DOM controls, canvas viewports and region picking.
- `src/agent.ts`: feature-detected imperative WebMCP tools using the same session.

Time values are integer microseconds. Each file's first video timestamp maps to
session time zero. The comparison ends at the shorter track. Stepping ports the
fair multi-track planner from `native/renderer/track/track_step_policy.cpp`:
candidate targets are the loaded tracks' decoded successor (or predecessor) frame
starts, a candidate is invalid when any track would skip an intermediate frame or
jump a gap beyond 1.5× the minimum current frame duration plus 2 ms, and among
valid candidates the planner maximizes the number of stepping tracks (ties break
toward the earliest forward or latest backward target). Tracks the target does
not move keep their current frame; it is never re-resolved by time. Successors
are true presentation-order samples from Mediabunny's sample iterator, so VFR
and timestamp gaps do not rely on duration arithmetic. One divergence from the
native planner: the browser decodes lookahead on demand, so a missing next-next
frame means the track's last frame and may still be landed on, where the native
planner treats a lookahead miss as unprovable and rejects the candidate. The
native lookahead budgeting, track offsets and presentation-commit semantics are
not ported.

Seek resolves after every loaded track decodes and draws its selected frame to
canvas. `frameEvidence: decoded-and-drawn-to-canvas` does **not** certify OS display
scanout. The requested timeline position may differ from a frame's start timestamp.
Playback pulls sequential presentation-order frames from each track's own stream
(`MediaSource.framesFrom`: mediabunny's pre-decoding sample iterator, or the WASM
core's decoder-state continuation), so each frame is decoded once. Presentation
follows the wall clock and drops late frames in favor of the newest decoded one;
it is still not a guaranteed real-time multi-track scheduler. WASM fallback
decode runs in a worker; WebCodecs decode is threaded by the browser, but
canvas presentation stays on the main thread.

Files are not uploaded or transcoded for upload; fallback tracks are decoded
locally by the WASM core. Browser-managed color, HDR, audio, 4K performance,
large-file memory behavior, codec coverage and cross-browser equivalence are
not certified by this prototype.
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
`step(-1 | 1)`, `play()`, `pause()`, `addMark(input)`, `deleteMark(id)`, and
`exportReview()`. File access requires user selection or an existing File object;
an agent cannot load arbitrary local paths through the page.

When the browser provides `document.modelContext` or `navigator.modelContext`,
these tools are registered: `get_review_session`, `seek_review`, `step_review`,
`pause_review`, `add_review_mark`, `export_review`, `get_review_logs`, and
`list_review_log_sessions`. Inputs are validated at execution;
filenames and note text are untrusted data. Standard DOM controls remain usable
when WebMCP is unavailable. Export tools return JSON without starting a download;
the visible Export button downloads the same document. `step_review` takes only
`direction`; stepping is fair across all loaded tracks, not per reference track.

## Verification

```sh
npm test
npm run build
python3 test/generate-fixtures.py
```

The WASM integration tests need the vendored decoder core (gitignored);
fetch it with `bash scripts/sync-wasm-core.sh` after building the
`VoidPlayer-FFmpeg-Build` repo's `wasm` branch, or set `WASM_CORE_DIR` to an
existing `voidplayer-ffmpeg-wasm-*` dist directory.

The generator requires ffmpeg only for **development fixtures**, not for users.
Files under `fixtures/` and `dist/` are ignored by Git.

Unit coverage: VFR stepping, the fair forward/backward step planners (multi-track
preference, skip prevention, gap rejection, end-of-stream), canceled seeks,
replacement failures, resource release, mark lineage, input validation, per-class
media load diagnostics, the WebMCP action contract, and the FFmpeg WASM fallback
(index navigation, plus real-WASM decoding of the FFV1, 10-bit FFV1, MPEG-2 TS
and H.266/VVC samples in Node against the vendored n9.0.1 core).

Manual browser regression using the generated files:

1. Load A=`a.mp4` (30 fps) and B=`b.mp4` (24 fps). Confirm actual nonblank frames.
2. Seek to 1,000,000 µs, step forward: the fair target is 1,041,667 µs so both
   tracks step — A shows its 1,033,333 µs frame, B its 1,041,667 µs frame.
   Step backward: both frames and the session position return to 1,000,000 µs.
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
locks these diagnostics per failure class. The 4 FFV1 samples, the MPEG-2 TS and
the H.266/VVC sample now load through the self-built WASM fallback (see below),
so all 14 samples open; H.266 requires the n9.0.1 core's native VVC decoder.

Fair-step follow-up: the greedy multi-track step planner was ported from
`native/renderer/track/track_step_policy.cpp` on 2026-09-05. All 26 unit tests
and the production build passed, including planner-level coverage of multi-track
preference, intermediate-frame skip prevention, gap rejection, end-of-stream
no-ops and predecessor validation, plus session-level two-track stepping. The
WebMCP `step_review` tool dropped its `slot` input; stepping is now fair across
tracks. Real-file browser verification of the new stepping (manual regression
steps 2 and 7) has not been rerun in this round.

FFmpeg WASM fallback follow-up (2026-09-05): tracks mediabunny/WebCodecs cannot
handle now fall back to a lazily loaded `@ffmpeg/core` (FFmpeg 5.1.4). Verified
in Node against the same core build the browser loads: all four FFV1 samples and
the MPEG-2 TS index and decode frame-exactly (real PTS, dimensions and pixel
counts asserted), 10-bit FFV1 converts to RGBA, and the H.266 sample still fails
closed with the accurate load error. All 33 tests and the production build
passed; the wasm stays a lazily fetched asset outside the main bundle. Browser
rendering of a fallback track (putImageData path), main-thread decode latency on
inter-frame codecs, and playback smoothness under the fallback remain unverified
in a real browser.

Self-built core follow-up (2026-09-05): the fallback switched from the stock
`@ffmpeg/core` (FFmpeg 5.1.4, 32 MB) to the trimmed self-built `n9.0.1` core
(~2.6 MB) from `VoidPlayer-FFmpeg-Build` branch `wasm`, and from CLI emulation
to the direct `vp_*` API. The frame index is demux-only (VVC indexing dropped
from ~21 s to milliseconds) and extraction keeps decoder state for sequential
steps. Measured in Node: MPEG-2 TS stepping ~2.6 ms/frame, H.266 ~34 ms/frame,
mid-file random seek ~0.4 s (TS) / ~2.2 s (VVC). All 14 `resources/video/`
samples now open, including H.266/VVC; 31 tests and the production build pass.
Fallback rendering in a real browser (putImageData path) remains unverified.


## Diagnostic logging

The toolbar's **日志** button opens the current and retained diagnostic sessions.
Select a session, then download its JSON or copy it; **查看内容** also exposes the
full text for manual selection when the host browser blocks downloads or clipboard
access. Export records a download request, not proof of a file being written.
Nothing is uploaded automatically.

- Structured events carry a monotonic sequence and relative time within a UUID
  session, plus its start time, browser capabilities and build revision/timestamp.
- UI/API/Agent requests get operation IDs, parent IDs, source, duration and a
  completed/failed/cancelled outcome. Session transitions and media decoder
  selection/fallback reasons use the same journal. File selection, drops,
  cancelled pickers, keyboard actions, form changes and region gestures are
  recorded. Input fields record committed changes; note bodies are omitted.
  Pointer moves, individual keystrokes and every displayed frame are not logged.
- Each session retains 2,000 events. IndexedDB keeps at most three sessions,
  pruning records older than seven days when the page next saves. Payloads are
  detached, depth/size limited and normalize errors, cycles and byte buffers.
  File names and metadata are included; file bytes and note text are omitted.
- Writes are coalesced for 250 ms and requested on errors, hiding or leaving the
  page. This is best-effort durability: abrupt termination, main-thread blocking,
  browser eviction or private-mode restrictions can lose unsaved tail events.
  Storage failure is visible in the dialog; in-memory reading/export still works.
  Persisting diagnostics does not restore media handles or annotations.
- `list_review_log_sessions` returns session IDs, retention counts and storage
  status. `get_review_logs({ sessionId, sinceSeq, level, limit })` returns events
  in ascending order, `nextSeq`, `hasMore`, and `gap` for evicted history. Continue
  with the same session ID and `sinceSeq: nextSeq`. Query arguments are validated
  at execution. Successful read-only polling does not generate further events.
- `window.voidPlayer` also exposes `getLogs(query)`, `listLogSessions()` and
  `exportLog(sessionId?)`. Export schema: `voidplayer-web-log`, version 1.

Verification for the logging follow-up: 44 tests pass, including chronological
paging, filtering, eviction gaps, immutable payloads, operation correlation,
redaction, retained-session recovery, quota failure/retry and overlapping writes.
In the real in-app browser, file open, UI step and Agent seek emitted correlated
records; repeated log polls stayed quiet; refreshing recovered the previous
session from IndexedDB. The dialog showed the generated JSON and real build
metadata. Download did not produce a browser download event. Clipboard writing
reported success, but the automation clipboard readback was empty; neither OS
file delivery nor clipboard contents are claimed as verified. The visible JSON
and Agent-readable historical logs were verified independently.

## Optional media-library service

`browser/server/` is a small zero-dependency Node service (Node 22+) exposing
whitelisted host folders over a narrow API: `GET /api/library` lists
media files, `GET /api/media/<id>` streams bytes with HTTP Range support, and
the built frontend in `dist/` is served when present. The single write
endpoint is `POST /api/logs`: a problem log is stored under `logs/` only when
the user explicitly clicks "上传到服务器" in the log panel (disable with
`--no-logs`, relocate with `--logs-dir`). It never transcodes, binds localhost
by default, and resolves media ids back through the whitelist with realpath
checks.

```sh
npm run build
npm run serve -- --folder /absolute/path/to/videos [--folder ...] [--port 5180]
# then open http://127.0.0.1:5180/
```

During `npm run dev`, vite proxies `/api` to 127.0.0.1:5180, so run the service
alongside the dev server. The app works fully without the service; the library
button then reports that no service is connected. Library items play through
mediabunny's `UrlSource` with range requests (no whole-file download) on the
WebCodecs path; the WASM fallback still fetches the whole file into memory —
streaming AVIO for the fallback is follow-up work. The Agent surface gains
`list_library` and `load_library_item`.

Service coverage: library scanning (hidden/non-media skipped, depth and count
caps), id resolution refusing malformed/traversal ids, full/ranged/suffix/416
responses, HEAD, read-only method enforcement, and a real end-to-end range
stream of the 19 MB H.264 sample demuxed by mediabunny off the live server.

## Playback performance and acceptance

Playback uses independent per-track decode producers with queues capped at four
frames. Canvas presentation runs on requestAnimationFrame; DOM updates run at
10 Hz. The common clock advances only through decoded coverage on both tracks.
When decoding cannot sustain real time, playback slows honestly; it does not run
the timeline to the end while showing stale frames. Exact paused stepping still
uses the fair multi-track planner. Pause cancels scheduling, releases queued
frames and discards pending decoder results without drawing them.

WASM runs in one worker per track. The frame index stays in the worker; extraction
messages carry only an index and an optional recycled pixel buffer. Cross-origin
isolation enables an attempted pthread core; initialization has a 5 s timeout and
single-thread fallback. All subsequent RPCs have a 15 s timeout; failure or worker
termination rejects pending work. `coreVariant` records the actual selected core.

**The old offscreen position-ratio benchmark is not acceptance evidence.** It
measured a wall-clock-driven timeline, selected the best FPS window and did not
fail its exit status on slow/janky playback. Earlier numbers from that harness
must not be used to claim smooth or synchronized playback.

Use **? → 检查当前视频播放性能** on the actual page with the desired media loaded.
The check includes a mid-playback pause/restart, then plays for eight seconds or
to clip end. It leaves playback paused and shows a copyable JSON report. The same
function is available through `benchmark_review({ durationMs: 8000 })` and the
matrix runner; there is no separate synthetic playback implementation.

Reports include actual canvas draw counts/full-run FPS, frame interval p95/max,
media-time/wall-time speed, decoder waiting time, maximum frame lag and track
skew, pause latency and stale presentation checks. They record the actual decoder
variant, source metadata, viewport, page visibility, isolation capabilities and
build source digest and WASM binary fingerprints. Unsupported Long Tasks observation is `null`, not zero.
These are canvas presentation measurements, not physical display scanout proof.

Default acceptance requires at least 1 s of evidence, speed >= 0.9x, frame lag
and track skew <= 100 ms, p95 frame intervals <= 75 ms, maximum interval <= 250 ms,
and pause <= 100 ms with no stale frames. Backgrounding, interruption, media
replacement, premature end and playback errors fail the run. These are usability
thresholds for the current 24–60 fps review samples, not an HDR or color guarantee.

```sh
# Existing service must serve a fresh dist build and the resources/video folder.
npm run build
node scripts/bench-playback.mjs chromium
node scripts/bench-playback.mjs webkit
# BASE_URL, BENCH_REPEATS (default 3), BENCH_DURATION_MS (default 8000).
# --headless explicitly labels synthetic runs; do not equate them to the user's host.
```

The runner uses visible pages by default, repeats replacement/playback in the
same page, and has a watchdog covering navigation, media load and playback. Any
failed or missing scenario makes its exit code nonzero. Its standalone browser
matrix must be rerun on the target browser; the tests below used the user's
Codex in-app browser through Computer Use, not the standalone Playwright runner.

Verified 2026-09-05, macOS in-app browser, visible viewport 613×797 at DPR 2:

| Scenario | Repetitions | Actual FPS A/B | Playback speed | Max frame lag |
| --- | --- | --- | --- | --- |
| VVC 1080p + HEVC 4K | 3, to 3 s clip end; VVC replaced between runs | 59.16–59.32 / 59.16–59.32 | 0.990–0.993x | 20–25 ms |
| MPEG-2 TS + H.264 | 3 × 8 s | 59.88–59.91 / 59.88–59.91 | 0.998–0.999x | <17 ms |
| VVC 1080p, production build, visible Help button | 1 × 8 s | 59.90 / — | 0.999x | <17 ms |

These runs selected the multi-thread WASM core for VVC/MPEG-2 and WebCodecs for
H.264/HEVC, passed synchronization/pause checks, and rendered a nonblank VVC frame
verified by screenshot. The dev and production reports shared source digest
`30ccdc3f75d2eb9bb81e9030d155a9ab87f7722c6d3877c7d286ecc3c3817fef`
(before final report labels/metadata adjustments). They do not establish results
for other browsers, single-thread fallback, long-form media or hour-long sessions.

Regression tests cover late decode after pause, final-frame completion under slow
decode, independent producers, bounded queues and cleanup, wedged/terminated
worker RPCs, and benchmark rejection of falsely healthy timelines/stalled frames.
