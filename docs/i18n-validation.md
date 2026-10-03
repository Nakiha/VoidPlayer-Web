# Issue #38: Mac validation

Baseline is untouched main `83de4b039a2c13fdea44ce4ad35abcd282264589`. The isolated baseline and feature checkouts use the same Mac (Apple M5, arm64), Node 24.15.0, Vite 8.2.2, TypeScript 7.0.2, Playwright/browser binaries and identical core/media files. Original checkouts and running services were not changed. Both distributions are production builds. No original assertions, case coverage or playback thresholds were weakened.

The implementation covers 664 extracted messages, all UI modules, complete settings, shell and track controls, plus sources/workspaces/annotations/analysis. Explicit exclusions are in [localization](localization.md) and `locales/scope.json`: connection guide/admin and raw diagnostic reasons remain Chinese; user data/log JSON and stable machine values are preserved deliberately.

## Verified behavior

- `fast`: 30/30 registered cases; `contract`: 10/10. Seven new Node assertions cover normalization, stale requests, failure/retry, compiled fallback/cache, ICU parameters, typed descriptors, escaped user values, stable diagnostic stages, deterministic generation, stale/missing catalog rejection, scope completeness and translation-free media/progress dependency graphs.
- `ci-i18n`: Chromium and WebKit state-preservation and long-text cases, 4/4. Live switching preserves canvas, worker count, media/source generation, selected track, inspector/dock/mark nodes, playing position, open settings/menu, input values, focus and selection. It issues no seek/pause/reload. Tests cover unsaved offsets, workspace name and feedback text, raw user marks, real tooltip relabeling, rapid choices, delayed cold responses, blocked English chunk and same-page retry, refresh persistence and browser/stored locale precedence.
- Expanded pseudo text: every settings pane at 1280/600/390/320px in both engines. Strict bounds and text-clipping assertions found and drove fixes for language/workspace/log/identity controls. CJK and English screenshots were visually inspected. Long edge labels use vertical color-flow steps while preserving nodes.
- Existing player/analysis/identity/saved-workspace/sharing/theme/menu/metadata/settings/feedback/annotation/recovery and logging regressions passed across their applicable Chromium/WebKit cells. Final broad batch passed 17/18; the remaining Chromium library-pagination cell also fails untouched baseline at `check-library-browser.mjs:69` waiting for 60→70 rows. WebKit’s complete library case passes. This baseline limitation remains explicitly visible; its assertion was not removed or relaxed.

## Initial paired performance evidence

Three cold contexts and three same-context warm reloads per browser locale and distribution. Startup ends at `window.voidPlayer.tools`; resource accounting includes emitted assets, theme CSS and theme-init. gzip is an offline estimate: the isolated local static server serves uncompressed bytes. Language timing records click handler to lang-mutation delivery after synchronous UI updates; click-to-ready is reported separately because it includes Playwright scheduling. Playback uses the application’s unchanged `benchmark_review`, three 4-second repetitions per distribution, H.264 `h264_9s_1920x1080.mp4` + HEVC `h265_10s_1920x1080.mp4`, visible page at 1280×800. Physical screen scanout and hardware-decoder use are not inferred.

| Initial locale | Baseline raw / gzip | Feature raw / gzip | Asset requests |
| --- | ---: | ---: | ---: |
| Chinese | 1,005,275 / 299,469 B | 1,069,879 / 314,945 B | 28 → 30 |
| English browser | 1,005,275 / 299,469 B | 1,107,697 / 326,371 B | 28 → 31 |

The Chinese gzip increase is about 15.1 KiB; English adds about 11.2 KiB beyond Chinese. Predeclared budgets are +32 KiB/+3 requests for Chinese, +48 KiB/+4 requests for English, median startup ≤ baseline×1.3+100ms, cold locale commit ≤250ms and cached commit ≤100ms. Existing playback limits remain speed≥0.9, frame lag/skew≤100ms, p95 draw gap≤75ms, maximum gap≤250ms and pause≤100ms.

WebKit cold startup medians were 196.2→197.0ms (Chinese) and 194.6→188.0ms (English); warm medians were 69.4→70.4ms and 68.2→68.3ms. All six playback runs passed at about 0.999× speed. Chromium with WindowServer also passed all six mixed-media runs at about 1.0×; its TaskDuration medians were about 655→746ms over the benchmark interval, with sizable run variation. These are overhead observations, not an optimization claim. Headless Chromium selected FFmpeg WASM for HEVC and failed the unchanged real-time floor in both baseline and feature, around 0.67×; all raw failed results are retained.

The draft is reviewable now. Final isolated-distribution reruns and the supported Chromium H.264-only comparison are being completed; the performance harness now snapshots each dist into its owned temporary server directory so another build cannot remove files during measurement. An earlier concurrent-build ENOENT run is excluded from quantitative conclusions. Detailed final results will update this document and the evidence JSON before handoff.

## Actual UI captures

![English playback and cached inspector](evidence/i18n/playing-en.png)
![Chinese labels and preserved source](evidence/i18n/playing-zh.png)
![English settings](evidence/i18n/settings-en.png)
![Expanded pseudo text in a narrow window](evidence/i18n/pseudo-performance-390.png)

Machine-readable UI assertions are in [Chromium](evidence/i18n/chromium-ui.json) and [WebKit](evidence/i18n/webkit-ui.json). The working directory retains complete `.run/i18n-*` suite logs/screenshots and `.run/i18n-performance/*.json` paired reports. Linux/Windows behavior remains for CI; this report only claims the actual Mac validation above.
