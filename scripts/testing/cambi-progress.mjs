import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cambiFixture } from "../../test/helpers/native-cambi.mjs";
import { until } from "../../test/helpers/native-vmaf.mjs";
import { chooseTestGuest } from "../test-identity.mjs";

/** Real pixels, Worker, database and HTTP. Only delivery of the first persisted
 * frame is held so the running UI and cooperative stop can be observed. */
export async function checkCambiProgress(browser, engine) {
  const f = await cambiFixture({
    codec: "hevc",
    depth: 8,
    sequence: true,
    staticDir: "dist",
  });
  let context,
    page,
    release = () => {},
    seen = false;
  const errors = [];
  const dir = path.resolve(`.run/native-cambi/progress-${engine}`);
  await mkdir(dir, { recursive: true });
  const gate = new Promise((resolve) => (release = resolve));
  const runner = f.service.library.qualityCambi.runner,
    run = runner.runCambi.bind(runner);
  runner.runCambi = (id, input, signal, hooks) =>
    run(id, input, signal, {
      ...hooks,
      streamFrame: async (...args) => {
        await hooks.streamFrame(...args);
        if (!seen) {
          seen = true;
          await gate;
        }
      },
    });
  try {
    context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1000, height: 820 },
    });
    await context.addInitScript(() => {
      window.__cambiProgressTrace = [];
      for (const name of [
        "click",
        "voidplayer-identity-scope",
        "voidplayer-identity-change",
      ])
        window.addEventListener(
          name,
          (event) => {
            const trace = window.__cambiProgressTrace;
            if (trace.length < 100)
              trace.push({
                event: name,
                id: event.target?.closest?.("button")?.id,
                job: event.target?.closest?.("[data-cambi-job]")?.dataset
                  .cambiJob,
                state: event.detail?.state,
                actor: event.detail?.actor?.id,
                at: performance.now(),
              });
          },
          true,
        );
    });
    await context.addCookies([
      { name: "voidplayer-user", value: f.actor, url: f.base },
    ]);
    context.on("page", (page) =>
      page.on("pageerror", (error) => errors.push(error.message)),
    );
    const job = (
      await f.json("/api/quality/cambi/jobs", f.input, "browser-progress")
    ).job;
    await until(() => seen, Boolean);
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(f.base + "/admin?qualityView=cambi#quality");
    await chooseTestGuest(page);
    await page.locator(`[data-cambi-job="${job.id}"]`).click();
    await page.locator('[data-cambi-frame="0"]').waitFor();
    await page
      .locator("#cambi-validation")
      .filter({ hasText: "暂存" })
      .waitFor();
    // A real cross-document notification is only a hint. Confirming the same
    // cookie actor must restore the selected durable job with fresh reads.
    const hint = await context.newPage();
    await hint.goto(f.base + "/llms.txt");
    await hint.evaluate(() =>
      localStorage.setItem(
        "voidplayer.identity",
        "untrusted-notification-" + Date.now(),
      ),
    );
    await hint.close();
    await page.locator('[data-cambi-frame="0"]').waitFor();
    assert.equal(await page.locator("#cambi-publish").isDisabled(), true);
    const [preview] = await Promise.all([
      context.waitForEvent("page"),
      page.locator('[data-cambi-inspect="0"]').click(),
    ]);
    await preview.waitForFunction(
      () =>
        document.getElementById("cambi-view")?.dataset.state === "provisional",
    );
    assert.equal(
      await preview.locator(".frame-stage").first().isVisible(),
      false,
    );
    const provisional = await f.json(
      `/api/quality/cambi/jobs/${job.id}/frames`,
    );
    assert.equal(
      await preview.locator("#cambi-heatmap").getAttribute("data-sha256"),
      provisional.entries[0].heatmaps[0].sha256,
    );
    await preview.setViewportSize({ width: 390, height: 820 });
    await preview.screenshot({
      path: path.join(dir, "provisional.png"),
      fullPage: true,
    });
    await preview.close();
    const stopping = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/stop-and-keep") &&
        r.request().method() === "POST",
    );
    await page.locator("#cambi-stop-keep").click();
    assert.equal((await stopping).status(), 200);
    assert.equal(
      (await f.json(`/api/quality/cambi/jobs/${job.id}`)).stopRequested,
      true,
    );
    release();
    const done = await f.wait(job.id);
    assert.equal(done.state, "partial");
    await page.locator("#cambi-title").filter({ hasText: "partial" }).waitFor();
    await page
      .locator("#cambi-validation")
      .filter({ hasText: "未评分范围不计零分" })
      .waitFor();
    await page.waitForFunction(
      () => !document.getElementById("cambi-publish").disabled,
    );
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-cambi-inspect="0"]')
          ?.href.includes("preview=1"),
    );
    const [viewer] = await Promise.all([
      context.waitForEvent("page"),
      page.locator('[data-cambi-inspect="0"]').click(),
    ]);
    await viewer.waitForFunction(
      () => document.getElementById("cambi-view")?.dataset.state === "ready",
    );
    assert.equal(
      await viewer.locator(".frame-stage").first().isVisible(),
      true,
    );
    assert.ok(
      (await viewer
        .locator(".frame-stage")
        .first()
        .locator("canvas:visible")
        .count()) > 0,
      "verified source has a visible presenter surface",
    );
    await viewer.goto(
      `${f.base}/quality.html?cambi=1&cambiJob=${job.id}&index=63`,
    );
    await viewer.waitForFunction(
      () => document.getElementById("cambi-view")?.dataset.state === "ready",
    );
    await viewer.close();
    await page
      .locator("#cambi-text")
      .fill("Review validated partial CAMBI evidence");
    const publishing = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/candidates") &&
        r.request().method() === "POST",
    );
    await page.locator("#cambi-publish").click();
    assert.equal((await publishing).status(), 200);
    await page.locator("[data-cambi-candidate]").waitFor();
    const summary = await f.json(`/api/quality/cambi/jobs/${job.id}/result`);
    assert.equal(summary.coverage.scored, 64);
    assert.equal(summary.coverage.selected, 192);
    assert.equal(summary.coverage.unscored, 128);
    const receipt = await f.json(
      `/api/quality/cambi/jobs/${job.id}/candidates`,
    );
    const mark = await f.json(
      "/api/annotations/spaces/default/" + receipt.createdIds[0],
    );
    assert.equal(
      mark.document.mark.cambiEvidence[0].value.coverage.unscored,
      128,
    );
    await page.setViewportSize({ width: 390, height: 820 });
    // Paginated raw witnesses can exceed Linux WebKit's 32767px image limit.
    // Capture the partial status in a bounded viewport; keep all frame assertions.
    await page.locator("#cambi-title").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(dir, "partial.png"),
      fullPage: false,
    });
    assert.deepEqual(errors, []);
    return {
      jobId: job.id,
      provisionalPreview: true,
      sourcePreviewRefusedUntilVerified: true,
      partialCoverage: summary.coverage,
      sharedCandidate: receipt.createdIds[0],
      errors,
    };
  } catch (error) {
    await writeFile(
      path.join(dir, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          errors,
          ui: await page
            ?.evaluate(() => ({
              trace: window.__cambiProgressTrace,
              status: document.getElementById("cambi-status")?.textContent,
              title: document.getElementById("cambi-title")?.textContent,
              hidden: document.getElementById("cambi-detail")?.hidden,
              history: document.getElementById("cambi-history")?.textContent,
            }))
            .catch(() => null),
        },
        null,
        2,
      ),
    );
    await page
      ?.screenshot({ path: path.join(dir, "failure.png"), fullPage: false })
      .catch(() => {});
    throw error;
  } finally {
    release();
    await context?.close();
    await f.close();
  }
}
