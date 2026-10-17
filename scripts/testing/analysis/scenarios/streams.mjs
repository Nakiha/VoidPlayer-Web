import assert from "node:assert/strict";
import path from "node:path";
import { selectDiagrams } from '../controls.mjs';


export async function run(context) {
const { page, artifact, limitsDir, requests, rows, call, analyze, stable, library, gate } = context;

    // Choosing a deep diagram starts visible-GOP execution automatically,
    // uses one local worker or one remote task, and never enables an overlay.
    for (const input of ['local-file', 'library']) {
      await call('remove_review_track', { slot: 'A' });
      await call('set_review_color_mode', { mode: 'browser' });
      if (input === 'local-file') await page.locator('#file-A').setInputFiles(path.join(limitsDir, 'stream.mp4'));
      else await call('load_library_item', { slot: 'A', id: library.entries.find(e => e.name === 'stream.mp4').id });
      await stable();
      if (!await page.locator('#analysis-panel').isVisible()) await page.locator('#toggle-analysis').click();
      const start = requests.length;
      await selectDiagrams(page, 'nalu-size');
      assert.equal(await page.locator('[data-seg="follow"]').count(), 0);
      assert.equal(await page.locator('.bitstream-diagram-navigation [data-page]').count(), 0);
      assert.equal(await page.locator('#analysis-inspect-range').count(), 0);
      const playback = await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing }));
      assert.equal(await page.locator('#analysis-stream, #analysis-stream-progress, .analysis-track-action').count(), 0, 'analysis has no persistent start or range controls');
      await page.waitForFunction(() => {
        const s = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({});
        return s.state === 'ready' && s.stream?.pictures === 120;
      }, undefined, { timeout: 30000 });
      const stream = await call('get_bitstream_analysis_state');
      assert.equal(stream.stream.totalPictures, 120); assert.equal(stream.stream.checkedUs, stream.stream.totalUs);
      const completedPill = page.locator('.analysis-track-control[data-slot="A"]');
      assert.match(await completedPill.locator('.analysis-chip').getAttribute('aria-description'), /已完成.*120/);
      await page.waitForFunction(() => document.querySelector('.analysis-track-control[data-slot="A"] .analysis-track-progress').getBoundingClientRect().width === 0);
      const completedWidth=(await completedPill.boundingBox()).width;
      await completedPill.hover(); await page.waitForTimeout(300);
      assert.equal((await completedPill.boundingBox()).width,completedWidth,'hover never expands a completed analysis control');
      assert.equal(await completedPill.locator('button:visible').count(),1,'completed track only shows its visibility button');
      assert.equal(await completedPill.locator('.analysis-retry').isVisible(),false,'completed analysis hides retry');
      await selectDiagrams(page,'references'); await selectDiagrams(page,'nalu-size');
      assert.equal(await completedPill.getAttribute('data-state'),'ready','chart toggles retain completion');
      const configQuery = await call('query_bitstream_chart', { slot: 'A' });
      assert.deepEqual(configQuery.containerHeaders[0].nalus.map(n=>n.type), [7,8]);
      assert.ok(!configQuery.types.includes(7) && !configQuery.types.includes(8), 'out-of-band sets do not enter frame filters');
      const headerCanvas = page.locator('.bitstream-diagrams canvas');
      await page.waitForFunction(() => document.querySelector('.bitstream-diagrams canvas').dataset.containerColumn === '-1');
      assert.equal(await page.locator('.bitstream-container-headers').count(), 0, 'configuration does not add a toolbar row');
      const headerBox = await headerCanvas.boundingBox(), headerX = +await headerCanvas.getAttribute('data-container-x');
      const configGeometry = await headerCanvas.evaluate(c => ({ width:+c.dataset.containerWidth, span:+c.dataset.axisEnd-+c.dataset.axisStart, plot:+c.dataset.plotRight-+c.dataset.plotLeft }));
      assert.ok(Math.abs(configGeometry.width-33_333/configGeometry.span*configGeometry.plot) < .001, 'configuration has an ordinary frame cell width, without a separate pixel minimum');
      await page.mouse.move(headerBox.x + headerX, headerBox.y + headerBox.height / 2);
      const configCard = page.locator('.analysis-container-card:visible');
      await configCard.waitFor({state:'visible'});
      assert.match(await configCard.innerText(), /−1[\s\S]*来自容器头部[\s\S]*avcC[\s\S]*SPS[\s\S]*PPS[\s\S]*不计入逐帧/);
      await headerCanvas.click({position:{x:headerX,y:headerBox.height/2}});
      assert.equal((await call('get_review_session')).positionUs, playback.positionUs, 'configuration cell cannot seek');
      await headerCanvas.focus(); await page.keyboard.press('Home');
      assert.equal(await configCard.isVisible(), true, 'configuration hover is available from the keyboard');
      await page.keyboard.press('Enter');
      assert.equal((await call('get_review_session')).positionUs, playback.positionUs, 'keyboard configuration inspection cannot seek');
      if (input === 'library') await page.screenshot({path:artifact('container-configuration.png')});
      await page.keyboard.press('Escape'); await page.mouse.move(0,0); await headerCanvas.blur();
      const headerLegend = page.locator('.bitstream-diagram-legend');
      assert.equal(await headerLegend.getByRole('button',{name:'SPS',exact:true}).getAttribute('aria-pressed'),'true');
      assert.equal(await headerLegend.getByRole('button',{name:'PPS',exact:true}).getAttribute('aria-pressed'),'true');
      for (const name of ['SPS','PPS']) {
        const entry = headerLegend.getByRole('button',{name,exact:true});
        assert.equal(await entry.getAttribute('data-origin'),'container');
        assert.equal(await entry.locator('.container-nalu-origin').count(),0, 'legend omits appended origin tags');
        assert.match(await entry.getAttribute('aria-description'),/来自容器头部.*avcC/);
        assert.notEqual(await entry.locator('i').evaluate(e=>getComputedStyle(e).backgroundImage),'none','configuration swatches carry the column hatch pattern');
      }
      assert.equal(await headerLegend.getByRole('button',{name:'IDR',exact:true}).getAttribute('data-origin'),null,'frame-only types have no container origin badge');
      await headerLegend.getByRole('button',{name:'SPS',exact:true}).click({button:'right'});
      await page.waitForFunction(() => [...document.querySelectorAll('.bitstream-diagram-legend [data-nalu-type]')].every(e => e.getAttribute('aria-pressed') === (e.dataset.naluType === '7' ? 'true' : 'false')));
      assert.equal(await headerCanvas.getAttribute('data-container-types'), '7', 'right click isolates container NALU types too');
      await headerLegend.getByRole('button',{name:'SPS',exact:true}).click({button:'right'});
      await page.waitForFunction(() => [...document.querySelectorAll('.bitstream-diagram-legend [data-nalu-type]')].every(e => e.getAttribute('aria-pressed') === 'true'));
      assert.equal(await headerCanvas.getAttribute('data-container-types'), '7,8', 'right clicking the solo type again restores all types');
      const pps = headerLegend.getByRole('button',{name:'PPS',exact:true});
      await pps.dispatchEvent('pointerdown', { pointerType:'touch', clientX:20, clientY:20 });
      await page.waitForFunction(() => [...document.querySelectorAll('.bitstream-diagram-legend [data-nalu-type]')].every(e => e.getAttribute('aria-pressed') === (e.dataset.naluType === '8' ? 'true' : 'false')));
      await pps.dispatchEvent('pointerup', { pointerType:'touch', clientX:20, clientY:20 });
      await pps.dispatchEvent('contextmenu');
      await pps.dispatchEvent('click');
      assert.equal(await pps.getAttribute('aria-pressed'), 'true', 'release after a long press does not toggle the isolated type off');
      await pps.dispatchEvent('pointerdown', { pointerType:'touch', clientX:20, clientY:20 });
      await page.waitForFunction(() => [...document.querySelectorAll('.bitstream-diagram-legend [data-nalu-type]')].every(e => e.getAttribute('aria-pressed') === 'true'));
      await pps.dispatchEvent('pointerup', { pointerType:'touch', clientX:20, clientY:20 });
      await pps.dispatchEvent('contextmenu');
      await pps.dispatchEvent('click');
      assert.equal(await pps.getAttribute('aria-pressed'), 'true', 'repeating a long press restores all types and suppresses the release click');
      await page.waitForFunction(() => [...document.querySelectorAll('.bitstream-diagram-legend [data-nalu-type]')].every(e => e.getAttribute('aria-pressed') === 'true') && +document.querySelector('.bitstream-diagrams canvas').dataset.renderedBytes > 0);
      const frameBytesBefore = await headerCanvas.getAttribute('data-rendered-bytes');
      await headerLegend.getByRole('button',{name:'SPS',exact:true}).click();
      await page.waitForFunction(() => document.querySelector('.bitstream-diagrams canvas').dataset.containerTypes === '8');
      assert.equal(await headerCanvas.getAttribute('data-rendered-bytes'),frameBytesBefore,'container filtering does not change frame totals');
      await page.mouse.move(headerBox.x+headerX,headerBox.y+headerBox.height/2);
      await configCard.waitFor({state:'visible'});
      assert.match(await configCard.innerText(),/来自容器头部[\s\S]*PPS/);
      assert.doesNotMatch(await configCard.innerText(),/SPS/,'hidden container types leave the hover content');
      await headerLegend.getByRole('button',{name:'PPS',exact:true}).click();
      await page.waitForFunction(() => document.querySelector('.bitstream-diagrams canvas').dataset.containerColumn === '');
      assert.equal(await page.locator('.analysis-container-card:visible').count(),0,'hiding every container type removes its hover target');
      assert.equal(await headerCanvas.getAttribute('data-rendered-bytes'),frameBytesBefore);
      await headerLegend.locator('[data-filter="all"]').click();
      await page.waitForFunction(() => document.querySelector('.bitstream-diagrams canvas').dataset.containerTypes === '7,8');
      await page.mouse.move(0,0);
      assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), playback);
      assert.equal(await page.locator('.analysis-picture-overlay').count(), 0);
      if (input === 'local-file') assert.equal(requests.slice(start).filter(r => /assets\/local-worker-.*\.js/.test(r.url)).length, 1);
      else {
        assert.equal(requests.slice(start).filter(r => r.method === 'POST' && /bitstream-analysis\/requests/.test(r.url)).length, 1);
        assert.ok(!requests.slice(start).some(r => /voidplayer-analysis\.(js|wasm)|local-worker/.test(r.url)));
      }
      const diagrams = await call('query_bitstream_diagrams', { slot: 'A', startAu: 0, limit: 128 });
      assert.equal(diagrams.count, 120); assert.equal(diagrams.pictures.length, 120);
      assert.ok(diagrams.pictures.every(p => p.nalus.length > 0));
      assert.ok(diagrams.pictures.some(p => p.references?.edges.length > 0));
      for (const diagram of ['nalu-size', 'nalu-types', 'references']) {
        await selectDiagrams(page, diagram);
        await page.waitForFunction(mode => { const c = document.querySelector('.bitstream-diagrams canvas'); return c.dataset.diagram === mode && +c.dataset.pictures > 0; }, diagram);
        if (diagram === 'references') assert.ok(+await page.locator('.bitstream-diagrams canvas').getAttribute('data-references') > 0);
        // Both browser pinch representations zoom the actual canvas around
        // the pointer, without changing playback or launching another analysis.
        const chart = page.locator('.bitstream-diagrams canvas');
        assert.equal(await chart.getAttribute('data-time-axis'), 'false', 'single diagram leaves time labels to the fixed panel axis');
        assert.equal(await page.locator('#analysis-shared-axis').isVisible(), true);
        const view = () => chart.evaluate(c => ({ start: +c.dataset.viewStart, end: +c.dataset.viewEnd }));
        await chart.dispatchEvent('dblclick');
        await page.waitForFunction(() => { const c=document.querySelector('.bitstream-diagrams canvas'); return +c.dataset.viewStart===0 && +c.dataset.viewEnd===1; });
        const initialRadius = diagram === 'references' ? +await chart.getAttribute('data-node-radius') : null;
        const wheel = async (deltaY, ctrlKey = true, deltaMode = 0) => {
          const prevented = await chart.evaluate((c, args) => {
            const rect = c.getBoundingClientRect();
            const event = new WheelEvent('wheel', { ...args, clientX: rect.left + 46 + (rect.width - 46 - 16) * .3,
              clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true });
            c.dispatchEvent(event); return event.defaultPrevented;
          }, { deltaY, ctrlKey, deltaMode });
          assert.equal(prevented, true, 'chart owns the gesture instead of browser page zoom');
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
        };
        const gesture = async (type, scale) => {
          const prevented = await chart.evaluate((c, args) => {
            const rect = c.getBoundingClientRect(), event = new Event(args.type, { bubbles: true, cancelable: true });
            Object.assign(event, { scale: args.scale, clientX: rect.left + 46 + (rect.width - 46 - 16) * .3 });
            c.dispatchEvent(event); return event.defaultPrevented;
          }, { type, scale });
          assert.equal(prevented, true);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
        };
        await wheel(-280 * Math.log(2));
        const zoomed = await view();
        assert.ok(Math.abs(zoomed.end - zoomed.start - .5) < .001, JSON.stringify({ diagram, input, zoomed }));
        assert.ok(Math.abs(zoomed.start + .3 * (zoomed.end - zoomed.start) - .3) < .001, 'wheel anchor stays under pointer');
        await gesture('gesturestart', 1);
        await wheel(-100); // Duplicate wheel during native pinch is ignored.
        assert.deepEqual(await view(), zoomed);
        await gesture('gesturechange', 2);
        const pinched = await view();
        if (diagram === 'references') {
          const enlarged = +await chart.getAttribute('data-node-radius');
          assert.ok(enlarged > initialRadius && enlarged <= 12, 'reference circles grow with zoom and stay bounded');
        }
        assert.ok(Math.abs(pinched.end - pinched.start - .25) < .001, 'native WebKit pinch also zooms');
        assert.ok(Math.abs(pinched.start + .3 * (pinched.end - pinched.start) - .3) < .001, 'native pinch preserves anchor');
        await gesture('gestureend', 2);
        await wheel(2, false, 1);
        const panned = await view();
        assert.ok(panned.start > pinched.start && Math.abs(panned.end - panned.start - .25) < .001, 'plain wheel pans the zoomed axis');
        if (diagram !== 'references') {
          // Hit testing must use the transformed AU coordinates, not the old
          // unzoomed group. Hover a bar and inspect its real AU label.
          const targetAu = await chart.evaluate(c => {
            const startUs = +c.dataset.axisStart, endUs = +c.dataset.axisEnd;
            const data = window.voidPlayer.tools.find(t => t.name === 'query_bitstream_chart').execute({ slot: 'A', startUs, endUs });
            const target = startUs + (endUs - startUs) / 2 + data.firstPtsUs - data.offsetUs;
            return data.pictures.reduce((best, p) => !best || Math.abs(p.sourcePtsUs - target) < Math.abs(best.sourcePtsUs - target) ? p : best, null).picture.au;
          });
          const rect = await chart.boundingBox();
          await page.mouse.move(rect.x + 46 + (rect.width - 46 - 16) * .5, rect.y + rect.height / 2);
          await page.waitForFunction(au => document.querySelector('.bitstream-diagram-detail').textContent.startsWith(`AU ${au} ·`), targetAu);
        }
        if (diagram === 'references' && input === 'library') await page.screenshot({ path: artifact('diagram-references-zoomed.png') });
        await wheel(10000); // Zoom-out clamps to the group, never beyond it.
        assert.deepEqual(await view(), { start: 0, end: 1 });
        await wheel(-10000);
        const bounded = await view();
        assert.ok(bounded.end > bounded.start && bounded.start >= 0 && bounded.end <= 1);
        await chart.dispatchEvent('dblclick');
        await page.waitForFunction(() => { const c = document.querySelector('.bitstream-diagrams canvas'); return +c.dataset.viewStart === 0 && +c.dataset.viewEnd === 1; });
        const rangeLabel = page.locator('.bitstream-diagram-navigation output');
        assert.match(await rangeLabel.innerText(), /A · \d{2}:\d{2}\.\d{3}–\d{2}:\d{2}\.\d{3}/, 'navigation shows session times, not internal AU identifiers');
        if (diagram !== 'references') {
          const types = [...new Set([...diagrams.pictures.flatMap(p => p.nalus.map(n => n.type)), ...configQuery.containerHeaders.flatMap(h=>h.nalus.map(n=>n.type))])];
          const legend = page.locator('.bitstream-diagram-legend');
          const total = diagrams.pictures.flatMap(p => p.nalus).reduce((sum, n) => sum + n.size, 0);
          assert.equal(+await chart.getAttribute('data-rendered-bytes'), total, 'new sources default to all types');
          const labelBefore = await rangeLabel.innerText(), zoomBefore = await view();
          const pixelsBefore = await chart.evaluate(c => c.toDataURL());
          await legend.locator('[data-nalu-type="1"]').click();
          await page.waitForFunction(() => document.querySelector('.bitstream-diagram-legend [data-nalu-type="1"]').getAttribute('aria-pressed') === 'false');
          const remaining = diagrams.pictures.flatMap(p => p.nalus).filter(n => n.type !== 1);
          assert.equal(+await chart.getAttribute('data-rendered-bytes'), remaining.reduce((sum, n) => sum + n.size, 0));
          assert.notEqual(await chart.evaluate(c => c.toDataURL()), pixelsBefore, 'filter updates the rendered chart');
          assert.equal(await rangeLabel.innerText(), labelBefore, 'filtering does not change the window');
          assert.deepEqual(await view(), zoomBefore, 'filtering keeps zoom');
          if (diagram === 'nalu-size') {
            await selectDiagrams(page, 'nalu-types');
            await page.waitForFunction(() => document.querySelector('.bitstream-diagrams canvas').dataset.diagram === 'nalu-types');
            assert.equal(await legend.locator('[data-nalu-type="1"]').getAttribute('aria-pressed'), 'false', 'filter is shared by both NALU diagrams');
            await selectDiagrams(page, 'nalu-size');
            await page.waitForFunction(() => document.querySelector('.bitstream-diagrams canvas').dataset.diagram === 'nalu-size');
          }
          if (input === 'library') await page.screenshot({ path: artifact(`diagram-${diagram}-filtered.png`) });
          for (const type of types.filter(t => t !== 1)) {
            // Native buttons also work from the keyboard and retain focus.
            await legend.locator(`[data-nalu-type="${type}"]`).press('Enter');
            await page.waitForFunction(type => document.querySelector(`.bitstream-diagram-legend [data-nalu-type="${type}"]`).getAttribute('aria-pressed') === 'false', type);
          }
          assert.equal(+await chart.getAttribute('data-rendered-nalus'), 0);
          assert.match(await page.locator('.bitstream-diagram-empty').innerText(), /没有选中 NALU 类型/);
          await chart.focus(); await page.keyboard.press('Enter');
          assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), playback, 'empty filtered chart cannot seek an invisible frame');
          await legend.locator('[data-filter="all"]').click();
          await page.waitForFunction(total => +document.querySelector('.bitstream-diagrams canvas').dataset.renderedBytes === total, total);
          assert.equal(await page.locator('.bitstream-diagram-empty').isVisible(), false);
        }
        await page.screenshot({ path: artifact(`diagram-${diagram}-${input}.png`) });
        assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), playback, 'view switching does not seek or analyze');
      }
      await page.locator('.bitstream-diagrams canvas').focus();
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => { const s = window.voidPlayer.getState(); return !s.busy && s.positionUs > 0 && s.tracks[0].frame?.ptsUs > 0; });
      await call('seek_review', { ptsUs: playback.positionUs });
      await page.screenshot({ path: artifact(`whole-stream-${input}.png`) });
      const cached = await call('request_bitstream_analysis', { slot: 'A' });
      assert.ok(cached.blocks.length > 0);
      assert.equal((await call('get_bitstream_analysis_state')).cacheHit, false, 'summary-only charts do not claim exact blocks are cached');
      await call('request_bitstream_analysis', { slot: 'A' });
      assert.equal((await call('get_bitstream_analysis_state')).cacheHit, true, 'a second exact request reuses the independent block product');
      const cacheStart = requests.length;
      await call('request_bitstream_stream', { slot: 'A', product:'summary' });
      const restored = await call('get_bitstream_analysis_state', { slot: 'A' });
      assert.equal(restored.state, 'ready'); assert.equal(restored.stream.pictures, 120);
      const { revision: beforeRevision, ...beforeChart } = configQuery;
      const { revision: afterRevision, ...afterChart } = await call('query_bitstream_chart', { slot: 'A' });
      assert.ok(afterRevision >= beforeRevision);
      assert.deepEqual(afterChart, beforeChart,
        'cached stream preserves picture, NALU and reference records');
      assert.equal(requests.slice(cacheStart).filter(r => new URL(r.url).pathname.endsWith('/voidplayer-analysis.wasm')).length, 0,
        'complete cached stream never initializes the local analysis WASM');
      let release;
      const gate = new Promise(r => { release = r; });
      // Cached local streams still read the manifest to verify build identity.
      const pattern = input === 'local-file' ? '**/vendor/voidplayer-analysis/manifest.json*' : '**/bitstream-analysis/capabilities*';
      await page.route(pattern, async route => { await gate; await route.continue().catch(() => {}); });
      const requested = page.waitForRequest(pattern, { timeout: 30000 });
      try {
        await page.evaluate(() => { void window.voidPlayer.tools.find(t=>t.name==='request_bitstream_stream').execute({slot:'A',product:'summary'}).catch(()=>{}); });
        await requested;
        assert.equal(await page.locator('.analysis-track-control[data-slot="A"]').getAttribute('data-state'), 'pending');
        assert.equal(await page.locator('.analysis-track-control[data-slot="A"] .analysis-progress-ring').count(), 1, 'active inspection uses a circular progress indicator');
        await call('cancel_bitstream_analysis',{});
        await page.waitForFunction(() => window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({}).state === 'cancelled');
        assert.match(await page.locator('.analysis-track-control[data-slot="A"] .analysis-chip').getAttribute('aria-description'), /已取消/);
        assert.equal(await page.locator('.analysis-picture-overlay').count(), 0);
        assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), playback);
      } finally { release(); await page.unroute(pattern); }
      rows.push({ kind: 'whole-stream', input, stream });
      await selectDiagrams(page, 'overview');
    }
}
