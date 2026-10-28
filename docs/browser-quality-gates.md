# Quality browser gate audit

This audit concerns the browser checks used by PR #156. It does not establish that the failures of PR #149 or #154 were fixed, and does not waive their reviews or required checks. No playback threshold, numerical assertion, timeout, product code or branch protection changes.

## What the checks protect

| Check | Product behavior and failing observation | Independent coverage | Decision |
| --- | --- | --- | --- |
| MP4 HEVC8 WebKit | GUI discovery → explicit probe/index preparation → C/range scoring → candidate → raw-pixel/grid viewer while another source plays. The preparation POST returned409 where202 was required at `check-mp4-quality-browser.mjs:23`. | H2648/HEVC8/10 MP4 HTTP/compiled numerical and table-witness tests; other MP4 browser cells. Those do not replace this GUI's preparation request. | **Keep required**, including409/202 assertion. The original script passed once locally without changes; that neither establishes a root cause nor proves the CI failure harmless. |
| Correspondence10 WebKit | Explicit relations, exact AU table, durable unknown-submit replay, explicit new plan, cancel/physical exit, candidate/viewer and late selection/actor/close fences. Its final empty-page-error assertion saw range/plan access-control messages. | `quality-correspondence-http.test.ts`, lifecycle/unit tests; Chromium and8-bit GUI. | **Keep required and preserve all page-error assertions.** Aborted observation is a possible explanation, not proof; do not suppress arbitrary console or access-control errors. |
| Presented-quality WebKit | Two real native-playing pages, paint/AU binding, explicit cache build, stale capture rejection, ROI/PSNR/SSIM, shared candidate and raw viewer; originally followed by a separate native identity matrix. CI closed the page during initial readiness after MESA mapping failure and allocator-corruption output. | Chromium full workflow, required WebKit ROI paths, `quality-source-build.test.ts`, `native-presented-frame.test.ts`; extracted real WebKit decode/paint protocol below. | **PR-only non-blocking diagnostic for the multi-page workflow**, with its assertions/exit/report intact. This crash is not evidence of an XPSNR defect or a fixed browser bug. Full WebKit paused-frame workflow certification remains incomplete when this diagnostic fails. Main/tag still require the original full case. |
| ROI8/10 Chromium | Actual DPR2 letterboxed drag → exact source ROI/raw planes → persistent PSNR/SSIM/grid → atomic candidate, unknown receipt replay, peer actor/private-job404 and viewer;8-bit also checks real cancellation/exit and cache loss. Both CI failures waited30s for the AU0 option at line128. | HTTP/numerical/annotation contracts and WebKit ROI cells; these cannot replace the source selection and stale GUI controls. | **Keep required**, original30s wait and all safety assertions. An unchanged local8-bit pass does not explain either CI failure. No blind retry or removal. |
| Task-center WebKit | Five original stores, exact filters/frozen cursor recovery, original plan/result/candidate links, cancel/exit, observer close, late detail and actor changes, playback isolation. Final page-error assertion saw a VMAF detail access-control message. | `task-center-http.test.ts`, `task-center-vmaf.test.ts`, task unit tests and Chromium GUI; XPSNR adds its sixth store separately. | **Keep required**, including final page-error assertion. A later pass does not prove that an earlier failure was unrelated to the product. |

The evidence is [PR #156 full run40569343067](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/40569343067), including attempt2. In attempt1 cache passed50/52; attempt2 passed48/52 with different failures. All four new XPSNR GUI cases passed in both attempts. Changing failed case names is not a causal diagnosis. Public synthetic fixtures only are used.

## Small PR-only separation

The existing `checkNativePresentedProtocol` function is moved out of the end of the multi-page workflow into `check-native-presented-protocol.mjs`, once per Chromium/WebKit engine. Its actual decoder, presenter and independent barcode oracle are unchanged: accepted AU membership, reordered output, drain, negative clocks, duplicate clocks, multiple-picture ambiguity and interlaced identity rejection remain required. WebKit H264/HEVC must actually execute; only the existing explicit Chromium HEVC-unavailable outcome is allowed. The extraction does not certify the full WebKit multi-page workflow, server ROI transport or GUI interaction by itself.

- `ci-cache` has the original52 cases plus the two extracted native protocol entries, all required; main/tag keep the original full WebKit workflow required.
- `ci-cache-pr` has exactly53 required cases: the same set except `browser-presented-quality-webkit`. The full WebKit workflow still runs once as a separately named PR diagnostic step, with its original assertions and300s case budget. Its failed exit is recorded as failed, not re-labelled a passed test.
- Only that named diagnostic step uses `continue-on-error`. The required PR suite and every other browser case remain blocking. The job-level/release-set dependency graph and its failure/cancelled/skipped guard remain unchanged. A failed/cancelled/missing required suite cannot produce verified artifacts.
- Reports for the required PR suite and the separate diagnostic are uploaded. There is no global error suppression, new retry, path filtering, increased budget or new test orchestration platform. No performance claim follows from a functional job's green status.

## Bounded local validation

Run the structural contracts and only the affected/representative behaviors; no full CI rerun is needed to audit selection:

```sh
node --test test/contract/release-pipeline.test.mjs test/contract/test-manifest.test.mjs test/contract/test-runner.test.mjs
node scripts/run-tests.mjs --check
node scripts/run-tests.mjs ci-cache-pr --list
node scripts/run-tests.mjs --prepare
node scripts/run-tests.mjs --case browser-native-presented-protocol-chromium,browser-native-presented-protocol-webkit,browser-presented-quality-chromium --prepared
node scripts/run-tests.mjs --case browser-mp4-quality-hevc-8-webkit,browser-quality-correspondence-10-webkit,browser-quality-roi-8-chromium,browser-quality-roi-10-chromium,browser-task-center-webkit --prepared
```

Do not interpret selecting/listing a case as its execution, treat a skipped native engine as certification, or turn a diagnostic failure into a successful product result. Remaining unexplained required failures must be reported rather than waived.
