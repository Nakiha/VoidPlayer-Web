import { withBrowserFixture } from "./testing/browser-fixture.mjs";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
const engine = process.argv[2] ?? "webkit",
  baseline = process.env.ANALYSIS_BASELINE_DIR;
for (const variant of baseline ? ["baseline", "feature"] : ["feature"])
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
      if (variant === "baseline") return;
      const call = (name, params = {}) =>
        page.evaluate(
          async ({ name, params }) =>
            window.voidPlayer.tools
              .find((t) => t.name === name)
              .execute(params),
          { name, params },
        );
      await page.evaluate(() => {
        window.analysisPerf = { maxLagMs: 0, longTasks: 0 };
        let last = performance.now();
        setInterval(() => {
          const now = performance.now();
          window.analysisPerf.maxLagMs = Math.max(
            window.analysisPerf.maxLagMs,
            now - last - 16,
          );
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
              if (input === "local")
                await page
                  .locator(`#file-${slot}`)
                  .setInputFiles(path.resolve("fixtures/video", entry.name));
              else await call("load_library_item", { slot, id: entry.id });
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
            for (const scenario of [
              "disabled",
              "paused-analysis",
              "cached-playback",
              "background-range",
            ]) {
              await call("seek_review", { ptsUs: 0 });
              await page.evaluate(
                () => (window.analysisPerf = { maxLagMs: 0, longTasks: 0 }),
              );
              const cpu = process.cpuUsage(),
                start = performance.now();
              let analysis = null,
                playback = null;
              if (scenario === "paused-analysis")
                analysis = await call("request_bitstream_analysis", {
                  slot: "A",
                });
              else if (scenario === "cached-playback") {
                await call("request_bitstream_range", {
                  slot: "A",
                  startUs: 0,
                  endUs: 100000,
                });
                await page.locator("#bitstream-A").click();
                await page
                  .locator("#bitstream-overlay-A")
                  .waitFor({ state: "visible" });
                playback = await call("benchmark_review", { durationMs: 1500 });
                await page.locator("#bitstream-A").click();
              } else if (scenario === "background-range") {
                // Begin an uncached rear range while the foreground presenter is active.
                const pending = call("request_bitstream_range", {
                  slot: "A",
                  startUs: 3000000 + combination * 150000,
                  endUs: 3100000 + combination * 150000,
                });
                playback = await call("benchmark_review", { durationMs: 1500 });
                analysis = await pending;
              } else
                playback = await call("benchmark_review", { durationMs: 1500 });
              const elapsedMs = performance.now() - start,
                cpuMs = process.cpuUsage(cpu);
              const lag = await page.evaluate(() => window.analysisPerf);
              const rangeStart = performance.now();
              await page.evaluate(async (id) => {
                const lib = await window.voidPlayer.tools
                  .find((t) => t.name === "list_library")
                  .execute({});
                const item = lib.entries.find((e) => e.id === id);
                const r = await fetch(
                  `/api/media/${item.id}?v=${item.version}`,
                  { headers: { range: "bytes=0-1023" } },
                );
                if (!r.ok) throw new Error("Range failed");
                await r.arrayBuffer();
              }, entry.id);
              rows.push({
                input,
                decoder,
                tracks,
                scenario,
                elapsedMs,
                mainThread: lag,
                serverCpuMs: (cpuMs.user + cpuMs.system) / 1000,
                rangeResponseMs: performance.now() - rangeStart,
                serverRss: process.memoryUsage().rss,
                analysis: analysis?.metrics ?? analysis,
                playback,
              });
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
