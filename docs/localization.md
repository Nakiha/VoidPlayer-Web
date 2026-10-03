# Localization (zh-CN / en)

The player shell, every settings pane, track controls and inspector, annotations, menus, source library, workspace recovery/sharing, drawing and analysis UI support Chinese and English. The follow-up to #38 / #40 also covers the actual `admin/index.html → src/admin/main.ts` entry, all seven administration panels, and the complete connection/certificate guide. `locales/scope.json` classifies every recursive `src/ui/` and `src/admin/` TypeScript module plus the owning entries and connection guide. `locales/messages.json` records 984 messages and their source locations. New modules must be classified; new Chinese literals in scoped files fail validation.

Server-owned root restrictions and cache descriptions carry additive stable codes or structured display fields. Administration errors show localized actionable guidance plus their original cause; server API error text, statuses, enums and stored data remain compatible. Raw log JSON, filenames, metadata, actor/workspace/track names, shared-space names and annotation content stay unchanged. Transport/import/codec diagnostics are still original evidence beside their translated owning UI context. An older server lacking the additive display fields falls back to its original diagnostic strings; new UI and server versions are needed together for fully localized admin detail labels. Machine-facing tool names/descriptions and service logs are stable diagnostic/protocol material, not language-dependent GUI labels.

## Editing messages

Keep a semantic, stable ID and readable Chinese default beside the UI that owns it:

```ts
button.textContent = t(msg('player.frames', '{count, plural, other {# 帧}}'), {count});
```

1. Edit the literal ID/default in `src`; do not put translated text in an enum, persisted key, protocol or log event ID.
2. Run `npm run i18n:extract`. Review `locales/messages.json` and the affected entries in `locales/en.json`.
3. For a new entry, supply `translation`. For a changed default, review the English wording, update its `source` snapshot to the new default and remove `needsReview` (or set it to false). Extraction retains the old snapshot until review; it never silently approves a changed translation.
4. Run `npm run i18n:compile`, then `npm run i18n:check` and `npm run build`.
5. Commit the source, human-maintained English catalog and scope, inventory and generated outputs together.

`src/i18n/generated/*` is generated; do not edit it manually. The Chinese catalog derives directly from source descriptors. The build rejects conflicting IDs, nonliteral descriptors, missing/unknown/stale translations, malformed ICU messages and mismatched parameter names/types. Generated `Sources` and `MessageParameters` also make unknown IDs, stale defaults and missing/extra/wrong typed arguments TypeScript errors. Extraction/compilation is deterministic; `check` verifies both compiled catalogs and the inventory byte for byte.

Use complete messages with typed parameters. ICU plural/select/number formatting comes from the mature MessageFormat parser/compiler. Escape rendered HTML with `th`; prefer `t` with `textContent` and attributes. Never pass user strings through the translator. Technical `mm:ss.mmm` timecodes continue to use `formatTime` and `parseTimeInput`, with ASCII separators and microsecond semantics. Localized dates/numbers are limited to UI summaries and use cached Intl formatters.

## Choice and build cost

Lingui core/build and MessageFormat were evaluated against the existing imperative DOM and Vite/TypeScript setup. Lingui would supply a larger framework-oriented catalog/extraction workflow but would still require explicit DOM refresh ownership here. We selected pinned `@messageformat/core` 3.4.0 and its official `compileModule` output: a small AST extractor recognizes our typed, source-adjacent `msg(id, default)` calls, while ICU parsing, validation and compilation are provided by MessageFormat. The parser/compiler and TypeScript AST API are development dependencies. The native TypeScript 7 application checker is unchanged; the build-only `typescript-ast` alias supplies TypeScript 5.9’s JavaScript AST API.

Vite lowers descriptors to their stable IDs so readable defaults do not duplicate the compiled Chinese catalog in browser chunks. Chinese loads directly as compiled functions; English is one lazy locale chunk, cached after success. Vite emits a retry URL for the compiled module: WebKit caches failed module-map entries, so retries use a fresh URL after a failure. It does not affect normal successful caching. No runtime ICU parser, extraction library or compiler ships in the player. The author catalog remains unified. The added admin/guide words also enter the current player locale chunks; separate HTML entrypoints do not isolate that cost. Keep or split generated subsets according to paired startup measurements, without duplicating author catalogs. Initial player migration results are in [validation](i18n-validation.md); the merged-main comparison is in [admin/guide validation](i18n-admin-validation.md).

References: [MessageFormat compileModule](https://messageformat.github.io/messageformat/api/core.compilemodule/), [MessageFormat](https://messageformat.github.io/messageformat/api/core.messageformat/), [Lingui core](https://lingui.dev/ref/core).

## Locale and component lifecycle

Initialization uses a valid `voidplayer.language` preference, then the ordered browser language list (`zh-*` → `zh-CN`, `en-*` → `en`); other languages fall back to English. The system choice removes the separate preference key. Storage and `languagechange` events update the local interface. A failed load leaves the complete existing locale intact; initial load failure falls back to the compiled Chinese catalog. Only a successful latest request commits preference/`html.lang` and notifies listeners. Late loads cannot override a newer choice. Failed pending loads are evicted for retry; successful compiled catalogs and static labels are cached.

`mountLocalizedShell` mounts once, then uses an inert template to update the original text and attribute bindings. It does not replace the live shell. Dynamic owners subscribe with their lifecycle signal and refresh only their own text/attributes. Admin and guide rows use a weak node-binding registry, traversed only on locale changes: detached rows are collectible, and switching never reloads lists, resets cursors, restarts measurements or overwrites editable values. `localizedText`, `localizedAttribute` and `localizedFragment` keep readable descriptors beside their owner. Shared property views bind both labels and values, including dates, without recreating the panel. Initialization precedes every shell mount; module-level translated dictionaries are factories or locale snapshots. Keep this structure independent of locale. For editable fields, change labels/placeholders and preserve value, focus and selection. For cached panels, expose a `localize` path: inspector/dock/card rows, source rows, choice menu buttons and color-flow labels retain their nodes and handlers. No language change calls session seek/pause/load or rebuilds decoders. Translation is absent from worker/decode/presentation and progress rendering paths; only UI lifecycle/label boundaries call compiled functions.

The compiled pseudo catalog is QA-only. Development supports `?pseudo-locale`; the dedicated layout suite builds with `VITE_I18N_PSEUDO=1` into `.run/i18n-pseudo-dist`, leaving the ordinary distribution untouched. Normal production builds cannot activate pseudo mode by URL. Certificate instructions are complete static rich sentences. Build validation allows only the same ordered `<strong>` tags in both catalogs, with no variables or attributes; pseudo expansion preserves these tags. All user values continue through text/attribute escaping. Pseudo expands literal text without changing placeholder syntax; settings controls wrap instead of overflowing, and the font stack contains PingFang SC, Microsoft YaHei and Noto Sans CJK SC fallbacks.

## Verification and comparison

All cases use #39’s manifest and public fixture/lifecycle framework:

```sh
node scripts/run-tests.mjs fast
node scripts/run-tests.mjs contract
node scripts/run-tests.mjs ci-i18n
# Both isolated checkouts must have dist built with the same Node/Vite/core.
I18N_BASELINE_ROOT=/path/to/baseline node scripts/run-tests.mjs perf \
  --case perf-i18n-chromium,perf-i18n-webkit
# Optional same comparison with supported Chromium H.264 inputs:
I18N_BASELINE_ROOT=/path/to/baseline I18N_MEDIA_MODE=webcodecs \
  node scripts/run-tests.mjs perf --case perf-i18n-chromium
# Optional WindowServer run; owns and closes only its Playwright windows:
I18N_BASELINE_ROOT=/path/to/baseline I18N_HEADFUL=1 \
  node scripts/run-tests.mjs perf --case perf-i18n-chromium
```

The required `ci-i18n` cases run after the original uncovered suite in the existing browser job. Both suites upload separate artifacts. Existing tests explicitly select Chinese for their unchanged Chinese assertions; the new cases test English/system/invalid/stored preferences independently. Performance cases are informational because some existing platform/media combinations miss the baseline throughput floor; they still assert the original playback limits and exit nonzero on failure. They always save both raw comparison reports before assessing budgets. Do not reinterpret such a failed cell as a pass or alter its thresholds. See the validation report for the measured environment, budgets, results and remaining limitations.

Performance review after copy-name and plural fixes: [counterbalanced Mac and trusted HTTPS evidence](i18n-performance-review.md).
