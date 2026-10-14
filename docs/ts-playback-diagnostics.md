# TS presentation readiness evidence

The existing TS matrix keeps its four local/library × browser/software cells, 2,000 ms benchmark request, strict positive-draw assertion and performance limits. Repeated CI zero-presentation failures remain unresolved; passing a positive-draw check does not make a failed benchmark report pass.

Playback measurements now retain the first actual timeline advance and first successful canvas presentation in milliseconds. Missing events remain null. Queue snapshots include first/last queued PTS and elapsed time waiting for `generator.next()`; this wait may include IO, indexing or decoding. These fields do not change the clock, queue, renderer or benchmark interval.

TS rows collect bounded test-only evidence: at most 256 Worker request/reply metadata events, 128 session samples at 75 ms, and 128 main-thread longtasks. Reply latency includes main-thread dispatch delay and is not a pure decoder timing. Observers, the sampling timer, Worker listeners and the temporary postMessage wrapper are restored after the benchmark. Transferable buffers/frames are never inspected or consumed by the monitor. Failed reports and thrown benchmark errors remain failures.

A minimal existing checkpoint can be run without the full matrix:

```sh
node scripts/check-bitstream-analysis-browser.mjs chromium --matrix-only --matrix-part=ts --checkpoint-only --playback-profile
```

`--checkpoint-only` retains its existing local/software scope. The optional Chromium CPU profile is intrusive diagnostic evidence and is not a performance acceptance run. Normal CI omits that profiler and keeps the full matrix. Artifacts include row-specific report/readiness JSON and optional CPU-profile JSON.

The committed instrumented local result has first advance/presentation around 151 ms and speed 0.109; its benchmark fails below-realtime and presentation-stall. Seventeen observed main-thread longtasks total about 2.75 seconds. Most CPU samples are attributed to native `(program)` work, which does not establish a GPU or decoder causal root. Exact build/core digests and raw Worker events are in `docs/evidence/ts-playback-readiness/chromium-local-software.json`. This is the existing FFmpeg TS route, not acceptance evidence for the new JS path.
