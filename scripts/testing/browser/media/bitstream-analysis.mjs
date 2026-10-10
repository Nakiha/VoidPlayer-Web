import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withBrowserFixture } from "../../browser-fixture.mjs";
import { repositoryRoot } from "../../manifest.mjs";
const matrix = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "scripts/bitstream-analysis-matrix.json"),
    "utf8",
  ),
);
const engine = process.argv[2] ?? "webkit";
const limitsDir = path.join(
  repositoryRoot,
  ".run",
  "analysis-limit-fixtures",
  engine,
);
await mkdir(limitsDir, { recursive: true });
for (const depth of [8, 10])
  execFileSync("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:size=64x64:rate=1:duration=1",
    "-an",
    ...(depth === 8
      ? [
          "-c:v",
          "libx264",
          "-flags",
          "+ilme+ildct",
          "-x264-params",
          "tff=1:bframes=0",
        ]
      : [
          "-c:v",
          "libx265",
          "-x265-params",
          "pools=1:frame-threads=1:log-level=error:bframes=0",
        ]),
    "-pix_fmt",
    depth === 8 ? "yuv420p" : "yuv420p10le",
    path.join(limitsDir, `depth-${depth}.mp4`),
  ]);
await withBrowserFixture(
  {
    caseName: "bitstream-analysis",
    roots: [path.join(repositoryRoot, "fixtures/video"), limitsDir],
    engine,
    pageOptions: { deviceScaleFactor: 2 },
    timeoutMs: 600000,
  },
  async ({ page, ready, artifact }) => {
    const errors = [],
      requests = [],
      rows = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) =>
      requests.push({ url: request.url(), method: request.method() }),
    );
    await ready();
    if (
      await page
        .locator("#identity-welcome")
        .isVisible()
        .catch(() => false)
    )
      await page.locator("#identity-welcome [data-guest]").click();
    const call = (name, params = {}) =>
      page.evaluate(
        async ({ name, params }) =>
          window.voidPlayer.tools.find((t) => t.name === name).execute(params),
        { name, params },
      );
    const stable = () =>
      page.waitForFunction(() => {
        const s = window.voidPlayer.getState();
        return (
          !s.busy &&
          s.tracks.length &&
          s.tracks.every((t) => t.frame && !t.failure)
        );
      });
    const library = await call("list_library");
    for (const input of ["local-file", "library"])
      for (const decoding of ["browser", "software"])
        for (const row of matrix.rows) {
          console.log(`${engine}: ${input}/${decoding}/${row.codec}`);
          await call("remove_review_track", { slot: "A" });
          await call("set_review_color_mode", {
            mode: decoding === "software" ? "reference" : "browser",
          });
          if (decoding === "software")
            await call("set_reference_decode", {
              decoder: "software",
              depth: 2,
            });
          const start = requests.length;
          if (input === "local-file")
            await page
              .locator("#file-A")
              .setInputFiles(
                path.join(repositoryRoot, "fixtures/video", row.fixture),
              );
          else
            await call("load_library_item", {
              id: library.entries.find((e) => e.name === row.fixture).id,
              slot: "A",
            });
          await stable();
          assert.equal(
            await page.locator(".analysis-picture-overlay").count(),
            0,
            "disabled analysis allocates no overlay",
          );
          assert.ok(
            !requests
              .slice(start)
              .some((r) => /voidplayer-analysis|local-worker/.test(r.url)),
            "disabled analysis does not load its worker or core",
          );
          const token = await call("get_presented_frame", { slot: "A" });
          assert.ok(
            token.picture,
            `${engine}/${input}/${decoding}/${row.codec}: exact playback identity`,
          );
          const result = await call("request_bitstream_analysis", {
            slot: "A",
          });
          assert.equal(result.confidence, row.expected);
          assert.deepEqual(result.picture, token.picture);
          assert.equal(result.sourcePtsUs, token.sourcePtsUs);
          assert.ok(result.blocks.length > 0);
          if (input === "library")
            assert.ok(
              !requests
                .slice(start)
                .some((r) =>
                  /voidplayer-analysis\.(js|wasm)|local-worker/.test(r.url),
                ),
              "library analysis loads no browser decoder",
            );
          else
            assert.ok(
              !requests
                .slice(start)
                .some(
                  (r) =>
                    r.method === "POST" && /bitstream-analysis/.test(r.url),
                ),
              "local files are never uploaded",
            );
          const second = await call("request_bitstream_analysis", {
            slot: "A",
          });
          assert.deepEqual(second.blocks, result.blocks);
          assert.equal(
            (await call("get_bitstream_analysis_state")).cacheHit,
            true,
          );
          if (
            input === "local-file" &&
            decoding === "browser" &&
            row.codec === "h264"
          ) {
            let release;
            const blocked = new Promise((r) => {
              release = r;
            });
            const pattern = "**/assets/controller-*.js";
            await page.route(pattern, async (route) => {
              await blocked;
              await route.continue();
            });
            const requested = page.waitForRequest(pattern, { timeout: 30000 });
            try {
              await page.locator("#bitstream-A").click();
              await requested;
              await call("step_review", { direction: 1 });
              release();
              const cold = page.locator("#bitstream-overlay-A");
              await cold.waitFor({ state: "attached" });
              assert.ok(
                await cold.isHidden(),
                "lazy overlay loading never changes the click-time picture demand",
              );
              assert.equal(
                (await call("get_bitstream_analysis_state")).cacheHit,
                true,
                "superseded activation starts no replacement request",
              );
            } finally {
              release();
              await page.unroute(pattern);
            }
            await page.locator("#bitstream-A").click();
            await call("seek_review", { ptsUs: 0 });
          }
          await page.locator("#bitstream-A").click();
          const overlay = page.locator("#bitstream-overlay-A");
          await overlay.waitFor({ state: "visible" });
          await page
            .locator("#bitstream-status-A")
            .waitFor({ state: "visible" });
          assert.equal(
            await page.locator("#bitstream-A").getAttribute("aria-pressed"),
            "true",
          );
          assert.match(
            await page.locator("#bitstream-status-A").innerText(),
            /AU/,
          );
          assert.equal(
            await overlay.getAttribute("data-picture"),
            JSON.stringify([
              token.picture.sourceVersion,
              token.picture.stream,
              token.picture.configuration,
              token.picture.au,
              0,
              0,
              "frame",
            ]),
          );
          for (const mode of ["qp", "modes", "blocks"]) {
            await page.locator("#bitstream-mode-A").selectOption(mode);
            assert.ok(await overlay.isVisible());
            if (
              input === "local-file" &&
              decoding === "browser" &&
              row.codec === "h264" &&
              mode === "qp"
            )
              await page.screenshot({ path: artifact("qp-overlay.png") });
          }
          const dimensions = await overlay.evaluate((c) => ({
            width: c.width,
            height: c.height,
            cssWidth: c.getBoundingClientRect().width,
          }));
          assert.ok(
            dimensions.width >= dimensions.cssWidth * 1.9,
            "DPR 2 overlay",
          );
          const box = await overlay.boundingBox();
          await page.evaluate(
            ({ x, y }) => {
              const stage = document.getElementById("stage-A");
              stage.dispatchEvent(
                new PointerEvent("pointermove", {
                  clientX: x,
                  clientY: y,
                  bubbles: true,
                }),
              );
            },
            { x: box.x + box.width / 2, y: box.y + box.height / 2 },
          );
          const tooltip = page.locator("#stage-A .bitstream-hit-tooltip");
          await tooltip.waitFor({ state: "visible" });
          assert.match(
            await tooltip.innerText(),
            /QP/,
            "block hit information remains visible after UI tooltip migration",
          );
          await call("step_review", { direction: 1 });
          if (await overlay.isVisible()) {
            const next = await call("get_presented_frame", { slot: "A" });
            assert.notEqual(next.picture.au, token.picture.au);
            assert.equal(
              await overlay.getAttribute("data-picture"),
              JSON.stringify([
                next.picture.sourceVersion,
                next.picture.stream,
                next.picture.configuration,
                next.picture.au,
                0,
                0,
                "frame",
              ]),
              "only an exact next-picture cache hit may remain visible",
            );
          }
          await call("seek_review", { ptsUs: 0 });
          await overlay.waitFor({ state: "visible" });
          await page.locator("#bitstream-A").click();
          assert.equal(
            await page.locator(".analysis-picture-overlay").count(),
            0,
            "off releases canvas",
          );
          const range = await call("request_bitstream_range", {
            slot: "A",
            startUs: 0,
            endUs: 100000,
          });
          assert.ok(
            range.pictures >= 5,
            "half-open range publishes picture chunks",
          );
          if (decoding === "browser" && row.codec === "h264") {
            await call("request_bitstream_range", {
              slot: "A",
              startUs: 0,
              endUs: 120000,
            });
            await call("seek_review", { ptsUs: 0 });
            await page.locator("#bitstream-A").click();
            await overlay.waitFor({ state: "visible" });
            await page.locator("#bitstream-mode-A").selectOption("qp");
            const sustained = await page.evaluate(async () => {
              const api = window.voidPlayer,
                canvas = document.querySelector("#bitstream-overlay-A"),
                before = canvas.analysisMetrics;
              let playingWallMs = 0;
              for (let i = 0; i < 20; i++) {
                await api.seek(0);
                await api.play();
                const start = performance.now();
                while (
                  performance.now() - start < 60 ||
                  !api.getState().tracks.every((t) => t.frame?.ptsUs > 0)
                ) {
                  if (performance.now() - start > 2000)
                    throw new Error("No advancing cached presentation");
                  await new Promise((r) => setTimeout(r, 5));
                }
                playingWallMs += performance.now() - start;
                await api.pause();
              }
              const after = canvas.analysisMetrics;
              return {
                playingWallMs,
                presentations: after.presentations - before.presentations,
                hits: after.cacheHits - before.cacheHits,
                draws: after.draws - before.draws,
                resizes: after.resizes - before.resizes,
              };
            });
            assert.ok(
              sustained.playingWallMs >= 1000 &&
                sustained.presentations >= 20 &&
                sustained.draws >= 20,
            );
            assert.ok(
              sustained.hits / sustained.presentations >= 0.98,
              "CI sustained cache-hit load",
            );
            assert.equal(
              sustained.resizes,
              0,
              "constant geometry preserves canvas storage",
            );
            await page.locator("#bitstream-A").click();
            rows.push({ kind: "sustained-cache", input, ...sustained });
          }
          await call("set_review_track_offset", {
            slot: "A",
            offsetUs: 100000,
          });
          await call("seek_review", { ptsUs: 100000 });
          assert.deepEqual(
            (await call("get_presented_frame", { slot: "A" })).picture,
            token.picture,
            "offset is not persistent picture identity",
          );
          await call("set_review_track_offset", { slot: "A", offsetUs: 0 });
          const report = await call("benchmark_review", { durationMs: 2000 });
          assert.equal(report.error, null);

          assert.equal(report.staleAfterPause, false);
          assert.ok(report.measurements.tracks.A.drawn > 0);
          rows.push({
            codec: row.codec,
            input,
            decoding,
            decoder: (await call("get_review_session")).tracks[0].decoder,
            token,
            metrics: result.metrics,
            range,
            playback: report,
          });
        }
    // A response for a frame superseded during the request must never become visible.
    await call("seek_review", { ptsUs: 400000 });
    await page.locator("#bitstream-A").click();
    // Establish that the old-picture demand exists before superseding it;
    // otherwise an async UI import can start a legitimate new-picture request.
    await page.waitForFunction(
      () =>
        window.voidPlayer.tools
          .find((t) => t.name === "get_bitstream_analysis_state")
          .execute({}).state === "pending",
    );
    await call("step_review", { direction: 1 });
    await page.waitForFunction(
      () =>
        window.voidPlayer.tools
          .find((t) => t.name === "get_bitstream_analysis_state")
          .execute({}).state !== "pending",
    );
    assert.ok(
      await page.locator("#bitstream-overlay-A").isHidden(),
      "late analysis never paints a superseded picture",
    );
    await page.locator("#bitstream-A").click();
    await call("seek_review", { ptsUs: 6000000 });
    const cancelled = await page.evaluate(async () => {
      const tool = (name) =>
        window.voidPlayer.tools.find((t) => t.name === name);
      const pending = tool("request_bitstream_analysis").execute({ slot: "A" });
      await Promise.resolve();
      tool("cancel_bitstream_analysis").execute({});
      try {
        await pending;
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(cancelled, true, "explicit cancellation settles the request");
    await call("seek_review", { ptsUs: 0 });
    const healthy = await call("get_review_session");
    assert.equal(healthy.error, null);
    assert.ok(healthy.tracks.every((t) => !t.failure));

    const limitations = [];
    for (const input of ["local-file", "library"])
      for (const depth of [8, 10]) {
        await call("remove_review_track", { slot: "A" });
        await call("set_review_color_mode", { mode: "reference" });
        await call("set_reference_decode", { decoder: "software", depth: 2 });
        const name = `depth-${depth}.mp4`;
        if (input === "local-file")
          await page
            .locator("#file-A")
            .setInputFiles(path.join(limitsDir, name));
        else
          await call("load_library_item", {
            slot: "A",
            id: library.entries.find((e) => e.name === name).id,
          });
        await stable();
        const result = await call("request_bitstream_analysis", { slot: "A" });
        const state = await call("get_bitstream_analysis_state");
        assert.equal(state.state, depth === 8 ? "unsupported" : "ready");
        assert.equal(
          state.reason.code,
          depth === 8 ? "incomplete-reference-state" : "unsupported-qp-depth",
        );
        await page.locator("#bitstream-A").click();
        await page.waitForFunction(
          () =>
            !document
              .querySelector("#bitstream-status-A")
              .textContent.includes("正在分析当前帧"),
        );
        if (depth === 10) {
          await page
            .locator("#bitstream-overlay-A")
            .waitFor({ state: "visible" });
          assert.equal(
            await page
              .locator('#bitstream-mode-A option[value="qp"]')
              .isDisabled(),
            true,
          );
          assert.match(
            await page.locator("#bitstream-status-A").innerText(),
            /位深.*QP/,
          );
        } else {
          await page
            .locator("#bitstream-overlay-A")
            .waitFor({ state: "hidden" });
          assert.match(
            await page.locator("#bitstream-status-A").innerText(),
            /参考状态不完整/,
          );
        }
        limitations.push({
          input,
          depth,
          state,
          confidence: result.confidence,
        });
        await page.locator("#bitstream-A").click();
      }
    assert.deepEqual(errors, []);
    await writeFile(
      artifact("matrix.json"),
      JSON.stringify({ engine, rows, limitations, errors }, null, 2),
    );
    await page.screenshot({ path: artifact("final.png") });
    console.log(
      `PASS ${engine}: ${rows.filter((r) => r.codec).length} real local/library decode combinations plus sustained-load and capability regressions, picture/offset/cache/range/overlay/cancel isolation`,
    );
  },
);
