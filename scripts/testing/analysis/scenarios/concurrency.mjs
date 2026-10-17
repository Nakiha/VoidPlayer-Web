import assert from "node:assert/strict";
import path from "node:path";
import { selectDiagrams, requestInspection } from '../controls.mjs';


export async function run(context) {
const { page, artifact, limitsDir, requests, call, stable, library, gate } = context;

      const chooseConcurrency = async value => {
        await page.locator('#settings-open').click();
        await page.locator('#settings-tab-performance').click();
        await page.locator('#analysis-concurrency').click();
        await page.locator(`#analysis-concurrency-menu [data-value="${value}"]`).click();
        await page.locator('#settings-close').click();
        await page.locator('#settings').waitFor({state:'hidden'});
      };

      for (const input of ['local-file','library']) {
        if ((await call('get_review_session')).tracks.length) await selectDiagrams(page, 'overview');
        for (const slot of ['A','B','C']) await call('remove_review_track',{slot});
        for (const [slot, name] of [['A','queue-stream.mp4'],['B','queue-incremental.mp4'],['C','queue-stream-2.mp4']]) {
          if (input === 'local-file') await page.locator(`#file-${slot}`).setInputFiles(path.join(limitsDir,name));
          else await call('load_library_item',{slot,id:library.entries.find(e=>e.name===name).id});
          await page.waitForFunction(slot=>{const s=window.voidPlayer.getState();return !s.busy&&s.tracks.some(t=>t.slot===slot&&t.frame&&!t.failure);},slot);
        }
        await stable();
        assert.equal((await call('get_review_session')).tracks.length,3);
        if (!await page.locator('#analysis-panel').isVisible()) await page.locator('#toggle-analysis').click();
        await chooseConcurrency(1);
        let release; const gate = new Promise(resolve=>{release=resolve;});
        const pattern = input === 'local-file' ? '**/vendor/voidplayer-analysis/voidplayer-analysis.wasm*' : '**/api/bitstream-analysis/requests/*';
        await page.route(pattern, async route => { await gate; await route.continue().catch(()=>{}); });
        try {
          await selectDiagrams(page,'nalu-size');
          const states = () => page.evaluate(()=>Object.fromEntries(['A','B','C'].map(slot=>[slot,window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot})])));
          await page.waitForFunction(()=>{
            const tool=window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state');
            return tool.execute({slot:'A'}).state==='pending' && !tool.execute({slot:'A'}).queued && tool.execute({slot:'B'}).queued && tool.execute({slot:'C'}).queued;
          });
          await chooseConcurrency(2);
          await page.waitForFunction(()=>{
            const tool=window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state');
            return tool.execute({slot:'B'}).state==='pending' && !tool.execute({slot:'B'}).queued && tool.execute({slot:'C'}).queued;
          });
          assert.equal((await states()).A.state,'pending','B does not interrupt A');
          await chooseConcurrency(8);
          await page.waitForFunction(()=>{
            const tool=window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state');
            return ['A','B','C'].every(slot=>tool.execute({slot}).state==='pending'&&!tool.execute({slot}).queued);
          });
          await chooseConcurrency(1);
          assert.ok(Object.values(await states()).every(state=>state.state==='pending'&&!state.queued),'lowering concurrency keeps admitted tasks alive');
          assert.equal(await page.locator('.analysis-track-action').count(),0);
          await page.screenshot({path:artifact(`parallel-progress-${input}.png`)});
        } finally { release(); await page.unroute(pattern); }
        await page.waitForFunction(()=>{
          const tool=window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state');
          return ['A','B','C'].every(slot=>tool.execute({slot}).state==='ready');
        },undefined,{timeout:60000});
        const done=await call('get_bitstream_analysis_state',{slot:'A'});
        assert.equal(done.stream.pictures,120);
        const longer = await call('get_bitstream_analysis_state',{slot:'B'});
        assert.equal(longer.stream.pictures,120, 'the longer track only analyzes the shared visible region');
        assert.ok(longer.stream.window.endUs < 10_000_000);
        assert.equal((await call('get_bitstream_analysis_state',{slot:'C'})).stream.pictures,120);
        await page.waitForFunction(()=>[...document.querySelectorAll('.analysis-track-progress')].every(e=>e.getBoundingClientRect().width===0));
        await page.screenshot({path:artifact(`parallel-complete-${input}.png`)});
        await chooseConcurrency(2);
        await selectDiagrams(page,'overview');
        for (const slot of ['B','C']) await call('remove_review_track',{slot});
      }

      // Starting another source retains completed per-track state.
      await requestInspection(page, 'A');

      await page.waitForFunction(() => {
        const s = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({slot:'A'});
        return s.state === 'ready' && s.completedStream?.slot === 'A' && s.completedStream.pictures === 120;
      });

      await call('load_library_item', { slot: 'B', id: library.entries.find(e => e.name === 'incremental.mp4').id });

      await stable();

      await requestInspection(page, 'B');

      await page.waitForFunction(() => {
        const s = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({slot:'B'});
        return s.state === 'ready' && s.completedStream?.slot === 'B' && s.completedStream.pictures === 300;
      }, undefined, { timeout: 60000 });

      await page.waitForFunction(() => ['A','B'].every(slot => window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot}).state==='ready'));

      for (const slot of ['A', 'B']) assert.equal(await page.locator(`.analysis-track-control[data-slot="${slot}"]`).getAttribute('data-state'), 'ready');

      await page.screenshot({ path: artifact('track-inspection-completed.png') });

      await call('remove_review_track', { slot: 'B' });
}
