import { withBrowserFixture } from "./testing/browser-fixture.mjs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const percentile = (values, p) =>
  values.length
    ? [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.floor(values.length * p))
      ]
    : null;
const distribution = (values) => ({
  count: values.length,
  p50Ms: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  p99Ms: percentile(values, 0.99),
  maxMs: values.length ? Math.max(...values) : null,
});
async function probeRanges(url, active) {
  const rows = [];
  while (active()) {
    const started = performance.now(),
      r = await fetch(url, {
        headers: { range: "bytes=0-1023" },
        cache: "no-store",
      });
    const bytes = await r.arrayBuffer();
    assert.equal(r.status, 206);
    assert.equal(bytes.byteLength, 1024);
    rows.push({
      startMs: started,
      endMs: performance.now(),
      durationMs: performance.now() - started,
    });
    await new Promise((r) => setTimeout(r, 10));
  }
  return rows;
}
const engine = process.argv[2] ?? "webkit",
  baseline = process.env.ANALYSIS_BASELINE_DIR;
for (const variant of process.env.ANALYSIS_ONLY_BASELINE
  ? ["baseline"]
  : baseline
    ? ["baseline", "feature"]
    : ["feature"])
  await withBrowserFixture(
    {
      caseName: `bitstream-perf-${variant}`,
      engine,
      staticDir: path.resolve(variant === "baseline" ? baseline : "dist"),
      timeoutMs: 300000,
    },
    async ({ page, ready, url, artifact }) => {
      await ready();
      if (
        await page
          .locator("#identity-welcome")
          .isVisible()
          .catch(() => false)
      )
        await page.locator("#identity-welcome [data-guest]").click();
      // Preserve the application's existing pass/fail policy and bench scenarios.
      if (!process.env.ANALYSIS_SKIP_PLAYBACK_BENCH) {
        const bench = spawn(
          process.execPath,
          ["scripts/bench-playback.mjs", engine, "--headless"],
          {
            env: {
              ...process.env,
              BASE_URL: url,
              BENCH_REPEATS: "1",
              BENCH_DURATION_MS: "2000",
              BENCH_REPORT: artifact("playback.json"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let log = "";
        bench.stdout.on("data", (b) => (log += b));
        bench.stderr.on("data", (b) => (log += b));
        const [code] = await once(bench, "close");
        await writeFile(artifact("playback.log"), log);
        console.log(`${variant} playback bench exit ${code}`);
      }
      if (variant === "baseline" && !process.env.ANALYSIS_CONTENTION_BASELINE)
        return;
      const call = (name, params = {}) =>
        page.evaluate(
          async ({ name, params }) =>
            window.voidPlayer.tools
              .find((t) => t.name === name)
              .execute(params),
          { name, params },
        );
      await page.evaluate(() => {
        window.analysisPerf = { maxLagMs: 0, longTasks: 0, delays: [] };
        let last = performance.now();
        setInterval(() => {
          const now = performance.now();
          window.analysisPerf.maxLagMs = Math.max(
            window.analysisPerf.maxLagMs,
            now - last - 16,
          );
          if (window.analysisPerf.delays.length < 4096)
            window.analysisPerf.delays.push(Math.max(0, now - last - 16));
          last = now;
        }, 16);
        if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
          new PerformanceObserver(
            (list) =>
              (window.analysisPerf.longTasks += list.getEntries().length),
          ).observe({ entryTypes: ["longtask"] });
      });
      let combination = 0;
      const library = await call("list_library"),
        entry = library.entries.find((e) => e.name === "h264_9s_1920x1080.mp4"),
        rows = [];
      for (const input of ["local", "library"])
        for (const decoder of ["hardware", "software"])
          for (const tracks of [1, 2]) {
            for (const slot of ["A", "B"])
              await call("remove_review_track", { slot });
            await call("set_review_color_mode", { mode: "reference" });
            await call("set_reference_decode", { decoder, depth: 2 });
            for (const slot of ["A", "B"].slice(0, tracks)) {
              const selected =
                slot === "A"
                  ? entry
                  : library.entries.find(
                      (e) => e.name === "h265_10s_1920x1080.mp4",
                    );
              if (input === "local")
                await page
                  .locator(`#file-${slot}`)
                  .setInputFiles(path.resolve("fixtures/video", selected.name));
              else await call("load_library_item", { slot, id: selected.id });
              await page.waitForFunction((slot) => {
                const s = window.voidPlayer.getState();
                return (
                  !s.busy &&
                  s.tracks.some((t) => t.slot === slot && t.frame && !t.failure)
                );
              }, slot);
            }
            await page.waitForFunction((tracks) => {
              const s = window.voidPlayer.getState();
              return (
                !s.busy &&
                s.tracks.length === tracks &&
                s.tracks.every((t) => t.frame && !t.failure)
              );
            }, tracks);
            combination++;
            console.log(`contention ${input}/${decoder}/${tracks}`);
            for (const scenario of variant === "baseline"
              ? ["disabled", "cached-playback"]
              : [
                  "disabled",
                  "paused-analysis",
                  "cached-playback",
                  "background-range",
                ]) {
              await call("seek_review", { ptsUs: 0 });
              await page.evaluate(
                () =>
                  (window.analysisPerf = {
                    maxLagMs: 0,
                    longTasks: 0,
                    delays: [],
                  }),
              );
              const cpu = process.cpuUsage(),
                start = performance.now();
              let analysis = null,
                playback = null,
                overlay = null,
                concurrentRange = null;
              if (scenario === "paused-analysis")
                analysis = await call("request_bitstream_analysis", {
                  slot: "A",
                });
              else if (scenario === "cached-playback") {
                // All visible tracks fit a 120 ms prefix in the unchanged 32 MiB cache.
                // Replay inside it for >=1.5 s of actual playing time. Seek/start costs
                // are recorded separately; the ordinary continuous bench stays intact.
                const slots = ["A", "B"].slice(0, tracks);
                for (const slot of variant === "feature" ? slots : []) {
                  await call("request_bitstream_range", {
                    slot,
                    startUs: 0,
                    endUs: 120000,
                  });
                  await page.locator(`#bitstream-${slot}`).click();
                  await page
                    .locator(`#bitstream-overlay-${slot}`)
                    .waitFor({ state: "visible" });
                  await page
                    .locator(`#bitstream-mode-${slot}`)
                    .selectOption("qp");
                }
                await page.evaluate(
                  () =>
                    (window.analysisPerf = {
                      maxLagMs: 0,
                      longTasks: 0,
                      delays: [],
                    }),
                );
                const measured = await page.evaluate(async (slots) => {
                  const api = window.voidPlayer,
                    samples = [],
                    metrics = () =>
                      Object.fromEntries(
                        slots.map((slot) => [
                          slot,
                          document.querySelector(`#bitstream-overlay-${slot}`)
                            ?.analysisMetrics,
                        ]),
                      ),
                    before = metrics();
                  const started = performance.now();
                  let playingWallMs = 0,
                    pauseMaxMs = 0;
                  for (let cycle = 0; cycle < 30; cycle++) {
                    await api.seek(0);
                    await api.play();
                    const playing = performance.now();
                    while (
                      performance.now() - playing < 60 ||
                      !api.getState().tracks.every((t) => t.frame?.ptsUs > 0)
                    ) {
                      if (performance.now() - playing > 2000)
                        throw new Error(
                          "No real advancing presentation within the cached-load sampling budget",
                        );
                      await new Promise((r) => setTimeout(r, 5));
                    }
                    const pause = performance.now();
                    await api.pause();
                    pauseMaxMs = Math.max(
                      pauseMaxMs,
                      performance.now() - pause,
                    );
                    playingWallMs += pause - playing;
                    samples.push(api.getState().playback);
                  }
                  return {
                    before,
                    after: metrics(),
                    playingWallMs,
                    pauseMaxMs,
                    cycleCount: 30,
                    totalWallMs: performance.now() - started,
                    samples,
                    tracks: api.getState().tracks,
                  };
                }, slots);
                const metrics = Object.fromEntries(
                  (variant === "feature" ? slots : []).map((slot) => {
                    const a = measured.before[slot],
                      b = measured.after[slot],
                      presentations = b.presentations - a.presentations,
                      hits = b.cacheHits - a.cacheHits;
                    return [
                      slot,
                      {
                        presentations,
                        hits,
                        hitRatio: hits / presentations,
                        draws: b.draws - a.draws,
                        skippedDraws: b.skippedDraws - a.skippedDraws,
                        resizes: b.resizes - a.resizes,
                        drawTime: distribution(
                          b.drawTimesMs.slice(a.drawTimesMs.length),
                        ),
                      },
                    ];
                  }),
                );
                assert.ok(
                  measured.playingWallMs >= 1500,
                  "sustained cached load contains >=1.5 s of actual playback",
                );
                for (const [slot, m] of Object.entries(metrics)) {
                  assert.ok(
                    m.presentations >= 30 && m.draws >= 30,
                    `${slot}: real repeated presentation/drawing`,
                  );
                  assert.ok(
                    m.hitRatio >= 0.98,
                    `${slot}: sustained cache hit ratio ${m.hitRatio}`,
                  );
                  assert.equal(
                    m.resizes,
                    0,
                    `${slot}: constant geometry does not reset the canvas`,
                  );
                }
                overlay = { windowUs: 120000, ...measured, metrics };
                delete overlay.before;
                delete overlay.after;
                playback = {
                  kind: "bounded-window-replay",
                  hardwareUseVerified: false,
                  measurements: measured.samples,
                  tracks: measured.tracks,
                };
                for (const slot of variant === "feature" ? slots : [])
                  await page.locator(`#bitstream-${slot}`).click();
              } else if (scenario === "background-range") {
                // Range probes start after submission and stop at analysis settlement.
                await page.evaluate(() => {
                  window.analysisProbeActive = true;
                });
                const analysisStarted = performance.now();
                let analysisWindowMs = 0,
                  playbackDone = false,
                  rangeActive = true;
                const playing = call("benchmark_review", {
                  durationMs: 1500,
                }).finally(() => {
                  playbackDone = true;
                });
                const pending = (async () => {
                  const jobs = [];
                  for (
                    let job = 0;
                    job < 32 && (!playbackDone || job < 3);
                    job++
                  ) {
                    const startUs =
                        500000 +
                        ((combination * 12347 + job * 451013) % 8500000),
                      started = performance.now();
                    const result = await call("request_bitstream_range", {
                      slot: "A",
                      startUs,
                      endUs: startUs + 450000,
                    });
                    jobs.push({
                      startUs,
                      endUs: startUs + 450000,
                      elapsedMs: performance.now() - started,
                      result,
                    });
                  }
                  return jobs;
                })().finally(() => {
                  rangeActive = false;
                  analysisWindowMs = performance.now() - analysisStarted;
                  return page.evaluate(() => {
                    window.analysisProbeActive = false;
                  });
                });
                const serverProbes = probeRanges(
                  new URL(`/api/media/${entry.id}?v=${entry.version}`, url),
                  () => rangeActive,
                );
                const probes = page.evaluate(async (item) => {
                  const rows = [];
                  while (window.analysisProbeActive) {
                    const started = performance.now();
                    const r = await fetch(
                      `/api/media/${item.id}?v=${item.version}`,
                      { headers: { range: "bytes=0-1023" }, cache: "no-store" },
                    );
                    const bytes = await r.arrayBuffer();
                    if (r.status !== 206 || bytes.byteLength !== 1024)
                      throw new Error("Concurrent Range response failed");
                    rows.push({
                      startMs: started,
                      endMs: performance.now(),
                      durationMs: performance.now() - started,
                    });
                    await new Promise((r) => setTimeout(r, 10));
                  }
                  return rows;
                }, entry);
                [analysis, playback] = await Promise.all([pending, playing]);
                const ranges = await probes,
                  serverRanges = await serverProbes;
                assert.ok(
                  serverRanges.length >= 3,
                  "independent HTTP samples during analysis",
                );
                assert.ok(
                  analysisWindowMs >= 1500,
                  "background demand spans >=1.5 s alongside foreground playback",
                );
                assert.ok(
                  ranges.length >= 3,
                  "Range latency has concurrent samples, not a post-analysis probe",
                );
                concurrentRange = {
                  ...distribution(ranges.map((r) => r.durationMs)),
                  samples: ranges,
                  server: {
                    ...distribution(serverRanges.map((r) => r.durationMs)),
                    samples: serverRanges,
                  },
                  analysisWindowMs,
                };
              } else {
                let active = true;
                const probes = probeRanges(
                  new URL(`/api/media/${entry.id}?v=${entry.version}`, url),
                  () => active,
                );
                try {
                  playback = await call("benchmark_review", {
                    durationMs: 1500,
                  });
                } finally {
                  active = false;
                }
                const rows = await probes;
                concurrentRange = {
                  phase: "foreground-playback",
                  server: {
                    ...distribution(rows.map((r) => r.durationMs)),
                    samples: rows,
                  },
                };
              }
              const elapsedMs = performance.now() - start,
                cpuMs = process.cpuUsage(cpu);
              const lag = await page.evaluate(() => window.analysisPerf);
              rows.push({
                input,
                decoderPreference: decoder,
                hardwareUseVerified: false,
                tracks,
                scenario,
                elapsedMs,
                mainThread: { ...lag, delays: distribution(lag.delays) },
                overlay,
                concurrentRange,
                serverCpuMs: (cpuMs.user + cpuMs.system) / 1000,
                serverRss: process.memoryUsage().rss,
                analysis: analysis?.metrics ?? analysis,
                playback,
              });
              await writeFile(
                artifact("contention-progress.json"),
                JSON.stringify(rows, null, 2),
              );
            }
          }
      await writeFile(
        artifact("contention.json"),
        JSON.stringify(
          {
            environment: {
              cpu: os.cpus()[0].model,
              cores: os.cpus().length,
              ram: os.totalmem(),
              platform: process.platform,
              node: process.version,
              engine,
            },
            rows,
          },
          null,
          2,
        ),
      );
      console.log(
        `Recorded ${rows.length} isolated analysis contention scenarios`,
      );
    },
  );
