import assert from "node:assert/strict";
import path from "node:path";


export async function run(context) {
const { page, limitsDir, checkpointOnly, call, analyze, hideOverlay, stable, library } = context;


    const limitations = [];
 for (const input of (checkpointOnly ? ["local-file"] : ["local-file", "library"]))
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
        if (depth === 8) assert.equal(state.reason.code, "incomplete-reference-state");
        else assert.equal(result.qp.mean, 17);
        await analyze();
        await page.waitForFunction(()=>document.querySelector('#bitstream-tracks [data-slot="A"]').dataset.state!=='pending');
        if (depth === 10) {
          await page
            .locator("#bitstream-overlay-A")
            .waitFor({ state: "visible" });
          assert.equal(await page.locator('#bitstream-mode [data-mode="qp"]').isDisabled(), false);
          await page.locator('#bitstream-mode [data-mode="depth"]').click();
          assert.equal(result.blockDepth, 'hevc-cu');
          await page.locator('#bitstream-inspect-frame').click();
          const drawer = page.locator('#analysis-overlay-panel #bitstream-frame-inspector');
          const depths = await drawer.locator('[data-bins] button').evaluateAll(buttons => buttons.map(b => Number(b.dataset.key)));
          assert.deepEqual(depths, [...new Set(result.blocks.map(b => b.depth))].sort((a,b) => a-b));
          await page.locator('#bitstream-inspect-frame').click();
          await page.locator('#bitstream-mode [data-mode="qp"]').click();
        } else {
          await page
            .locator("#bitstream-overlay-A")
            .waitFor({ state: "hidden" });
          assert.match(
            await page.locator('#bitstream-tracks [data-slot="A"]').getAttribute('aria-description'),
            /参考状态不完整/,
          );
        }
        limitations.push({
          input,
          depth,
          state,
          confidence: result.confidence,
        });
        await hideOverlay();
      }
return limitations;
}
