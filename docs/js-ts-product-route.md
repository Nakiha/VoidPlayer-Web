# First JS TS product admission

Finite 188-byte, single-program, video-only H.264 TS with stable complete single-packet PSI, one static SPS/PPS, progressive single-slice pictures, a verified initial IDR and unambiguous clocks uses the shared JS packet source. File and version-pinned library opens both retain the actual verified source/index in the packet Worker. A one-use Worker session token associates admission with initialization; serialized metadata alone cannot mint decoder identities.

WebCodecs and packet-fed WASM decode the same source/index. Native capability or first-frame decoding failures can switch to the packet decoder. Admitted input, index, clock, resource and decoder errors cannot select FFmpeg container demux. Explicit combinations outside this stage—audio/private or unconfirmed inventory, HEVC/MPEG-2/VVC TS, multiple programs/tracks/slices/configurations, interlaced pictures, changing/fragmented PSI and other file forms—remain on the logged unmigrated route before decoding. A bad CRC encountered while validating an admitted static stream is a hard failure, not a decoder fallback. This is a partial TS migration; the container demux cannot yet be removed.

Actual pipeline logs name `js-ts-packets` and `js-ts-packet-index`, and media metadata uses `packet-locators`; locators are opaque, never payload offsets. Picture streams include PID and `mediabunny-1.55.7-ts-packets-v2`. Raw 90 kHz PTS/DTS and missingness remain separate from logical decoder microseconds. Unknown original PTS never creates an exact presented picture association; missing DTS remains null.

Single, range and stream analysis receive the playback index identity and select an independent JS source/reader. Local files stay in a separate browser Worker; library analysis stays in a server Worker. The analysis codec core consumes packets, without opening the old TS container API. The existing runner verifies exact actual presented tokens and overlays across native/software, local/library, seek, offset, cancellation and cached analysis.

Remaining work: trusted source-owned index reuse across Worker/server/restart boundaries, measured IO/memory/latency comparisons, HEVC/Matroska admission and full capability inventories, and actual overlapping playback/analysis WASM demux removal. Current independent analysis can rebuild its JS metadata plan; a fresh runtime does not trust a document's own completion flags. The first scan is substantial payload IO, not zero-IO metadata-only work.

## Desktop performance evidence

The normal matrix remains headless, with all four cells and unchanged 2,000 ms request, assertions and performance limits. When that environment uses software GL, one explicitly owned desktop run can be made with:

```sh
node scripts/check-bitstream-analysis-browser.mjs chromium --matrix-only --matrix-part=ts --desktop-performance
```

This does not mark hardware decoding verified. It records page visibility in the benchmark environment, in a separate `bitstream-analysis-matrix-ts-desktop-chromium` artifact directory. Physical scanout remains unverified. Headless negative performance reports remain evidence and cannot be replaced by desktop results or a green functional assertion.

[Recorded matrix and original bench outcomes](evidence/js-ts-product-route.json) use the same product source digest. WebKit headless and Chromium desktop each pass four TS performance cells; Chromium headless fails all four performance cells while retaining functional assertions. The original four-scene, three-repeat bench passes 12/12 in WebKit and has 0/12 passing cells in Chromium headless. All original limits and failures are retained. No physical decoder or scanout claim is made.

## Review corrections and artifact boundaries

All complete PSI sections in a selected PAT/PMT packet are checked, including adaptation/pointer bounds, stuffing and each CRC. A valid changed second section remains an explicitly unmigrated dynamic map; malformed envelope or CRC is a hard failure. Identical repeated complete sections remain valid. Non-current or fragmented/multi-section tables remain explicitly outside this static stage. Real Worker admission tests supplement the controlled guard injections.

Actual Source scan counters now reach `prepare-ts` and a fresh TS init through `index-progress`; only genuine reads and packet enumeration produce updates. The scan IO quota applies with or without an observer and stops applying after indexing, so repeated legitimate decode seeks do not exhaust a lifetime scan quota. Actual delayed HTTP Range scans outlive two shortened idle periods; a held Range still times out, and admission cancellation terminates its own Worker.

The [initial CI matrix](evidence/js-ts-product-route-ci-initial.json) has eight functional passes and **zero performance passes** across Chromium/WebKit. Historical local reports above used separately built playback bytes. The [artifact comparison](evidence/js-ts-core-provenance-comparison.json) verifies equal source/tool locks and glue/analysis files, but distinct playback WASM globals/code/data. Embedded `./src/` versus `src/` labels and dav1d git-description strings differ; this is not a proof of binary semantic equivalence. CI restored playback artifacts from run 38443480797. Final local checks use the exact downloaded CI artifacts; the old local WebKit/desktop passing performance reports are not current CI or final-artifact acceptance. Performance and physical hardware/scanout acceptance remain open.
