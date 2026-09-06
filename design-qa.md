# VoidPlayer Web UI QA — 2026-09-06

> 历史验证记录：各节结论仅适用于当时的版本，不作为当前 UI 规范。
> 当前约定见 [主题与交互说明](src/themes/README.md)。`.design/` 中的截图已按用户要求删除，保留基准 JSON 和文字记录。

Recorded result at the time: passed. Sections below retain the sequence of earlier visual and interaction checks.

## Visual truth and state

Source: `/Users/zhuhongwei/.codex/generated_images/01a06e9a-1270-76c1-b812-b9b20a39c418/exec-52e1904e-9bef-4469-87ab-756d52ff0c6e.png` (1487×1058 pixels).
Original user reference: `/var/folders/j5/x39dhv0n7h720pfxwzx7_mw00000gn/T/codex-clipboard-673e7d44-1825-4f37-ba72-74856afaa91f.png`.
Implementation: `http://127.0.0.1:5178/`, `.design/2026-09-06/08-borderless-expanded.png` (1487×1058 capture, CSS viewport 1487×1058; browser DPR 2, screenshot delivered at CSS dimensions).
Responsive evidence: `.design/2026-09-06/10-borderless-narrow.png` (480×760 capture and CSS viewport).

Compared source and full implementation together in one image inspection, followed by source, inspector detail and narrow capture together. The attempted inspector clip (`09-inspector-detail.png`) was scaled unexpectedly by the capture provider and is not used for pixel measurements. Labels, values, hierarchy and outlines are readable in the full desktop and narrow captures. No claim of pixel-identical typography or antialiasing is made.

Desktop state: real H.264 and H.265 1080p media, paused at 4.266667 s, all three panels expanded, one temporary UI-created annotation. Real video frames and metadata differ from the generated reference, which contains illustrative values and different image crops. Temporary annotation was subsequently deleted and the default folded workspace restored; viewport override reset.

User corrections supersede the source: tighter density, themed viewport matte, sparse resolution grid, annotation entry only in the bottom panel, no repeated row outlines or nested cards.

## Findings and iteration history

No remaining actionable P0/P1/P2 findings within this UI pass.

- Resolved P2 — excessive density/padding mismatch: compact toolbar (40px), transport (38px), inspector/source widths (200/240px), subtrack rows (32px). Compare the generated source with `08-borderless-expanded.png`; extra viewport space is intentional.
- Resolved P2 — black viewport matte disconnected from silver tool surfaces: theme-controlled silver matte and untouched decoded video; `04-expanded.png` precedes correction, `05-resolution-grid.png` and `08-borderless-expanded.png` show the result.
- Resolved P2 — abstract 256px grid: 640×360 source-pixel reference cells; 1080p=3×3, 4K=6×6, adaptive merging at small scales. `05-resolution-grid.png` compares real 1080p and 4K sources.
- Resolved P2 — repeated property/list/track row rules and duplicate annotation entry: removed left/top annotation buttons and row borders. `07-final-expanded.png` is the earlier state; `08-borderless-expanded.png` shows borderless controls and rows. DOM inspection confirms both removed entry IDs absent and all inspector dt/dd bottom borders 0px. Bottom creation and deletion both verified.
- Resolved P2 — narrow side drawer bottom incorrectly subtracted dock height twice: drawer now reaches the comparison area's bottom. In the final 480px check both source panel and transport end at y=632; scrollWidth=480 and left inspector is hidden when right drawer opens. See `10-borderless-narrow.png`.
- Resolved P2 — split divider had zero-width keyboard target: 28px target retains 1px visible divider. Keyboard ArrowRight verified 50→55 in the earlier interaction pass.

## Required fidelity surfaces

- Typography: system UI font, 11–13px data/control text, 14–15px titles; compact weights, aligned numeric values and filename truncation. Smaller than the source per user density request. No font substitution or invented display lettering.
- Spacing/layout: no outer page gutter; independent left/right/bottom regions; compact group spacing rather than larger cards. Narrow mode overlays one side drawer and keeps the bottom tool region reachable. Expected desktop-tool density, not a separate touch-first mobile design.
- Colors/tokens: silver palette, background fills, sparse pane seams, selected blue fill and neutral unselected tracks. Default controls have no outline; editable dialog fields and keyboard focus retain boundaries. Theme tokens include surfaces, divider, control border width, typography and density. Increased contrast restores control outlines. Native Liquid Glass optical refraction is not claimed.
- Image quality: real decoded canvas content remains in its original aspect ratio without UI tint/filter; grid is a background canvas behind video. Source photo crop mismatch is expected and should not be copied into actual media rendering. Phosphor library icons are used consistently.
- Copy/content: concise tool labels, no promotional/demo prose. Actual metadata only; unreported color metadata says 未标记. Current-frame quantization is separate from the displayed 0ms additional offset. No invented bitrate, bit depth or audio/subtitle streams.

## Functional validation

- Latest build passed; existing worker_threads browser externalization warnings remain.
- Earlier visual-pass tests: 87 passed, 0 failed (unit models and actual WASM sample decoding included).
- Latest UI: load A/B, seek, panel toggles, bottom-only annotation creation and deletion, inspector metadata, narrow source drawer and no horizontal overflow. Page diagnostic error events: empty. No separate browser-console sweep in this final pass.
- Earlier pass: local multiple-file chooser, available/recent source management, source A/B actions, playback/step, pan/zoom, split keyboard target, bottom resize keyboard controls.
- Earlier actual-page playback smoke: `.design/2026-09-06/benchmark-grid-mixed.json`, H.266 WASM + 4K HEVC with grid and all panels open, about 59fps and no dropped frames, passed. This short smoke predates the last border-only adjustments; it is not a universal codec/performance or physical scanout guarantee. Grid redraw counters stayed unchanged during the earlier default-media playback check.

## Scope and follow-up

Offset remains read-only under the existing first-frame-normalized timing rule; this UI pass does not add synchronization-offset editing, full audio/subtitle tracks or custom extensions. Native glass refraction and an independent mobile touch layout remain outside scope. Existing unrelated Kimi changes remain in the working tree.

Checklist: visual comparison complete; repeat outlines removed; bottom annotation path verified; responsive geometry checked; tests/build passed; test note cleaned; temporary viewport reset; preview retained.


## Final interaction and annotation pass

final result: passed

Latest user steering supersedes the earlier static reference: group active tools, keep tracks on the right, collapse annotations to icons by default, and make annotation creation a small screenshot-style drawing task instead of a classification form.

Evidence, CSS viewport and screenshot pixel dimensions:

- `12-library-start.png`, `14-split-header.png`, `15-view-recovery.png`: 1487×1058; library startup, moving split headers, contextual recovery.
- `16-subtrack-workspace.png`: 1487×1058 intermediate left-note/right-track arrangement; used as the preceding-state visual comparison for this iteration.
- `18-drawing-editor-final.png`, `20-annotation-expanded-final.png`: 1487×1058 final editor and expanded annotation list.
- `21-annotation-narrow.png`, `22-annotation-hover-narrow.png`, `23-drawing-narrow.png`: 480×760 final expanded list, hover panel and editor.
- `19-annotation-hover.png`: desktop hover proof before the final time/note-first content order; current order is shown in `22-annotation-hover-narrow.png`.

Compared preceding and final desktop captures together, then final desktop and narrow captures together. Frame time and real video content differ intentionally from the earlier reference; final editor/list/hover evidence uses the same saved annotation at frame zero. No unresolved P0/P1/P2 findings in this scoped pass.

Resolved findings:

- Sidebars stop at the video row and cannot cover the full-width transport. On narrow screens the explicit grid-row end is retained.
- Split headers follow the actual split fraction. Handle fill is opaque and theme-controlled; parallel mode retains only the header seam.
- Source rows use neutral add buttons, hover accent and zebra fills. A single add button chooses an empty view or opens an explicit replacement choice. Startup uses the same source catalogue. Replace uses a refresh icon to distinguish it from Finder/Explorer reveal.
- Track headers and bottom rows support pointer/keyboard reorder without changing media identity. Main seek hover shows time; subtrack hover shows nearby notes and snaps within 10 CSS px to their exact frame anchor.
- Service status is immediately left of the top-right panel switches. Connection/disconnection/retry was exercised against the local service.
- Fullscreen and reset are grouped left of the timeline. Contextual center keeps 2× zoom when the video has been panned fully outside the viewport; reset restores 1×.
- Annotation tools occupy a 64px rail by default, 240px expanded desktop / 160px narrow. Right tracks retain the remaining space; 480px document scrollWidth remains 480px. Narrow ruler now shows endpoints to prevent overlapping labels.
- Severity and track-selection form fields removed. The editor supports real pen, ellipse, rectangle, line and text input on a frozen current-frame image. Notes are optional. Undo, save, cancel, direct viewport rectangle-to-editor, drawing-only save, exact-frame return and overlay disappearance after seek were exercised.
- Annotation previews contain actual local thumbnail, time and note. Expanded list uses the same content with a compact thumbnail. Pointer hover, keyboard focus, Escape dismissal and narrow bounds were checked; narrow hover right=334 and bottom=752 inside 480×760.

Five design dimensions:

- Typography: inherited system UI and monospaced time values; long notes wrap, essential controls remain named for accessibility.
- Spacing/layout: no new outer gutters or nested cards; explicit rail/list expansion; dense tracks on the right; editor scales within the viewport.
- Color/tokens: all new material, rail dimensions, hover width and drawing ink are theme variables. No new repeated outlines; keyboard focus remains visible.
- Image quality: original playback pixels are untouched; saved drawings use an independent overlay at their frame anchor. Editor copies the displayed frame for annotation; thumbnail is a small local preview, not a color-analysis/HDR fidelity claim.
- Copy: only tool names, current frame, optional note and save. No severity, taxonomy, checklist or mandatory issue template.

Validation: 96 tests passed, build passed, diff whitespace check passed. New tests cover normalized drawing validation, ownership-safe copies, drawing-only notes, exact frame/source anchoring and exported geometry. Final fresh preview browser error log is empty. `benchmark-annotations.json` measured the actual final page with H.264 + H.265 and the bottom panel open: both 59.26fps, zero dropped frames, speed 0.9918×, no long tasks, pause 2.77ms, passed. This is a two-second smoke, not a universal codec or physical scanout guarantee. Earlier mixed H.266 WASM + 4K HEVC evidence remains in `benchmark-tool-interactions.json`.

Temporary annotations were removed from the deliverable; the obsolete QA tab was closed, temporary viewport override reset, and the fresh preview retained. Changes remain uncommitted alongside existing Kimi work.

Limits: browser File inputs do not expose absolute paths; copy/reveal therefore applies to the local media library with opt-in reveal support, remote library sources offer download. Offset remains read-only. Existing severity data is retained for export compatibility but has no UI field. Drawings are vector data in exported reviews; thumbnail images stay in current-session memory. Existing review lifecycle remains in-session with explicit export; import/reopening/editing historical annotations is not introduced here.

## Service toolbar and deployment follow-up (2026-09-06)

Status moved inside the workspace button group. Live browser geometry at 721×791: 28×28 status button, 4px gap to the inspector button. `.design/2026-09-06/24-status-group.png` shows pointer-hover feedback with no click/focus required; the tooltip explains media connectivity and click-to-retry. Keyboard focus exposes the same text; Escape dismisses it and Tab advances to the inspector. Media library was connected and startup items were visible. Theme surface/shadow/type tokens are reused; no extra border or outer toolbar gutter.

Validation: 104 Node tests passed, production build passed. Unified dev startup/shutdown, cached-index reuse/refresh, changed-file rejection, server identity forwarding and annotation-author snapshot tests passed. A real managed-service crash recovered both 5178 and 5180 under macOS launchd. A temporary Caddy 2.11.4 gateway passed trusted HTTPS, individual login, bad-password rejection, spoofed-user rejection, protected media Range, isolation headers and attributed backend access logs. Test CA was never installed into system trust.

The generated archive and all 31 manifest files passed SHA-256 checks. The extracted package independently served the webpage, both WASM variants with application/wasm and isolation headers, API listing and 206 byte ranges, without node_modules. Docker/Compose and an actual remote deployment were not exercised (Docker unavailable here). Reviews remain in-memory with explicit export; account authorship is groundwork, not server-persisted collaboration history or a complete per-user action audit. Existing unrelated changes remain uncommitted.

## Track controls and dragging (2026-09-06)

Phosphor remains the single icon source. Plus and refresh now use its Bold assets for optical compensation at 17px; no hand-drawn replacement. The header's misleading replace/file-picker glyph is now a close-track button with neutral resting color and theme-token red hover/focus. Closing releases only that source, retains exported annotation lineage, and restores focus to the remaining track or Open. The last close also hides the empty dock.

The sole subtrack toggle now lives beside fullscreen/reset in the transport. The collapsed annotation rail is 40px, with centered 28px actions. Timeline tick density now also responds to its actual container width.

Real pointer header drag reordered A/B, and lower-row handle drag restored A/B. `25-track-drag-preview.png` was captured during the real pointer drag and shows the lifted, pointer-following filename/badge/header preview and dimmed origin. Target feedback uses a neutral surface and a small insertion edge, without a blue outline. Keyboard sorting and Escape/cancel cleanup remain supported; no real touch device was exercised. `26-track-controls.png` shows final controls and the library's refreshed/add icons at the current 721×791 viewport.

106 tests and production build passed. New regressions cover source disposal, surviving-frame/position preservation, annotation retention, closing the final track and cancellation of in-flight replacement. Actual UI clicks verified two tracks → one → empty → reload. `benchmark-track-close.json`: actual-page two-second H.264 + HEVC smoke after close/reload, 59.21fps per track, no dropped frames or long tasks, 0.991× speed, passed. This does not establish long-run or all-codec performance.

Design rationale: Apple's drag-and-drop HIG recommends recognizable drag previews and useful destination feedback; the neutral insertion treatment is our implementation choice, not an Apple-prescribed visual rule. https://developer.apple.com/design/human-interface-guidelines/drag-and-drop

## Unified tooltips and control metrics (2026-09-06)

A single delegated tooltip now covers static/dynamic buttons, menus, selectors and titled labels. It migrates native title strings to avoid double tooltips, falls back to accessible names/text, supports hover and focus, permits pointer entry, dismisses on Escape/action/scroll, and uses the popover top layer so modal dialogs cannot obscure it. Existing timeline and annotation rich previews stay separate. The connection light uses the same tooltip styling and lifecycle.

Live 721×791 inspection: all six viewport header action buttons are 24×24 with 17px SVGs. Close/copy/reveal are in the same action group. Icon controls share a context-level --button-size including flex-basis; regular controls remain 28×28. The subtrack toggle is the first transport control at x=4; remaining functional/time gaps are 4px, with no extra spacer or time-button padding. No unnamed icon-only buttons were found in the rendered DOM audit.

`27-control-tooltips.png` records the playback focus hint. `28-disabled-tooltip.png` records an actual pointer hover over disabled Undo inside the drawing dialog, visibly above the modal. Escape dismissal and dynamic control coverage were checked; no page console errors. `29-translucent-track-drag.png` was captured during actual pointer dragging and shows background header text through the 0.72-opacity preview; drag A/B and return A/B both succeeded. The rail was collapsed again and no test annotation was saved.

106 existing tests and production build passed. This pass does not change playback/decoding; the previous close/reload playback smoke remains the applicable evidence. No physical touch-device test or broad browser matrix was performed. Changes remain uncommitted with earlier work.

## Track identity, tooltip scope and pinch correction (2026-09-06)

Plain filename/property title hints removed. Generic tooltips no longer fall back to visible data text; the copy action says only “拷贝绝对路径”. Track identity (colored badge plus name) is a single clickable/draggable surface in the viewport and subtracks. Click opens the left inspector; dragging suppresses click and retains sorting. Badges are non-button children with their own colors, so parent hover cannot replace their fill.

Added shared static/dynamic icon-button constructors in ui/controls.ts; all visible tool icon buttons, including header actions, playback, note-add and drag handles, measured 24×24 in the live page. Header handle left equals header left; lower handle left equals track-row left. Badge size remains 20px inside the label. Mouse click, name-area pointer reorder without opening the inspector, keyboard reorder, plain copy tooltip and lower identity click were exercised. `30-track-identity-controls.png` records the unified controls and generic copy hint. B badge retained rgb(83,121,101); no page console errors.

Trackpad pinch root cause: pixel ctrl+wheel was incorrectly processed with ordinary mouse-wheel speed, 1.1^(-deltaY/120). Chromium encodes pinch as deltaY=-100*ln(scale); a 2× gesture therefore yielded only ~1.057×. wheelZoomFactor now inverts pinch with exp(-deltaY/100); ordinary wheel notch speed and Safari's direct GestureEvent.scale ratio remain unchanged. Regression tests cover coalesced vs split events, inverse gestures, cursor anchor, normal wheel speed and non-finite input. 108 tests and production build passed. Actual hardware pinch cannot be generated by the available browser automation; this verifies conversion/math and existing page integration, not physical trackpad feel or all browser/device event mappings.

Reference: https://chromium.googlesource.com/chromium/src/+/3b54b6aa8be4525318436d271397fc7d90c21da4/content/browser/renderer_host/input/touchpad_pinch_event_queue.cc

## Larger hit targets without taller containers (2026-09-06)

Tool buttons increased from 24×24 to 28×28 (36.1% more clickable area); icons from 17px to 18px. Shared tool inset/gap tokens are 2px. Header/subtrack handle left, right-to-identity, top and bottom gaps all measured 2px, including the second header (its divider now uses an inset shadow, avoiding a geometry-changing border). Name identity has no extra left padding between the handle and badge. Segment buttons consume their former outer padding so their surrounding group stays the same height. Timeline seek bars also gained vertical hit area within their existing lane.

Live page: topbar 40px, transport 38px, headers/track rows 32px, dock 180px, media rows 40px, source toolbar 36px; document width 721px equals viewport width, with no horizontal overflow. All visible tool buttons measured 28×28. Pointer drags beginning at y=43 inside the newly enlarged top edge successfully reordered both directions, restoring A/B. Existing 1.15× viewport and media selection retained; side panels restored to their initial collapsed state. `31-larger-controls-even-insets.png` records final dimensions visually. No page errors. 108 tests/build passed; this is a layout/hit-target change without playback/decoder changes.


## Spacing audit and theme roles — 2026-09-06

Scope: live in-app preview, current A/B videos at 1.15× and PTS 0; compact headers, transport, left inspector, right media library and collapsed annotation rail. Captured current screenshots before editing; no playback code changed.

1. Comparison header — functioning, but painted controls too close to the edge. `32-spacing-before.png` and user-provided crop show the dense header. DOM measured 32px row / 28px targets / 2px top and bottom, including copy, reveal and close: the original problem was not literally zero CSS padding. A shared 2px painted-surface inset now yields 4px visible clearance without reducing the 28px hit area. Header and track-row keyboard outlines use an inward offset so the 2px outer margin does not clip them.
2. Library and subtracks — functioning, inconsistent spacing. `33-spacing-panels-before.png`: panel title controls had 2px vertical clearance, source toolbar 4px, media add buttons 6px (appropriate to two-line 40px rows), annotation add row 0px. The annotation tool row is now 32px with 2px clearance, matching track rows; the 180px dock uses remaining space for the list. Timeline-to-offset gap reduced from 12px to 8px. `37-spacing-final.png` is the accepted clean post-change screenshot, with the handle hovered and no text selection.
3. Inspector and responsive layout — functioning. `34-spacing-inspector-before.png` verifies the existing 8px content alignment. Shared panel inline/block and control-gap tokens replace local spacing choices. `38-spacing-narrow.png` verifies the 600px breakpoint, inward keyboard focus on copy, and 4px narrow timeline gap; no horizontal document overflow. Viewport override reset afterward.

Theme: semantic roles for tool rows, control groups, panels, content, popovers and rail spacing are in `src/themes/silver-glass.css`; contract and fixed-height constraints in `src/themes/README.md`. Removed duplicated responsive padding overrides. Base scale remains available for fine internal typography/geometry.

Validation: actual 721px viewport after edits has 28×28 targets for all measured icon buttons, all using the same 2px painted inset. Header and track rows remain 32px, toolbar 40px, transport 38px, media rows 40px, dock 180px. Copy hover independently measured `background-clip: content-box`, 2px padding and neutral hover fill. Screenshot 36 contains incidental text selection from moving the pointer and is diagnostic only, not final visual evidence. Screenshots were emitted and inspected; screenshot 37 is the accepted post-change view. Keyboard Tab/Shift+Tab reached copy with an intact 2px inward focus ring. Build and 108 tests pass (existing ineffective dynamic import warning remains).

Limits: spacing/hit-target and keyboard focus audit, not a full accessibility certification. Physical touch use, screen readers, every dialog and every custom theme combination were not tested. Panel toggles and viewport size were restored to the user's initial collapsed state; videos, order, PTS and zoom retained.

## Four-track quality iteration — 2026-09-06

- Shared `SLOTS` now drives session validation/order, file drops, library auto-placement, all four canvases/pixel grids/drawing overlays/source actions, and WebMCP schemas. Frame stepping and marks retain the common session path.
- Added horizontal/2×2 arrangement; three tracks use a partial second row. Grid lower-row captions render below their stages and follow visual row after sorting. Wipe is enabled only for exactly two tracks; adding a third exits wipe instead of stacking hidden videos.
- Header dividers measure 16px within a 32px caption, centered vertically. Narrow captions (under 180px) move the existing action controls to a native popover. Verified at 90px per caption with a maximized side panel: no caption overflow; opened D's menu and closed D, then used the library add button to fill D again.
- Track dragging A from the first subtrack row (54,660) into trailing whitespace (350,784) reordered to B,C,D,A. Actual canvas positions, header row placement and timeline order agreed. No seek occurred. Blank space uses nearest-row targeting; pointer leaving the dock still cancels an invalid drop.
- Side panel drag checks: inspector 200→280px; sources 240→300px; right-arrow reduced the right panel by 16px. End reached 361px at a 721px viewport, reserving 360px comparison area. Restored tested preferences to 200/240px. At 1200px both panels stayed above the transport, which remained 38px tall and full width; no horizontal document overflow. Viewport override reset afterward.
- Screenshot 39 verifies lower captions; 40 shows the narrow popover; 41 is the clean final grid with B,A,C,D; 42 shows both side panels at the wide-window breakpoint. Captures are from the actual in-app page, not static mockups.
- `benchmark-four-tracks.json`: actual visible app, two H.264 + two HEVC 1920×1080 sources, 3s sample, ~59.35fps per track, 0 recorded drops, 0.992× playback speed, maximum skew 16.65ms, pause 3.21ms, passed. This covers those sources/environment only, not arbitrary four-stream codecs/resolutions or physical scanout.
- Build passed; 111 tests passed, including four-track seek/step/mark/reorder/removal, bulk file-drop allocation, invalid fifth slot, nearest-row blank targeting and side-panel constraints. Existing ineffective dynamic import warning unchanged. No demux/decode implementation changed.
- Library was inspected, not reimplemented: `docs/media-library-evolution.md` separates current recursive scanning/TTL limits from the proposed directory browser, background index and team review storage.


## In-viewport comparison annotations and workspace refinement — 2026-09-06

Removed the detached frame dialog. The drawing layers now share each video image transform; a compact toolbar supports multi-view pen/ellipse/rectangle/line/text, undo, optional note and a single save. Drafts and saved marks retain media ID and exact frame anchors. Frame changes hide drafts and block saving until the original frame is restored. Wipe accepts 2–4 tracks and displays the first two in current order. Offset is a 44px column before the timeline; subtracks use theme zebra fills. Loaded sources have an accent fill and no Add action; the shared session rejects duplicate library source IDs. Side resizers are transparent 6px overlays with the dock resizer's theme hover/drag fill.

Validation: 114 tests passed, production build passed (existing Vite browser-external dynamic import warning remains). Actual in-app browser: four distinct H.264/HEVC/AV1/VP9 sources loaded; wipe and D,C,A,B reorder displayed D/C; real pointer rectangles on both wipe halves saved as separate D/C frame-0 marks. Text input, undo, note editing, seek-stale save prevention, return-to-frame recovery and cancel checked. No modal remains. Used-source rows have no Add button and theme highlight; side resizer default transparency and theme hover checked by computed style and actual pointer drag. Tested 721×791 and 1280×900 layouts. Screenshot: `.design/inline-comparison-annotations.png`. QA marks deleted through the UI afterwards.

A 3s actual-page four-track benchmark passed: speed 0.988×, 58.6–59.3 canvas draws/s per track, p95 gaps 25.3–26.0ms, maximum skew 16.989ms, pause 2.76ms, no long tasks; VP9 dropped one frame. This is canvas draw evidence, not physical display scanout or a long-duration stress test.


## Side splitter hit areas and drag-to-collapse — 2026-09-06

Side handles now sit outside clipped side panels as absolute workspace overlays: 10px hit area centered on the seam, 2px accent line on hover/focus/drag. They occupy only the video grid row. A 32px inward overshoot beyond minimum arms collapse; releasing closes via WorkspaceState and focuses the existing toggle, reversing before release disarms it. Cancellation restores the starting preference; reopening after collapse restores the previous width. Theme tokens control hit width, visible line and overshoot distance.

115 tests and build passed. Actual browser pointer checks: both sides of the boundary hit the separator; right panel reaches 160px without closing, further inward drag closes it; left panel closes with opposite drag direction and reopens at its prior 200px width. Threshold, reversal, both directions, maximum clamp and constrained-window minimum covered by unit test.


## Panel transitions and push-away feedback — 2026-09-06

Sidebars and the lower track dock remain mounted for a 220ms slide/fade while grid space transitions. Side cards keep a fixed width; inward overshoot beyond minimum translates the card towards its outside edge with a progressive theme veil, and the seam hit layer follows it. Release continues from that pose into the exit; reversal/cancel restores the panel. Annotation rail width also transitions. Closing panels are inert, stale hide timers are cancelled on reversal, reduced-motion preferences skip movement.

Actual browser: a right-card close sampled immediately after release retained width 160px, translateX 35px, veil opacity 1, closed class true and hidden false; after the transition hidden became true. Dock settled at 180px with its top exactly matching the transport bottom. Dedicated lifecycle test covers delayed hiding, interrupted close/reopen and reduced motion.


## Independent panels and nested resizing — 2026-09-06

Removed the <900px mutual-exclusion rule and small-screen overlay layout. Both sidebars remain open; available comparison room determines width bounds. Generic tooltips now exclude every separator. The dock and annotation sidebar share a pointer/keyboard resize lifecycle: fixed minimum dimensions with push/veil feedback, deliberate overshoot-to-collapse, restoration on reopen, reversal/Escape/pointer-cancel support. Annotation collapse retains its existing icon rail. Theme tokens define nested width bounds; all separators use 10px hit areas and 2px lines.

Actual browser: both sidebars stayed open at 745px and 600px; at 600px they settled at 194px/166px around a 240px comparison region, without overlap. Annotation width changed 240→290px, pushed left to collapse and reopened at 290px. Dock reached 128px without closing, then a further push sampled a 44px downward translation with veil opacity 1 during exit. Both nested separators had no tooltip on focus/drag. Unit coverage updates narrow-window panel expectations and verifies nested gesture collapse ordering, minimum size, reversal and Escape cancellation.


## Direct track gestures, themed menus and attached splitter boundaries — 2026-09-06

Replaced native zoom/pixel selects with themed popover radio menus; zoom has a magnifier plus multiplier. Removed standalone track grips in headers and dock rows. The combined padded identity button distinguishes click from drag after 5px, suppresses post-drag clicks, supports Alt+arrow sorting, and toggles the current inspector closed on a second click.

Push geometry now releases grid space as the fixed card moves, including nested marks and dock height. Rebound transitions both reserved space and card position together. Actual pointer sampling on the right seam recorded card-left, line-center and comparison-right all equal at 589, 592, 595, 598, 601 and 604px. Dock push sampled card-top and transport-bottom equal through 663–684px; rebound after release also matched at 687px. Real header drag reordered A/B to B/A without opening inspector; two clicks opened then closed the same track. No standalone grips remain. Zoom selected 5× by pointer and 1.25× through keyboard, returning focus to the trigger. 117 tests and production build passed.


## Inline time editing and normalized manual alignment — 2026-09-06

Removed More tooltip and seek dialog; reset view moved to top view controls. Inline position supports seconds and timecodes, Enter/blur commit and Escape cancellation. Dock offsets are editable signed milliseconds; row-tail close buttons share track removal.

Flutter inspection found automatic initial offset = -startTimeUs in lib/main_window/main_window_media.dart. Both Web decoder paths already produce normalized frame PTS and retain raw source PTS. Manual offsets therefore project normalized media time into the session, without repeating initial normalization. Seek, queue coverage/take, fair step planners, shared end, annotations, export alignment and WebMCP set_review_track_offset now share this mapping. Positive offsets hold the first frame before track start; benchmark timing excludes that intentional hold from presentation-gap measurements.

120 tests passed including positive/negative offset seek and greedy steps, nonzero raw source PTS, no-range rejection preserving state, annotation/export anchors, slot replacement reset, offset playback EOF, and time-input formats. Actual browser: 00:03.300 located at 3,300,000us; B -200ms drew normalized 3,499,860us with raw 3,449,860us. Changing to +200ms moved the annotation to session 3,699,860us; clicking it returned exactly to its original normalized/raw frame. QA mark deleted. A/B actual-page benchmark with B +500ms passed at 0.996×, max skew 16.66ms, pause 1.505ms, zero dropped frames. B's lower full-interval draw rate reflects the deliberate initial 500ms hold. Canvas evidence only, not physical display scanout.


## Offset focus, stable zoom controls and wipe seam — 2026-09-06

Offset columns now reserve 64px for a 56px input and 4px clearance on each side; the focus outline is inset. Zoom trigger width stays 92px: actual-page measurements at 1×, 1.25× and 10× kept the neighboring pixel-mode menu at x=370.28125.

Wipe clips, header widths and divider share a screen-space device-pixel-aligned seam. The opaque stroke spans two physical pixels, beginning below the 32px header. Default divider color derives from panel/accent tokens instead of fixed gray. Actual pointer drag at DPR 2 yielded the same 411.5px clip boundary on both cards, with stroke edges at physical pixels 822 and 824; screenshot inspection showed no visible opposite-side sliver at that position. This verifies browser canvas/CSS output, not all physical displays. Pure geometry coverage includes fractional origins, DPR 1/1.25/1.5/2/3 and out-of-bounds dragging. All 121 tests and production build passed; git diff --check passed.


## Fixed pixel squares and translucent chrome — 2026-09-06

Grid cells now remain 320×320 source pixels through resolution, fit, pan and zoom changes; labels show literal dimensions only, with no grid-count tooltip. Caption insets are 8px. Splitter color uses neutral theme surfaces/text and no accent hover override. Only topbar, viewport headings and transport use the shared 82% translucent material and 12px backdrop blur. Left/right/dock panels retain solid surfaces and continue reserving layout space. Reduced-transparency/contrast preferences use the existing solid-material fallback.

Actual browser verified both 1920×1080 labels without titles, 320x320 canvas grid metadata, alpha .82/blur 12px on headings and transport, and opaque/no-blur sides and dock. Unit coverage checks literal small/common/8K dimensions, square cells, unchanged source cell size on zoom and small viewports, and pan alignment. 121 tests passed.


## Floating two-row viewport transport — 2026-09-06

Moved transport into a positioned viewport-surface wrapper beside screens, above the separate annotation toolbar. Workspace has only video/dock rows. Timeline owns the upper row; playback actions, editable time and fullscreen own the lower row. Video continues behind the 68px translucent panel. Theme tokens define inset, max width and shadow. Bottom grid headers and resolution captions stay clear of the panel.

Actual browser at 749px: video stage extended to y=791 behind transport y=715–783, with visible blurred video underneath at 2× zoom. With both sidebars and dock open, viewport x=160–589/y=40–611 contained transport x=168–581/y=535–603; dock starts y=611. At 600px window width, all actions fit their 256px row without scroll overflow and retained 28px targets. Four-track grid: transport ended y=571, bottom headers began y=579; lower captions ended y=495, 8px above transport. Literal labels included 320×180. Inline 0.3 became 00:00.300; actual timeline click sought to 00:02.406 with matching preview content. Temporary C/D tracks removed after QA. Existing 121 tests passed; production build and diff whitespace checks passed.


## Transparent video chrome reference pass — 2026-09-06

Source visual truth: `/var/folders/j5/x39dhv0n7h720pfxwzx7_mw00000gn/T/codex-clipboard-e95d6291-b250-4a01-b863-1b36df8064d7.png` (transport), and `/var/folders/j5/x39dhv0n7h720pfxwzx7_mw00000gn/T/codex-clipboard-791f3933-17b8-4d96-b68b-8703b018e060.jpg` (2400×1080 header/full player). Scope is adapting the reference's transparent playback chrome to existing VoidPlayer controls, not cloning unrelated social features, preview artwork, or media content. Existing Phosphor icons and decoded video remain the assets.

Evidence: `.design/transparent-transport-comparison.png` pairs the transport reference normalized to 854×166 with a same-size bottom crop. `.design/transparent-heading-full.png` is the browser capture at 1200×580 CSS pixels; `.design/transparent-viewport.png` excludes the 40px app toolbar for a 1200×540 viewport. The reference is downsampled by 2 to match it in `.design/transparent-heading-comparison.png`. `.design/transparent-heading-detail.png` pairs focused header crops. Browser screenshot output is normalized to CSS pixels. `.design/transparent-grid-headings.png` shows the final four-track lower-heading treatment. All compared images were opened together, including focused controls.

Findings and fixes:
- [P1, resolved] Opaque-looking white card and blur contradicted reference. Removed card fill, radius, shadow and blur; added a continuous dark contrast fade with light foreground. Verified computed background transparent, backdrop-filter none and box-shadow none.
- [P1, resolved] Headers consumed view height. Headers now overlay full-height stages. Split QA: stage and card both y=40/h=540 while heading overlays y=40/h=32; wipe line still starts at y=72. Four-grid QA: all stage heights equal their 375.5px card heights.
- [P2, resolved] Separate bottom-title and transport gradients created a hard horizontal seam in first grid capture. Unified the bottom fade and placed headings above it; final grid screenshot shows continuous shading and clickable headings.

Required fidelity surfaces: typography retains the product's compact system font, mono editable time, 28px targets and 18px icons rather than the reference's mobile title scale; this preserves the user's requested compact density. Spacing/layout matches transparent edge-anchored two-row controls with full-width progress, and no card margins. Colors use light primary/secondary text and theme-configurable scrims, with no video blur; playing/stepping icons use Phosphor Fill. Image quality retains actual decoded content, no generated or approximated illustration assets. Copy retains real file names and review functions, without importing social/video-site UI unrelated to the product.

Interaction QA: narrow 600px browser with all panels open retained five 28px buttons; action scrollWidth=clientWidth=272px. Inline 3.3 produced 00:03.300. Clicking lower track C opened its inspector. Both temporary C/D tracks were removed, responsive viewport override reset, and two-track split left open. 121 tests and production build passed; this CSS/input-layout change does not alter decode/presentation logic.

Follow-up polish: reference media and hover-thumbnail content differ intentionally; no claim of pixel-identical video imagery.

Implementation checklist: transparent controls; opaque-panel semantics preserved; full-size stages; neutral wipe line; continuous lower-grid fade; keyboard-focus contrast; responsive controls; browser comparison complete.

final result: passed


## Compact theme-aware chrome, focus toggle and pin playhead — 2026-09-06

Supersedes earlier white-on-black styling per latest user feedback. Header scrim is restricted to 32px, and transport to its 56px two-row area; neither fades further into the viewing region. Theme surface/text tokens determine both gradients and foregrounds (44% surface at header start; 48% at transport bottom). Playback, pause and stepping use Phosphor Regular consistently with adjacent controls. Range uses a 10×18px inverted-triangle/stem playhead and stronger theme accent; filled-rail endpoint accounts for native thumb inset.

Top panel controls are inspector/subtracks/sources in that order. Independent eye switch uses viewport-chrome.ts; focus mode clears visible headers, transport, captions and their scrims, applies inert to hidden interactive containers, preserves viewport/playback state, and retains splitter and eye. Empty-session reset and entering annotation restore chrome. Tooltip observer refreshes dynamic labels, verified with the eye's changed action.

Actual browser evidence: `.design/compact-themed-chrome.png` and `.design/focus-mode.png`. Viewport geometry stayed x=0/y=40/w=749/h=474 and time stayed 00:03.300 across focus toggle. Focus DOM exposed only two video canvases, splitter and eye within the comparison region, while outer panel states remained intact. Dragging the splitter changed its position from 50 to 55 while focus stayed active. Header inert=true and scrim display=none in focus; restore removed inert and set eye aria-pressed=false. Progress ratio .3300132335 matched value 3,300,000us; fill position uses the 10px pin width. Verified 32px header mask, 56px control height, top button order and dynamic restore tooltip. Build and whitespace checks passed; 121 existing tests passed.

final result: passed


## Readable frosted chrome and time-field clipping — 2026-09-06

User feedback supersedes pure transparent gradients: white tint with dark icons was illegible against tree/sky detail. Restored theme-based 86% fill plus 12px backdrop blur strictly within the existing 32px heading and 56px transport. No additional gradient or text shadow; focus mode still removes the complete surface, with no stage/layout changes.

Time-field root cause: its low-specificity padding rule lost to input:not([type=range]), while the width formula assumed smaller padding. #position.time-input now owns both width and padding, and the shared theme formula includes the formatted timecode length plus caret slack. Session duration reserves a stable number of digits during playback, including minute counts beyond two digits.

Actual browser: 00:03.333 displayed completely; normal field clientWidth=scrollWidth=80, padding 4px, scrollLeft=0. At 600px viewport with both sidebars open, clientWidth=scrollWidth=74, padding 2px, scrollLeft=0; action row clientWidth=scrollWidth=272. Screenshot inspection confirmed the final digit. Focus toggle hid heading/transport and preserved 00:03.333. Computed materials both show alpha .86 and blur(12px). Evidence: `.design/readable-frosted-chrome.png`. 121 tests, production build and git diff --check passed.

final result: passed


## One-row alpha-only transport and background resolution — 2026-09-06

User requested single-row controls once chrome has a visible fill. Moved timeline into the actions row between time and fullscreen, reduced transport from 56 to 32px, kept native pin playhead and 28px hit areas. Header/transport now use 76% theme-surface fill with backdrop-filter:none; shared glass filter is disabled. No video blur pass is requested by UI. WebKit's primary explanation notes backdrop effects require extra rendering passes: https://webkit.org/blog/3632/introducing-backdrop-filters/ . No device-specific FPS improvement is claimed.

Resolution captions now render at background z=0 behind image-wrap z=1. Actual screenshot at 2× confirmed a full video hides the resolution caption; at 1× with letterboxing it appears only on the exposed background. Actual 749px row: 32px height, time/timeline/fullscreen/eye all y=761 with 28px height; timeline width 411.9px. Computed header/transport fill alpha .76 and blur none. At 600px window with both sidebars open, action clientWidth=scrollWidth=272, time clientWidth=scrollWidth=74 with complete 00:03.333, and timeline remained 53.8px wide. Responsive viewport override reset and sidebars closed after inspection. Evidence: `.design/one-row-alpha-controls.png`. 121 tests, production build and whitespace check passed.

final result: passed

### 顶部菜单与图标语义统一
- 移除 More 的 details 专用菜单，缩放/像素/More 共用 popover 控制器与主题样式。浏览器实测三个菜单背景均为 rgb(248,249,251)、padding 2px、圆角 7px。
- 并排/分屏位于品牌之后的首个功能组；添加入口及空态使用 file-plus，定位原文件仍使用 folder-open。
- 实测禁用导出项被键盘跳过，End/Enter 打开说明且焦点留在对话框；缩放 ArrowDown/Enter 设置 1.25×；Escape 回到像素模式按钮；切换菜单仅一个保持展开。测试后倍率恢复 1×。
- `npm test`: 121/121；`npm run build`: 通过（已有大 chunk 提示）。证据 `.design/unified-toolbar-menu.png`。

### 添加入口突出显示
- 添加视频改为图标加文字的按钮（默认普通底色与文字，悬浮时显示主题色），移到右侧连接灯左侧。
- 浏览器 749px 宽实测按钮 90×28px，距连接灯 4px，标题栏保持 40px，无页面横向溢出。
- `npm test` 121/121、`npm run build` 通过。
