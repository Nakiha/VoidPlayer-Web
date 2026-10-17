import assert from "node:assert/strict";
import path from "node:path";
import { selectDiagrams, inspectCurrentWindow, requestInspection } from '../controls.mjs';


export async function run(context) {
const { page, artifact, phase, checkpoint, rows, call, stable, library, gate } = context;


    // Hold real FLV playback completion and the independent analysis frontier
    // at 128 validated packets, beyond several complete GOPs. Neither
    // subscriber may treat this prefix as EOF.
    for (const cancel of [false, true]) {
      await call('remove_review_track', { slot: 'A' });
      await call('set_review_color_mode', { mode: 'browser' });
      const gatedId = library.entries.find(e => e.name === `incremental-${cancel ? 'cancel' : 'continue'}.flv`).id;
      gate.hold(gatedId);
      await call('load_library_item', { slot: 'A', id: gatedId });
      await page.waitForFunction(() => window.voidPlayer.getState().tracks.some(t => t.slot === 'A' && !t.failure));
      if (!await page.locator('#analysis-panel').isVisible()) await page.locator('#toggle-analysis').click();
      await selectDiagrams(page,'overview');
      await page.locator('[data-seg="full"]').click();
      await page.waitForFunction(() => window.voidPlayer.tools.find(t => t.name === 'get_analysis_capabilities').execute({})[0]?.capability.indexState === 'building');
      assert.equal((await call('get_analysis_capabilities'))[0].capability.indexState, 'building');
      await selectDiagrams(page,'nalu-size');
      // The automatic viewport waits for sealed metadata before choosing local
      // GOPs; the explicit full-film API retains incremental-prefix semantics.
      await page.waitForFunction(() => {
        const state = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({slot:'A'});
        return state.state === 'pending' && state.stream?.window && state.stream.waitingForIndex;
      });
      await requestInspection(page, 'A');
      const before = await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing }));
      await page.waitForFunction(() => {
        const state = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({});
        return state.state === 'pending' && state.stream?.waitingForIndex && state.stream.pictures > 0;
      }, undefined, { timeout: 30000 });
      const partial = await call('get_bitstream_analysis_state');
      assert.ok(gate.heldBatches > 0, 'shared index batch delivery is still gated');
      assert.equal(partial.stream.indexComplete, false);
      assert.ok(partial.stream.pictures > 0 && partial.stream.pictures < 300);
      assert.match(await page.locator('.analysis-track-control[data-slot="A"] .analysis-chip').getAttribute('aria-description'), /等待索引/);
      await page.screenshot({ path: artifact(`index-wait-${cancel ? 'cancel' : 'continue'}.png`) });
      if (!cancel) {
        await call('pause_bitstream_analysis', {slot:'A'});
        const paused = await call('get_bitstream_analysis_state', {slot:'A'});
        assert.equal(paused.state, 'paused'); assert.equal(paused.stream.window, undefined, 'full-film pause keeps full-film scope');
        // The held prefix may cover less than a second (gated frontier is
        // frozen): navigate within the known domain. The gesture must still
        // take effect without restarting paused work.
        const previousSpan = await page.evaluate(() => { const d = document.querySelector('#analysis-shared-axis').dataset; return +d.viewEnd - +d.viewStart; });
        const gatedSpan = Math.min(1_000_000, Math.max(10_000, previousSpan / 2));
        assert.ok(gatedSpan < previousSpan, 'the gated prefix allows a real zoom gesture');
        checkpoint('paused-gated-zoom', { previousSpan, gatedSpan, heldBatches: gate.heldBatches, paused });
        await phase('paused-gated-zoom', () => inspectCurrentWindow(page, gatedSpan));
        assert.equal((await call('get_bitstream_analysis_state', {slot:'A'})).state, 'paused', 'window navigation cannot restart paused work');
        await page.evaluate(() => { void window.voidPlayer.tools.find(t=>t.name==='resume_bitstream_analysis').execute({slot:'A'}).catch(()=>{}); });
        await page.waitForFunction(() => {
          const state = window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot:'A'});
          return state.state==='pending' && !state.stream?.window && state.stream?.waitingForIndex && state.stream.pictures>0;
        });
      }
      if (cancel) {
        await call('cancel_bitstream_analysis',{});
        assert.equal((await call('get_bitstream_analysis_state')).state, 'cancelled');
      }
      gate.release();
      if (!cancel) {
        await page.waitForFunction(() => {
          const state = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({});
          return state.completedStream?.pictures === 300 && state.completedStream.indexComplete;
        }, undefined, { timeout: 30000 });
      }
      await page.waitForFunction(() => window.voidPlayer.tools.find(t => t.name === 'get_analysis_capabilities').execute({})[0]?.capability.indexState === 'complete');
      if (cancel) {
        await inspectCurrentWindow(page);
        await page.waitForFunction(() => {
          const state = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({slot:'A'});
          return state.state === 'ready' && state.stream?.window && state.stream.pictures > 0 && state.stream.pictures < 300 && state.stream.indexComplete && !state.stream.waitingForIndex;
        });
      }
      if (cancel) {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const axis = page.locator('#analysis-shared-axis');
        const expected = await axis.evaluate(c => {
          const r = c.getBoundingClientRect(), left = +c.dataset.plotLeft, width = +c.dataset.plotRight-left;
          const domainStart = +c.dataset.domainStart, span = +c.dataset.domainEnd-domainStart;
          const oldSpan = +c.dataset.viewEnd - +c.dataset.viewStart;
          for (const fraction of [.2,.5,.75]) c.dispatchEvent(new WheelEvent('wheel', {ctrlKey:true,deltaY:280*Math.log(.5),clientX:Math.round(r.left+left+width*fraction),bubbles:true,cancelable:true}));
          const fraction = (Math.round(r.left+left+width*.75)-r.left-left)/width;
          return {time:domainStart+span*fraction,span:oldSpan/8};
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const actual = await axis.evaluate(c => ({start:+c.dataset.viewStart,end:+c.dataset.viewEnd,domainStart:+c.dataset.domainStart,domainEnd:+c.dataset.domainEnd}));
        assert.ok(Math.abs((actual.start+actual.end)/2-expected.time)<5 && Math.abs(actual.end-actual.start-expected.span)<5, JSON.stringify({expected,actual}));
        await page.waitForFunction(() => {
          const c = document.querySelector('#analysis-shared-axis');
          const state = window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot:'A'});
          return state.state==='ready' && state.stream?.window && Math.abs(state.stream.window.startUs-+c.dataset.viewStart)<5 && Math.abs(state.stream.window.endUs-+c.dataset.viewEnd)<5;
        });
      }
      await stable(); // Cancelling inspection leaves metadata indexing running.
      assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), before);
      assert.equal(await page.locator('.analysis-picture-overlay').count(), 0);
      rows.push({ kind: 'incremental-index', cancel, partial, final: await call('get_bitstream_analysis_state') });
    }
}
