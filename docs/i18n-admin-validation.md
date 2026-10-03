# Administration and certificate-guide localization validation

This follow-up extends the merged #40 implementation for #38. The development branch is `codex/i18n-admin-guide`, based on actual main `92e4d0a3b25acfc86f32201eeb061333d5837758`. No merge, tag, deployment, original-checkout mutation or existing-service shutdown is part of this work.

The final runtime source digest is `74b0fc06a6dc248688243e00c3e71001b03ae28b55865efcb0b33796b6fc881b`. The separately built merged-main baseline is `a64d2afdb99607f5ac437b0b5d32bd77e519d4bff9f3877cb2b4847169bb48e5`. Every final performance report embeds both source digests and the existing benchmark build/media/decoder evidence. Old #40 evidence remains in its original directory; earlier extension measurements are preserved in [history](evidence/i18n-admin/history/), with their distinct predecessor source digest.

## Coverage and state preservation

The extraction inventory contains 984 typed source-adjacent messages, up from 669. Both catalogs compile at build time. Scope checks cover actual `src/admin/main.ts` and every recursive administration module, plus `src/connection-guide.ts`; there is no nonexistent `src/admin.ts` exemption.

| Area | Covered copy and live-state checks |
| --- | --- |
| Overview | Navigation, metrics, status, library/watch counters, a11y and document title |
| Library | Directory names/paths labels, drafts, focus/selection, enabled actions, scan progress/errors, readonly reasons and pagination |
| Caches | All three kinds, disk/quota meters, structured frame/thumbnail/annotation descriptions, dates, empty/error states, search, 53-row pagination and an open confirmation |
| Workspaces | List/detail labels, counts/dates, unsaved rename, focus/selection, search/selection, conflict/copy/delete controls, confirmation and unchanged document JSON |
| Annotations/trash | Search/space/tab labels, counters, selected record, image/alt, author/revision/date, frame-mark fallback, delete/restore/export and an open confirmation |
| Logs | Uploaded/request list labels, dates, user fallbacks, selection, readonly raw JSON and its text selection, download and open delete confirmation |
| Measurements | Deferred kind/description/state/reason labels, options, result conditions, errors, counts and dates; an open radio menu and the same running job ID survive switches |
| Certificate guide | Complete Windows/macOS instructions, explanation, download/probe/retry/open states, unavailable/custom HTTPS, title/a11y, selected OS, open details, focus, exact CA filename/fingerprint and navigation destination |

Dynamic rows use weak DOM bindings, traversed on language events. Switching does not fetch lists, replace live shells, reset pagination/search, close confirmations, rewrite inputs or restart transfers. Static dictionaries are factories or per-locale snapshots initialized after locale loading. Measurement transfer/API loops remain locale-independent; display formatting stays at the existing UI update boundaries. Existing worker/decoder/presenter/progress dependency contracts still pass.

Root reasons and cache entries gain additive stable display metadata. API error bodies retain their original `error` and HTTP status, adding stable `code`/optional `params`. Measurement conflict codes distinguish a running task, changed media and finishing reads; a running task is not mislabeled as changed workspace content. Original diagnostic causes remain visible beside translated actionable summaries.

The same author catalog is retained. Guide emphasis uses complete static sentences, with build-checked matching `<strong>` tags, no attributes or user variables; pseudo text preserves their topology. User content is always assigned as text or escaped attributes.

## Local checks

- Complete registered unit suite: **130/130 passed**, followed by final-source fast checks **31/31 passed**, including new error-code branches and unchanged raw diagnostics.
- Final `ci-i18n`: **10/10 passed**, Chromium and WebKit. These include the original player playback/settings/draft/focus/canvas/property-cache and tooltip cases, plus administration, guide and expanded pseudo layout.
- Existing administration, guide, cache and saved-workspace browser regressions: **9/9 passed**, preserving their assertions and internal measurement/CRUD/layout checks.
- Ordinary production build, typed descriptor checks, deterministic extraction/compilation, rich-message validation, recursive scope validation, test-manifest registration and whitespace checks passed.
- Pseudo layout covers every admin panel at 1280/720/390/320px and both guide OS steps at 1280/390/320px. Font evidence includes the system/PingFang SC/Microsoft YaHei/Noto Sans CJK SC stack; actual screenshots contain readable CJK user data.

Compact [unit](evidence/i18n-admin/full-unit-results.json), [final fast](evidence/i18n-admin/final-fast-results.json), [final browser](evidence/i18n-admin/final-browser-results.json) and [legacy browser](evidence/i18n-admin/legacy-browser-results.json) results are retained. Initial negative QA results remain in `.run`: a Node strip-only parameter-property error was corrected; listener tests then required the already-authorized loopback escalation; fixture cleanup was made idempotent; a cache assertion was changed to select its explicit fixture ID rather than a timestamp-tied first row; long pseudo labels exposed actual layout overflow, fixed without weakening assertions. A temporary executor disconnect was recovered using readonly probes.

## Startup cost and language latency

Measurements use the same Mac Apple M5, Node 24.15.0, Chromium 153.0.8010.12 / WebKit 26.6, viewport, media and copied WASM binaries. Both distributions open Appearance settings, switch en → zh → en → zh, close settings, and wait two animation frames. Browser/service/data lifecycles are isolated and runs are sequential.

First-screen resource accounting is UI JS/CSS, theme files and `theme-init.js`, as listed in each report. Media/vendor binaries and API traffic are excluded; their behavior and unchanged core digests are checked separately. Gzip is an offline estimate; this local static server serves uncompressed content. Readiness waits for the existing `voidPlayer.tools` facade, not the first decoded frame.

| Cold visible Chromium | Merged main | Final implementation | Increase |
| --- | ---: | ---: | ---: |
| Chinese UI raw bytes | 1,072,670 | 1,091,880 | 19,210 |
| Chinese UI gzip bytes | 315,649 | 321,823 | **6,174 (1.96%)** |
| Chinese requests | 30 | 30 | 0 |
| English UI raw bytes | 1,111,334 | 1,150,059 | 38,725 |
| English UI gzip bytes | 327,300 | 339,097 | **11,797 (3.60%)** |
| English requests | 31 | 31 | 0 |

The original budgets remain 32 KiB extra Chinese / 48 KiB extra English gzip, +3/+4 requests, and median readiness at most baseline ×1.3 +100ms. All cold and warm samples in the supported cells pass those budgets. In visible AB, cold readiness medians are 104.4→99.2ms (Chinese) and 94.6→91.1ms (English). Exact cold/warm values for every cell are in [summary](evidence/i18n-admin/summary.json).

Final feature locale-commit samples peak at 26.4ms across the unprofiled supported cells; the original 250ms cold / 100ms cached limits remain. Click-to-ready automation time is recorded separately. The English initial-load path, failed-load fallback/retry, late-request handling and stored/system choices retain their existing regression coverage.

Added administration/guide words enter the shared player locale chunks. Separate entrypoints do **not** isolate this cost. The measured 6.2/11.8 KiB increases and unchanged request counts justify retaining locale-level chunks and one author catalog for this change; generated per-domain subsets remain an option if future measured growth warrants them.

## Playback and main-thread comparison

| Final comparison | Playback assertions | Median main-thread TaskDuration per 4s repetition, baseline → feature |
| --- | --- | --- |
| Visible Chromium AB | 6/6 pass | 1083.1→1068.2ms (−1.4%) |
| Visible Chromium BA | 6/6 pass | 852.0→845.4ms (−0.8%) |
| Headless WebKit mixed H.264/HEVC | 6/6 pass | CDP CPU metrics unavailable |
| Headless Chromium dual H.264 | 6/6 pass | 2332.6→2292.6ms (−1.7%) |

All **24 unprofiled supported playback results** meet the existing speed, frame-lag/skew, gap and pause limits. No limit or assertion was relaxed. These short paired samples do not establish a performance improvement: predecessor runs showed substantial timing/order variation, and all their data remain in history. Hardware decoder use is not asserted.

A separate profiled pair passes all six playback checks. Over about 13.4 seconds, sampled message-helper/controller inclusive time is **2.512ms baseline / 2.518ms feature**. Direct self samples are zero in this final capture; that means sampling missed those short frames, not zero cost. The [CPU summary](evidence/i18n-admin/cpu-summary.json) records exact source positions, SHA-256 and limitations; [baseline](evidence/i18n-admin/baseline-cpu.json.gz) and [feature](evidence/i18n-admin/feature-cpu.json.gz) raw profiles are preserved. Profiled CPU timings are not substituted for the unprofiled AB/BA results.

The known **headless Chromium mixed HEVC cell remains negative on both builds**: baseline speed 0.582–0.604×, feature 0.560–0.589× against the unchanged 0.9× minimum. All six runs fail `below-realtime`; the single-case benchmark script exits 1. The public manifest labels this comparison informational, which does not turn those failed playback assertions into passes. [Negative evidence](evidence/i18n-admin/chromium-hevc-negative.json) is retained. This cell remains a limitation and cannot establish performance parity; decoding behavior is outside this localization follow-up.

## Screenshots and remaining limits

Actual production-browser captures: [directory draft](evidence/i18n-admin/admin-library-en-draft.png), [workspace rename/confirmation](evidence/i18n-admin/admin-workspace-en-confirm.png), [cache pagination/confirmation](evidence/i18n-admin/admin-cache-en-confirm.png), [annotation/preview](evidence/i18n-admin/admin-annotation-en-confirm.png), [raw logs](evidence/i18n-admin/admin-logs-en-confirm.png), [running measurement](evidence/i18n-admin/admin-measurement-en-running.png), [Chinese measurement](evidence/i18n-admin/admin-measurement-zh.png), [Windows guide](evidence/i18n-admin/guide-windows-en.png), [macOS guide](evidence/i18n-admin/guide-macos-en.png), [narrow admin pseudo](evidence/i18n-admin/admin-pseudo-measurements-390.png) and [narrow guide pseudo](evidence/i18n-admin/guide-pseudo-macos-390.png). These use owned test records and a valid test JPEG for the annotation-preview fixture; they are UI evidence, not proof of video decoding.

Product-owned admin/guide GUI copy is covered by scope gates. Deliberately retained originals are user names/content, saved default shared-space names, media metadata/timecodes, service and agent-tool diagnostic/protocol text, raw JSON and underlying causes. An older server without additive display metadata falls back to its original diagnostic strings. Browser startup cannot recover if the translation runtime itself fails catastrophically; the existing built-in Chinese emergency text remains a last fallback. Two languages are supported; Windows OS certificate installation is explanatory UI, not a system trust-store mutation or a Windows-host browser run.

CI is verified on the draft PR's final head and linked from its description; this document does not substitute local checks for that final workflow result.
