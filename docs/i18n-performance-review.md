# Localization performance review

The original headless mixed H.264/HEVC comparison (baseline-first, `3d452be`) showed a **3.19% lower feature median**. That was a signal requiring investigation, even though both builds failed real-time assertions. This review retains that negative result and adds predetermined AB/BA order reversals, rather than dismissing it or changing thresholds. All 40 new Mac samples use the copy-name/plural-fixed runtime from `1944ab321e9709529a80f71699d7bda2cf706384`.

The mixed workload still fails real-time playback on both builds. The order-reversed samples do not show a consistent feature slowdown; they do **not** establish real-time success or statistical equivalence. Trusted HTTPS CI comparison is executed separately on one disposable Linux runner using the canonical benchmark and its unchanged assertions. The first controlled CI run is archived below; its raw artifact and exact final-head replication are linked from [draft PR #41](https://github.com/Nakiha/VoidPlayer-Web/pull/41); they must be inspected before accepting a CI performance conclusion.

## Source and controls

Baseline is pinned main `92e4d0a3b25acfc86f32201eeb061333d5837758`, runtime digest `a64d2afdb99607f5ac437b0b5d32bd77e519d4bff9f3877cb2b4847169bb48e5`. Feature runtime digest is `8afc83a04f7d5bebe27513316f873429181c51f786455e0a5f64fc554d850e69`. The review changes only benchmark tooling, its public registration, CI and evidence; no runtime source, decoder or presenter optimization is introduced. The four production worker JS files remain byte-identical between distributions. Each raw report embeds build/core/media/decoder and presentation evidence.

Mac controls: Apple M5, macOS 27, Node 24.15.0, Chromium 153.0.8010.12, headless, 1280×800, same dependencies/core/media, fresh service/browser per distribution, isolated databases. Both distributions open Appearance, switch en→zh→en→zh, close the dialog and wait two animation frames. Preparation records secure context, isolation, focus/visibility, final locale/dialog/tooltip/canvas; repeated samples exercise the same-page playback lifecycle. Sequential tests preserve all orders and failures. Host load snapshots are retained; thermal readings were unavailable, so no thermal cause is asserted.

## Mixed H.264/HEVC: four predefined order-reversed pairs

Each distribution has three repetitions of the original four-second benchmark. All **24/24** samples fail `below-realtime` against the original 0.9 minimum. No mixed sample reports a presentation-stall failure.

| Pair order | Baseline median speed | Feature median speed | Feature / baseline change |
| --- | ---: | ---: | ---: |
| AB1 | 0.60767 | 0.58783 | −3.27% |
| BA1 | 0.57680 | 0.61585 | +6.77% |
| AB2 | 0.59191 | 0.58228 | −1.63% |
| BA2 | 0.56662 | 0.59167 | +4.42% |

The later distribution is slower in every pair, whichever version runs later. Mean pair medians for first versus second are 0.60178 versus 0.57838 (about −3.89%). This is an observed association with order, not a proven host or thermal mechanism. Equal-order geometric mean feature/baseline ratio is 1.01490 (+1.49%); it is descriptive and is not evidence of an improvement or equivalence. Median main-thread TaskDuration differences are −1.66%, +0.22%, +1.03%, −1.21% in the same four pairs. Long-task, pause, frame lag/skew and all per-track gap data remain in the raw reports.

See [mixed summary](evidence/i18n-performance-review/pr41-mixed-order-summary.json) and the eight [raw Mac reports](evidence/i18n-performance-review/). Original `3d452be` negative evidence remains in [the historical record](evidence/i18n-admin/chromium-hevc-negative.json); it is not relabeled as current-head evidence.

## Synthetic 1080p H.264 localhost control

The existing fixture generator produced two byte-identical 1080p30, 40-second, approximately 20 Mbps H.264 files, 100,872,309 bytes each, SHA-256 `db5b4587657fd5496b12d2931abdeeeedc56b2ef5a85a7d7260d142025dcf34c`. Solo AB/BA and dual AB/BA each have two repetitions per distribution, 12 seconds each: **16/16 pass all original speed/gap/stall/lag/skew/pause assertions**, with speeds 0.99916–1.00000. Median main-thread differences are about +1.58%, +0.63%, +0.42%, −0.57%; these small differences are retained rather than presented as zero cost.

This control uses HTTP loopback, which is a browser secure context, with isolation and WebCodecs verified. Hardware acceleration is `no-preference`; hardware use is **unverified**. No certificate bypass or Mac trust-store mutation was used. Fixture specifications match the CI workload, but generated bitstreams, platform/core binaries and transport differ across Mac and Linux. Therefore these passes cannot replace the trusted HTTPS CI comparison. [Synthetic summary](evidence/i18n-performance-review/synthetic-summary.json) preserves every speed/CPU result; raw reports preserve their original assertions and environment.

## Startup and locale commits

Current-head Chinese gzip estimate grows 315,649→321,835 bytes (**+6,186**, 1.96%); English 327,300→339,155 (**+11,855**, 3.62%). Request counts remain 30 Chinese / 31 English. All eight paired Mac reports meet the original cold/warm size/request/readiness budgets. These are offline gzip estimates of first-screen UI assets, not compressed network delivery or full media payloads. Admin/guide text shares player locale chunks; its cost is not hidden by separate entrypoints. Feature locale commits peak at 27.805 ms, below the original 250 ms cold / 100 ms cached limits; automation click-to-ready includes browser scheduling and is reported separately.

## Trusted HTTPS negative evidence and controlled CI

Unpaired CI at `1944ab3`, run `37144012341`, contains four failing benchmarks: solo 0.83921/0.84725; dual 0.52788/0.54020. Both dual samples additionally contain presentation-stall failures. Three functional repeated-playback samples report performancePassed=false at 0.57122/0.56172/0.56428 despite passing resource/cleanup checks. [Complete negative data](evidence/i18n-performance-review/pr41-ci-negative.json) preserve the failures and runtime digest. A green informational job never turns these into playback passes.

The new registered `ci-perf-pair` case runs the unchanged canonical trusted HTTPS benchmark in **baseline→feature→feature→baseline** order on one disposable Ubuntu runner, pinning the PR base SHA. Each session has two solo and two dual 12-second samples, for 16 expected samples. Both checkouts use identical generated media and WASM core. Harness hashes, media/core hashes, source digests, real HTTPS/isolation, decoder preferences and complete sample identities are validated; missing reports or mismatched controls fail explicitly. Child exit statuses and complete logs are retained. Existing report files are restored after each child. Certificate trust uses the project's existing temporary NSS entry and exact removal; no system security settings are changed.

The PR-only job adds measurement cost but stays outside release aggregation. The release contract explicitly audits this sole informational exception and retains every required verification dependency. Benchmark exit 1 remains an informational **failed** case; its raw `passed`, failures and `configurationValid` must be read separately from job color. CI artifacts retain every report and log for 30 days. Final CI interpretation and any blockers are recorded in the PR description against the exact tested head; results are not extrapolated across changed runtime digests.

### First controlled HTTPS run: complete, with a small negative difference

Run [37150851591](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/37150851591), PR head `346cbcc088a902fb23520c476163f254c1d5b0ee`, merge checkout `081d5fa220fc2c40c82afdf420dd80126162ebdf`, matches feature runtime `8afc83a…` and baseline `a64d2afd…`. Controls validate, all 16 samples are present, and every child exits 1 because both dual repetitions fail. **Solo 8/8 pass; dual 8/8 fail below-realtime**, with no presentation-stall failure in this paired job. The separate original playback job and previous CI stalls remain distinct evidence.

| Pair / workload | Baseline median | Feature median | Feature change |
| --- | ---: | ---: | ---: |
| AB solo | 0.99928 | 0.99937 | +0.01% |
| BA solo | 0.99939 | 0.99890 | −0.05% |
| AB dual | 0.80120 | 0.79095 | −1.28% |
| BA dual | 0.80041 | 0.78760 | −1.60% |

**Both paired dual feature medians are lower**; this is not a no-regression finding. The difference is smaller than the original Mac signal, but must not be hidden behind all builds missing real-time limits. A second predefined ABBA run on final-head CI is used to check reproducibility; its results and final status are recorded in the PR description. No runtime fix is inferred before that replication. This runner is AMD EPYC 9V45; hardware decoding remains unverified. Same-pair synthetic SHA-256 is `8c7ae793c59a5d9dd3553fb7b69e5a57902491c3132f56c4228d66d5bea4a81f`; both Linux WASM hashes are unchanged across distributions. [Raw sessions, child logs and comparison](evidence/i18n-performance-review/trusted-https-346cbcc/) are permanently archived; [original artifact](https://github.com/Nakiha/VoidPlayer-Web/actions/runs/37150851591/artifacts/11284072481) expires after 30 days.

### Exact-source Mac functional review

Public fast **31/31**, contract **10/10**, and Chromium/WebKit bilingual browser **10/10** passed at `346cbcc`. The conflict-copy reports record **16/16 HTTP 201** successes with both locales and 195/196/197/200-unit boundary inputs. [Compact results and browser reports](evidence/i18n-performance-review/) include tested head and the unchanged runtime digest. Actual current-source screenshots: [playing in English](evidence/i18n-performance-review/playing-en.png), [unsaved workspace and confirmation](evidence/i18n-performance-review/admin-workspace-en-confirm.png), [running measurement](evidence/i18n-performance-review/admin-measurement-en-running.png), [macOS guide](evidence/i18n-performance-review/guide-macos-en.png). The later archive commit changes documentation/evidence only; the PR records its exact-head CI and runtime digest separately.

## Evidence integrity and limits

[SHA-256 manifest](evidence/i18n-performance-review/sha256.json) identifies the archived Mac/previous-CI JSON. CPU sampling, short repeated runs and order balancing cannot rule out every small regression; there is no significance claim. The known mixed Mac and unpaired Linux HTTPS real-time/stall failures remain unresolved playback limitations. This review does not change thresholds, omit failing assertions, claim hardware decoder usage, modify user services or overwrite the archived obsolete Mac patch.
