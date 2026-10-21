import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from 'node:fs/promises';
import { selectDiagrams, openRangeEditor, inspectCurrentWindow } from '../controls.mjs';
import { recordStatusEvidence } from '../status-evidence.mjs';
import { recordBrowserEvidence, saveBrowserFailure } from '../../../browser-failure-evidence.mjs';


export async function run(context) {
const { page, artifact, phase, checkpoint, limitsDir, requests, rows, call, stable, library, gate } = context;
 for (const input of ['local-file', 'library']) {
      await call('remove_review_track', { slot: 'A' });
      if (input === 'local-file') await page.locator('#file-A').setInputFiles(path.join(limitsDir, 'incremental.mp4'));
      else await call('load_library_item', { slot: 'A', id: library.entries.find(e => e.name === 'incremental.mp4').id });
      await stable(); await call('seek_review', { ptsUs: 5_000_000 });
      if (!await page.locator('#analysis-panel').isVisible()) await page.locator('#toggle-analysis').click();
      await selectDiagrams(page, 'nalu-size');
      // Streams have a no-progress budget, not a 30 s total lifetime. CI may
      // continuously consume all 300 HTTP chunks beyond that old total limit.
      // Keep the same terminal/coverage gate and the existing 60 s stream wait.
      await page.waitForFunction(() => { const s = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({slot:'A'}); return s.state === 'ready' && s.stream?.pictures === 300 && !s.completedStream; }, undefined, { timeout: 60000 });
      for (const close of await page.locator('.toast-close').all()) await close.click();
      await page.locator('.toast-stack .toast').waitFor({ state: 'hidden' });
      const playback = await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing }));
      const requestsBefore = requests.length;
      const warmWorkers = [];
      const recordWorker = worker => { if (/local-worker/.test(worker.url())) warmWorkers.push(worker.url()); };
      page.on('worker', recordWorker);
      await page.evaluate(() => {
        window.__warmAnalysisStates = [];
        window.__stopWarmAnalysisStates = window.voidPlayer.subscribeState(() => {
          const state = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({ slot: 'A' });
          window.__warmAnalysisStates.push({ state: state.state, queued: !!state.queued });
        });
      });
      const settledCachedWindow = () => page.waitForFunction(() => {
        const state = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({ slot: 'A' });
        const chart = document.querySelector('.bitstream-diagrams canvas'), track = window.voidPlayer.getState().tracks.find(t => t.slot === 'A');
        return state.state === 'ready' && state.cacheHit && state.stream?.window?.startUs === Math.max(0, Math.floor(+chart.dataset.axisStart - track.offsetUs)) &&
          state.stream.window.endUs === Math.min(Math.ceil(track.durationUs), Math.ceil(+chart.dataset.axisEnd - track.offsetUs));
      });
      const whole = await call('query_bitstream_chart', { slot: 'A' });
      assert.equal(whole.count, 300); assert.equal(whole.aggregated, true); assert.equal(whole.pictures.length, 0);
      assert.ok(whole.buckets.length <= 258); assert.equal(whole.buckets.reduce((sum, b) => sum + b.pictures, 0), 300);
      for (const diagram of ['nalu-size', 'nalu-types', 'references']) {
        await selectDiagrams(page, diagram);
        const chart = page.locator('.bitstream-diagrams canvas');
        await page.waitForFunction(mode => { const c = document.querySelector('.bitstream-diagrams canvas'); return c.dataset.diagram === mode && +c.dataset.totalPictures === 300 && c.dataset.aggregated === 'true'; }, diagram);
        assert.ok(+await chart.getAttribute('data-axis-start') < 0, 'full range leaves space before the first frame'); assert.equal(+await chart.getAttribute('data-axis-end'), 10_000_000);
        assert.equal(await page.locator('.bitstream-diagram-navigation [data-page]').count(), 0);
        await chart.evaluate(c => { const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -280 * Math.log(4), clientX: r.left + 46 + (r.width - 46 - 16) / 2, bubbles: true, cancelable: true })); });
        await page.waitForFunction(() => { const c = document.querySelector('.bitstream-diagrams canvas'); return c.dataset.aggregated === 'false' && +c.dataset.pictures > 60 && +c.dataset.pictures <= 80; });
        await settledCachedWindow();
        const local = await chart.evaluate(c => window.voidPlayer.tools.find(t => t.name === 'query_bitstream_chart').execute({ slot: 'A', startUs: +c.dataset.axisStart, endUs: +c.dataset.axisEnd }));
        assert.ok(local.pictures.every(p => p.sourcePtsUs >= local.startUs && p.sourcePtsUs < local.endUs));
        if (input === 'library') await page.screenshot({ path: artifact(`whole-chart-${diagram}-zoomed.png`) });
        await page.locator('[data-seg="full"]').click();
        await page.waitForFunction(() => document.querySelector('.bitstream-diagrams canvas').dataset.aggregated === 'true');
        await settledCachedWindow();
        if (input === 'library') await page.screenshot({ path: artifact(`whole-chart-${diagram}.png`) });
        assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), playback, 'whole-film overview and detail zoom never seek');
      }
      const warmStates = await page.evaluate(() => { window.__stopWarmAnalysisStates(); return window.__warmAnalysisStates; });
      page.off('worker', recordWorker);
      assert.ok(warmStates.length > 0 && warmStates.every(state => state.state !== 'pending' && !state.queued), 'covered navigation never publishes transient analysis work');
      assert.equal(warmWorkers.length, 0, 'covered navigation starts no local analysis worker');
      assert.equal(requests.slice(requestsBefore).filter(r => r.method === 'POST' && /bitstream-analysis\/requests/.test(r.url)).length, 0, 'covered navigation starts no remote analysis task');
      if (input === 'library') {
        const workspace = await call('export_workspace');
        const freshContext = await context.browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
        let fresh, statuses, freshEvidence;
        try {
          fresh = await freshContext.newPage();
          freshEvidence = recordBrowserEvidence(fresh);
          const downloads = [];
          statuses = recordStatusEvidence(fresh, request => request.method() === 'GET' && /bitstream-analysis\/requests\/.*pack=gop/.test(request.url()));
          fresh.on('request', request => { if (/bitstream-analysis\/chunks\//.test(request.url())) downloads.push(request.url()); });
          await fresh.addInitScript(() => { window.__vpAnalysisQA = true; });
          await fresh.goto(context.url);
          await fresh.waitForFunction(() => !!window.voidPlayer?.tools);
          if (await fresh.locator('#identity-welcome').isVisible()) await fresh.locator('#identity-welcome button[type=submit]').click();
          await fresh.evaluate(document => window.voidPlayer.importWorkspace(document), workspace);
          await fresh.waitForFunction(() => {
            const state = window.voidPlayer.tools.find(tool => tool.name === 'get_bitstream_analysis_state').execute({ slot: 'A' });
            return state.state === 'ready' && state.stream?.pictures === 300;
          }).catch(async error => {
            console.error('fresh-browser-cache-restore', await fresh.evaluate(() => ({
              analysis: window.voidPlayer.tools.find(tool => tool.name === 'get_bitstream_analysis_state').execute({ slot: 'A' }),
              workspace: window.voidPlayer.exportWorkspace(),
            })), 'statuses', await statuses.snapshot());
            await fresh.screenshot({ path: artifact('fresh-browser-cache-failure.png') }); throw error;
          });
          const state = await fresh.evaluate(() => window.voidPlayer.tools.find(tool => tool.name === 'get_bitstream_analysis_state').execute({ slot: 'A' }));
          assert.equal(state.counters.decodedAU, 0, 'a different browser reuses the server cache without decoding');
          assert.equal(downloads.length, 0, 'a different browser gets cached GOP packets rather than 300 picture downloads');
          const captured = await statuses.snapshot();
          await writeFile(artifact('fresh-browser-status-evidence.json'), JSON.stringify(captured, null, 2));
          for (const status of captured) {
            assert.notEqual(status.state, 'pending', `status request must settle: ${status.url}`);
            if (status.state === 'failed') {
              assert.ok(['net::ERR_ABORTED', 'cancelled', 'Load request cancelled'].includes(status.failure), `unexpected status transport failure: ${JSON.stringify(status)}`);
            } else {
              assert.equal(status.status, 200, `cached status HTTP error: ${status.url}`);
              assert.equal(status.bodyError, undefined, `could not read completed status body: ${JSON.stringify(status)}`);
            }
          }
          // Superseded viewport polls may be cancelled after headers. They
          // deliver no packet; all 300 pictures must still arrive via successful
          // responses, without decode or individual picture downloads.
          const packets = captured.filter(status => status.state === 'finished').flatMap(status => status.body.chunks).filter(chunk => chunk.cachedGop);
          assert.equal(packets.reduce((sum, chunk) => sum + chunk.cachedGop.length, 0), 300);
          assert.ok(packets.length < 300 && packets.every(packet => packet.cachedGop.length > 1));
          await fresh.screenshot({ path: artifact('fresh-browser-cached-gops.png') });
        } catch (error) {
          try {
            await saveBrowserFailure({ page: fresh, directory: path.dirname(artifact('fresh-browser-cache')), name: 'fresh-browser-cache',
              context: { engine: context.engine, caseName: 'fresh-browser-cache', phase: 'restore-cached-gops' }, error,
              evidence: freshEvidence, extra: { statuses: await statuses?.snapshot() } });
          } catch (cause) { console.error('fresh-browser-cache: could not save failure scene', cause); }
          throw error;
        } finally { statuses?.dispose(); await freshContext.close(); }
      }
      assert.ok(requests.slice(requestsBefore).filter(r => r.method === 'POST' && /bitstream-analysis\/requests/.test(r.url)).every(r => r.target?.mode==='stream' && r.target.window), 'viewport navigation only requests visible GOPs');
      await inspectCurrentWindow(page);
      await page.waitForFunction(() => { const c = document.querySelector('.bitstream-diagrams canvas'); return c.dataset.aggregated === 'false' && Math.abs(+c.dataset.axisEnd - +c.dataset.axisStart - 1_000_000) <= 2; });
      assert.equal(await page.evaluate(() => window.voidPlayer.getState().positionUs), playback.positionUs);
      const chart = page.locator('.bitstream-diagrams canvas');
      const viewport = () => chart.evaluate(c => ({ start: +c.dataset.viewStart, end: +c.dataset.viewEnd, axisStart: +c.dataset.axisStart, axisEnd: +c.dataset.axisEnd }));
      const centered = await viewport();
      await chart.evaluate(c => { const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { deltaX: 150, clientX: r.left + r.width / 2, bubbles: true, cancelable: true })); });
      await page.waitForFunction(start => +document.querySelector('.bitstream-diagrams canvas').dataset.viewStart > start, centered.start);
      const shared = await viewport();
      const rangeLabel = await page.locator('.bitstream-diagram-navigation output').innerText();
      const referenceRecords = await call('query_bitstream_chart', { slot: 'A', startUs: shared.axisStart, endUs: shared.axisEnd });
      assert.ok(referenceRecords.pictures.some(p => p.references?.frameType === 'B'));
      for (const p of referenceRecords.pictures) if (p.references?.state === 'ready') {
        assert.equal(p.referenceLayer.source, 'inferred', 'ordinary AVC must explicitly distinguish inferred layout from signaled temporal IDs');
        assert.ok(p.referenceLayer.level <= 2, 'two-B-frame fixture stays within its local hierarchy instead of climbing across intervals');
      }
      for (const diagram of ['nalu-size', 'nalu-types', 'references', 'nalu-size']) {
        await selectDiagrams(page, diagram);
        await page.waitForFunction(mode => document.querySelector('.bitstream-diagrams canvas').dataset.diagram === mode, diagram);
        assert.deepEqual(await viewport(), shared, 'NALU size, types and references share the zoomed and panned viewport');
        assert.equal(await page.locator('.bitstream-diagram-navigation output').innerText(), rangeLabel);
        assert.equal(await chart.getAttribute('data-aggregated'), 'false');
        if (diagram === 'references') {
          assert.equal(await page.locator('.bitstream-layer-badge:visible').innerText(), '推断层级');
          assert.equal(await chart.getAttribute('data-layer-source'), 'inferred');
          assert.ok(+await chart.getAttribute('data-max-layer') <= 2);
        }
        if (input === 'library') await page.screenshot({ path: artifact(`shared-range-${diagram}.png`) });
      }
      assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), playback, 'diagram comparison keeps playback paused at the same frame');
      assert.ok(requests.slice(requestsBefore).filter(r => r.method === 'POST' && /bitstream-analysis\/requests/.test(r.url)).every(r => r.target?.mode==='stream' && r.target.window), 'diagram comparison only requests visible GOPs');
      const choose = async mode => {
        await selectDiagrams(page, mode);
        const target = page.locator(mode === 'overview' ? '#analysis-canvas' : '.bitstream-diagrams canvas');
        await target.waitFor({ state: 'visible' });
        if (mode !== 'overview') await page.waitForFunction(mode => document.querySelector('.bitstream-diagrams canvas').dataset.diagram === mode, mode);
        return target;
      };
      const axis = target => target.evaluate(c => ({ start: +c.dataset.axisStart, end: +c.dataset.axisEnd }));
      const overview = await choose('overview');
      await page.waitForFunction(range => { const c = document.querySelector('#analysis-canvas'); return +c.dataset.axisStart === range.axisStart && +c.dataset.axisEnd === range.axisEnd; }, shared);
      await overview.evaluate(c => { const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -280 * Math.log(2), clientX: r.left + r.width / 2, bubbles: true, cancelable: true })); });
      await page.waitForFunction(span => { const c = document.querySelector('#analysis-canvas'); return +c.dataset.axisEnd - +c.dataset.axisStart < span; }, shared.axisEnd - shared.axisStart);
      const overviewZoom = await axis(overview);
      assert.ok(Math.abs(overviewZoom.end - overviewZoom.start - 500_000) <= 2);
      await overview.evaluate(c => { const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { deltaX: 150, clientX: r.left + r.width / 2, bubbles: true, cancelable: true })); });
      await page.waitForFunction(start => +document.querySelector('#analysis-canvas').dataset.axisStart > start, overviewZoom.start);
      const compared = await axis(overview);
      for (const mode of ['nalu-size', 'nalu-types', 'references', 'overview']) {
        const target = await choose(mode);
        await page.waitForFunction(({ selector, range }) => { const c = document.querySelector(selector); return +c.dataset.axisStart === range.start && +c.dataset.axisEnd === range.end; }, { selector: mode === 'overview' ? '#analysis-canvas' : '.bitstream-diagrams canvas', range: compared });
        assert.deepEqual(await axis(target), compared, 'all diagrams use exactly the same session-time viewport in both directions');
        if (input === 'library') await page.screenshot({ path: artifact(`overview-shared-${mode}.png`) });
      }
      const saved = await call('export_workspace');
      assert.deepEqual(saved.layout.analysisView.view, compared, 'shared viewport is saved with the workspace');
      await page.locator('[data-seg="full"]').click();
      await page.waitForFunction(() => { const c = document.querySelector('#analysis-canvas'); return +c.dataset.axisStart < 0 && +c.dataset.axisEnd === 10_000_000; });
      await choose('references');
      assert.ok(+await chart.getAttribute('data-axis-start') < 0, 'full range leaves space before the first frame'); assert.equal(+await chart.getAttribute('data-axis-end'), 10_000_000);
      await inspectCurrentWindow(page);
      await page.waitForFunction(() => Math.abs(+document.querySelector('.bitstream-diagrams canvas').dataset.axisEnd - +document.querySelector('.bitstream-diagrams canvas').dataset.axisStart - 1_000_000) <= 2);
      const currentRange = await axis(chart);
      await call('set_review_track_offset', { slot: 'A', offsetUs: 2_000_000 });
      await choose('overview');
      assert.deepEqual(await axis(overview), currentRange, 'track alignment keeps the shared absolute time range');
      await choose('nalu-size');
      assert.deepEqual(await axis(chart), currentRange);
      const shifted = await call('query_bitstream_chart', { slot: 'A', startUs: currentRange.start, endUs: currentRange.end });
      assert.ok(shifted.pictures.length > 0 && shifted.pictures.every(p => p.sourcePtsUs >= currentRange.start - 2_000_000 && p.sourcePtsUs < currentRange.end - 2_000_000));
      await page.locator('[data-seg="full"]').click();
      await page.waitForFunction(() => +document.querySelector('.bitstream-diagrams canvas').dataset.axisEnd === 12_000_000);
      assert.ok(+await chart.getAttribute('data-axis-start') < 0, 'deep charts retain the padded session domain before a delayed source starts');
      const delayedRange = await axis(chart);
      await choose('overview');
      assert.deepEqual(await axis(overview), delayedRange, 'full range padding stays aligned between overview and deep charts');
      await call('set_review_track_offset', { slot: 'A', offsetUs: 0 });
      assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), playback);
      assert.ok(requests.slice(requestsBefore).filter(r => r.method === 'POST' && /bitstream-analysis\/requests/.test(r.url)).every(r => r.target?.mode==='stream' && r.target.window), 'overview comparison and alignment do not launch whole-source analysis');
      // Several checkbox choices stay mounted and compare the same range simultaneously.
      const choices = ['bitrate', 'size', 'nalu-size', 'nalu-types', 'references'];
      await selectDiagrams(page, choices);
      assert.equal(await page.locator('#analysis-diagrams [aria-pressed="true"]').count(), 5);
      assert.equal(await page.locator('#analysis-diagrams button').count(), 5);
      assert.equal(await page.locator('#analysis-diagram-menu').count(), 0, 'view toggles no longer open a dropdown');
      assert.equal(await page.locator('[data-seg="bitrate"], [data-seg="size"]').count(), 0);
      assert.equal(await page.locator('.bitstream-diagrams canvas').count(), 3);
      assert.equal(await page.locator('.bitstream-nalu-group:visible').count(), 1);
      assert.equal(await page.locator('.bitstream-nalu-group > .bitstream-diagrams').count(), 2, 'NALU views share one vertical chart group');
      assert.equal(await page.locator('.bitstream-nalu-group .bitstream-diagram-head:visible').count(), 1, 'NALU group has one shared header and filter');
      const groupedSize = page.locator('.bitstream-nalu-group > .bitstream-diagrams[data-diagram="nalu-size"]');
      const groupedTypes = page.locator('.bitstream-nalu-group > .bitstream-diagrams[data-diagram="nalu-types"]');
      const sizeBox = await groupedSize.boundingBox(), typeBox = await groupedTypes.boundingBox();
      assert.ok(Math.abs(sizeBox.y + sizeBox.height - typeBox.y) <= 1, 'NALU size and types are adjoining rows');
      await page.waitForFunction(() => document.getElementById('bitstream-diagram-nalu-size').dataset.containerColumn === '-1');
      const configurationX = +await page.locator('#bitstream-diagram-nalu-size').getAttribute('data-container-x');
      assert.equal(+await page.locator('#bitstream-diagram-nalu-types').getAttribute('data-container-x'), configurationX, 'configuration cells align across NALU rows');
      for (const id of ['analysis-canvas', 'bitstream-diagram-references']) {
        const blankChart = page.locator(`#${id}`), box = await blankChart.boundingBox();
        await page.mouse.move(box.x + configurationX, box.y + box.height / 2);
        await page.waitForFunction(() => [...document.querySelectorAll('.analysis-view-card')].every(card => card.hidden), undefined);
        assert.equal(await blankChart.getAttribute('data-hover-time'), '', 'non-NALU charts keep configuration space empty');
      }
      const filter = groupedSize.locator('[data-nalu-type]').first();
      const filterType = await filter.getAttribute('data-nalu-type');
      await filter.click();
      await page.waitForFunction(type => [...document.querySelectorAll('.bitstream-nalu-group [data-nalu-type]')].filter(button => button.dataset.naluType === type).every(button => button.getAttribute('aria-pressed') === 'false'), filterType);
      await groupedSize.locator('[data-filter="all"]').click();

      // The visible left half of frame zero is interactive, even though its
      // pointer time is negative. Container metadata remains a separate target.
      await page.getByRole('separator', {name:'调整码流分析高度',exact:true}).press('End');
      const zeroChart = page.locator('#bitstream-diagram-nalu-size');
      await zeroChart.evaluate(c => { const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { ctrlKey:true, deltaY:-280*Math.log(20), clientX:r.left+46, bubbles:true, cancelable:true })); });
      await page.waitForFunction(() => +document.getElementById('bitstream-diagram-nalu-size').dataset.axisEnd < 600000);
      for (const id of ['analysis-canvas', 'bitstream-diagram-nalu-size', 'bitstream-diagram-nalu-types', 'bitstream-diagram-references']) {
        await page.mouse.move(0, 0);
        const target = page.locator(`#${id}`); await target.scrollIntoViewIfNeeded();
        const rect = await target.boundingBox();
        const geometry = await target.evaluate(c => {
          const d = c.dataset, span = +d.axisEnd-+d.axisStart, plot = c.clientWidth-46 - 16;
          return { zero:46-+d.axisStart/span*plot, cell:33333/span*plot, radius:+d.nodeRadius||0 };
        });
        const y = id === 'bitstream-diagram-references' ? rect.y+rect.height-geometry.radius-6 : rect.y+rect.height*.7;
        const positions = [];
        for (const fraction of [-.25, -.15]) {
          await page.mouse.move(rect.x+geometry.zero+geometry.cell*fraction, y, {steps:8});
          await page.waitForFunction(id => {
            const c = document.getElementById(id);
            return +c.dataset.hoverCursorTime < 0 && (id === 'analysis-canvas' ? window.__vpAnalysis.inspection?.t === 0 : c.dataset.hoverAu === '0');
          }, id);
          const cursors = await page.locator('#analysis-canvas, .bitstream-diagrams canvas').evaluateAll(cs=>cs.map(c=>+c.dataset.hoverCursorTime));
          assert.ok(cursors.every(t=>t<0 && Math.abs(t-cursors[0])<2),'all linked cursors follow the pointer left of frame zero');
          positions.push(cursors[0]);
          assert.ok(await page.locator('.analysis-view-card:visible, .analysis-linked-card:visible').count() > 0, 'frame-zero hover shows details in either appearance');
          assert.equal(await page.locator('.analysis-container-card:visible').count(), 0, 'frame-zero left half does not show container metadata');
        }
        assert.ok(positions[1] > positions[0], 'the cursor moves smoothly instead of clamping to zero');
        if (input === 'library') await page.screenshot({path:artifact(`frame-zero-left-${id}.png`)});
      }
      assert.equal((await call('get_review_session')).positionUs, playback.positionUs,'frame-zero hover does not seek');
      await page.mouse.move(0,0); await page.locator('[data-seg="full"]').click();
      await page.waitForFunction(() => +document.getElementById('bitstream-diagram-nalu-size').dataset.axisEnd === 10000000);
      const compactReferenceRadius = +await page.locator('#bitstream-diagram-references').getAttribute('data-node-radius');
      await page.locator('#bitstream-diagram-nalu-size').evaluate(c => { const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -280 * Math.log(20), clientX: r.left + r.width / 2, bubbles: true, cancelable: true })); });
      await page.waitForFunction(() => {
        const canvases = [...document.querySelectorAll('#analysis-canvas, .bitstream-diagrams canvas')];
        const range = canvases[0].dataset;
        return +range.axisEnd - +range.axisStart < 600000 && canvases.every(c => c.dataset.axisStart === range.axisStart && c.dataset.axisEnd === range.axisEnd);
      });
      await page.waitForFunction(before => +document.getElementById('bitstream-diagram-references').dataset.nodeRadius > before + 1, compactReferenceRadius);
      await page.getByRole('separator', { name: '调整码流分析高度', exact: true }).press('End');
      const multiple = await call('export_workspace');
      assert.deepEqual(multiple.layout.analysisView.diagrams, choices);
      const inspectionPosition = (await call('get_review_session')).positionUs;
      // Default appearance gives the three chart groups independent, linked tooltips.
      const hoverStyle = async value => {
        await page.locator('#settings-open').click();
        await page.locator('#settings-tab-appearance').click();
        await page.locator('#chart-hover-style').click();
        await page.locator(`#chart-hover-style-menu [data-value="${value}"]`).click();
        await page.locator('#settings-close').click();
        await page.locator('#settings').waitFor({ state: 'hidden' });
      };
      await hoverStyle('separate');
      const hoverTarget = page.locator('#bitstream-diagram-nalu-size');
      const hoverBounds = await hoverTarget.boundingBox();
      for (const fraction of [.2, .98]) {
        const lineX = hoverBounds.x + 46 + (hoverBounds.width - 46 - 16) * fraction;
        await page.mouse.move(lineX, hoverBounds.y + hoverBounds.height / 2);
        await page.locator('.analysis-view-card[data-diagram="references"]').waitFor({ state: 'visible' });
        const cards = page.locator('.analysis-view-card:visible');
        assert.equal(await cards.count(), 3, 'overview and paired NALU rows each share one card; references have their own');
        assert.equal(await page.locator('.analysis-linked-card:visible').count(), 0);
        const boxes = await cards.evaluateAll(elements => elements.map(element => {
          const r = element.getBoundingClientRect();
          const graph = document.querySelector(element.dataset.diagram === 'overview' ? '#analysis-canvas' : element.dataset.diagram === 'nalu' ? '#bitstream-diagram-nalu-size' : '#bitstream-diagram-references');
          const owner = graph.getBoundingClientRect(), range = graph.dataset;
          const lineX = owner.left + 46 + (+(range.hoverCursorTime || range.hoverTime) - +range.axisStart) / (+range.axisEnd - +range.axisStart) * (owner.width - 46 - 16);
          return { x:r.x, y:r.y, width:r.width, height:r.height, time:element.dataset.hoverTime, side:element.dataset.side, diagram:element.dataset.diagram, lineX };
        }));
        assert.ok(boxes.every(box => box.time && box.time === boxes[0].time), 'per-view cards inspect the same time');
        assert.ok(boxes.every(box => box.side === (fraction < .5 ? 'right' : 'left')), 'cards flip independently when the right side has insufficient space');
        assert.ok(boxes.every(box => box.side === 'right' ? box.x >= box.lineX + 23 : box.x + box.width <= box.lineX - 23), 'cards leave breathing room beside the hover line');
        assert.ok(boxes.every(box => box.x >= 8 && box.x + box.width <= page.viewportSize().width - 7 && box.y >= 8 && box.y + box.height <= page.viewportSize().height - 7));
        const vertical = boxes.sort((a,b) => a.y-b.y);
        assert.ok(vertical.slice(1).every((box,i) => box.y >= vertical[i].y + vertical[i].height + 3), 'per-view cards avoid vertical overlap');
        assert.ok(await cards.evaluateAll(elements => elements.every(e => e.scrollHeight <= e.clientHeight + 1)), 'cards retain complete contents instead of scrolling inside each owner');
        assert.equal(await cards.locator('.analysis-card-columns').count(), 0, 'NALU column header row is removed');
        const overviewText = await page.locator('.analysis-view-card[data-diagram="overview"]').innerText();
        assert.match(overviewText, /展示负载率[\s\S]*帧大小/);
        assert.doesNotMatch(overviewText, /NALU|推断层级|时间层级/);
        const naluCard = page.locator('.analysis-view-card[data-diagram="nalu"]');
        assert.equal(await naluCard.locator('table').count(), 1, 'paired NALU rows show their identical details only once');
        assert.match(await naluCard.innerText(), /编码帧[\s\S]*选中 NALU/);
        if (input === 'library') await page.screenshot({ path: artifact(`individual-cards-${fraction}.png`) });
      }
      // Single-view cards follow pointer Y continuously; changing the matched
      // frame does not move the anchor to a reference layer or bar height.
      for (const mode of ['references', 'nalu-size', 'overview']) {
        await selectDiagrams(page, mode);
        const graph = page.locator(mode === 'overview' ? '#analysis-canvas' : `#bitstream-diagram-${mode}`);
        await graph.waitFor({ state: 'visible' });
        const bounds = await graph.boundingBox();
        const group = mode === 'overview' ? 'overview' : mode === 'references' ? 'references' : 'nalu';
        const floating = page.locator(`.analysis-view-card[data-diagram="${group}"]`);
        const x = bounds.x + 46 + (bounds.width - 46 - 16) * .5;
        const centers = [];
        for (const fraction of [.4, .55]) {
          // Pointer coordinates are integer CSS pixels in WebKit.
          const y = Math.round(bounds.y + bounds.height * fraction);
          await page.mouse.move(x, y);
          await page.waitForFunction(({ group, y }) => {
            const card = document.querySelector(`.analysis-view-card[data-diagram="${group}"]`), r = card?.getBoundingClientRect();
            return card && !card.hidden && Math.abs(r.top + r.height / 2 - y) <= 1;
          }, { group, y });
          const r = await floating.boundingBox(); centers.push(r.y + r.height / 2);
        }
        assert.ok(Math.abs(centers[1] - centers[0] - bounds.height * .15) <= 2, `${mode}: card follows mouse Y without snapping to a frame`);
        // Keeping Y unchanged while selecting another frame preserves its centre.
        const y = Math.round(bounds.y + bounds.height * .55);
        await page.mouse.move(x + (bounds.width - 46 - 16) * .2, y);
        await page.waitForFunction(({ group, y }) => {
          const r = document.querySelector(`.analysis-view-card[data-diagram="${group}"]`).getBoundingClientRect();
          return Math.abs(r.top + r.height / 2 - y) <= 1;
        }, { group, y });
        for (const localY of [10, bounds.height - 30]) {
          // The time-axis strip below the plot intentionally dismisses hover.
          await page.mouse.move(x, bounds.y + localY);
          await page.waitForTimeout(40);
          const r = await floating.boundingBox();
          const owner = await page.locator(mode === 'overview' ? '#analysis-canvas' : `.bitstream-diagrams[data-diagram="${mode}"]`).boundingBox();
          assert.ok(r.y >= owner.y && r.y + r.height <= owner.y + owner.height, `${mode}: edge avoidance keeps the card in its chart`);
        }
        if (input === 'library' && mode === 'references') await page.screenshot({ path: artifact('reference-card-pointer-anchor.png') });
      }
      await selectDiagrams(page, choices);
      // The overview preserves the continuous pointer too, including directly
      // hit frame bars. Only their inspected time and sample markers snap.
      await page.waitForFunction(() => window.__vpAnalysis?.glyphs?.some(g => g.kind === 'sample' && !g.stacked && g.width > 16));
      const overviewBounds = await page.locator('#analysis-canvas').boundingBox();
      const glyph = await page.evaluate(() => {
        const qa = window.__vpAnalysis;
        return qa.glyphs.find(g => g.kind === 'sample' && !g.stacked && g.width > 16 && g.cx > qa.plot.width * .2 && g.cx < qa.plot.width * .4);
      });
      assert.ok(glyph, 'zoomed overview has a frame bar with room for continuous hover');
      for (const [row, y] of [['bitrate', overviewBounds.y + 12], ['size', overviewBounds.y + glyph.cy]]) {
        const snapshots = [];
        for (const dx of [2, 6]) {
          const x = overviewBounds.x + glyph.cx + dx;
          await page.mouse.move(x, y);
          const expected = await page.locator('#analysis-canvas').evaluate((c,x) => {
            const r=c.getBoundingClientRect(), d=c.dataset;
            const pixelUs=(+d.axisEnd-+d.axisStart)/(+d.plotRight-+d.plotLeft);
            return {time:+d.axisStart+(x-r.left-+d.plotLeft)*pixelUs,tolerance:pixelUs+2};
          }, x);
          await page.waitForFunction(expected => Math.abs(+document.getElementById('analysis-canvas').dataset.hoverCursorTime-expected.time)<expected.tolerance, expected);
          const lines = await page.locator('#analysis-canvas, .bitstream-diagrams canvas').evaluateAll(cs => cs.map(c => +c.dataset.hoverCursorTime));
          assert.ok(lines.every(t => Math.abs(t-lines[0])<2),'overview pointer synchronizes every continuous hover line');
          const hit = await page.evaluate(() => window.__vpAnalysis.inspection);
          if (row === 'size') {
            assert.equal(hit.direct?.sampleId,glyph.id,'bar hover preserves exact frame identity');
            assert.equal(hit.t,glyph.axisUs,'frame readouts stay at the hit timestamp');
            assert.ok(Math.abs(lines[0]-hit.t)>expected.tolerance,'hover position remains separate from the hit frame');
          }
          snapshots.push(await page.locator('.analysis-view-card:visible').evaluateAll(cs => cs.map(c => ({diagram:c.dataset.diagram,x:c.getBoundingClientRect().x,text:c.textContent}))));
        }
        for (const before of snapshots[0]) {
          const after=snapshots[1].find(c=>c.diagram===before.diagram);
          assert.ok(Math.abs(after.x-before.x-4)<=1,`${row} pointer moves ${before.diagram} card continuously`);
          if(row==='size') assert.equal(after.text,before.text,'bar hit updates contents independently of position');
        }
        if (input === 'library') {
          await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          await page.screenshot({path:artifact(`smooth-cursor-overview-${row}.png`)});
        }
      }
      assert.equal((await call('get_review_session')).positionUs,inspectionPosition,'overview hover does not seek');
      // Below the overview, moving within one frame keeps the hit but moves all
      // cursor lines and cards continuously. Crossing a frame updates only details.
      for (const mode of ['nalu-size', 'nalu-types', 'references']) {
        const target = page.locator(`#bitstream-diagram-${mode}`); await target.scrollIntoViewIfNeeded();
        const rect = await target.boundingBox();
        const axis = await target.evaluate(c => ({ start:+c.dataset.axisStart, end:+c.dataset.axisEnd }));
        const y = rect.y + rect.height / 2, tolerance = (axis.end - axis.start) / (rect.width - 46 - 16) + 2;
        // Start outside the cards: teleporting onto a previous scrollable tooltip
        // would exercise tooltip scrolling instead of this chart's pointer input.
        await page.mouse.move(4, 4);
        await page.mouse.move(rect.x + 46 + (rect.width - 46 - 16) * .3, y);
        await page.waitForFunction(({ id, time, tolerance }) => {
          const c = document.getElementById(id); return !!c.dataset.hoverAu && Math.abs(+c.dataset.hoverCursorTime - time) < tolerance;
        }, { id:`bitstream-diagram-${mode}`, time:axis.start + (axis.end - axis.start) * .3, tolerance });
        const hit = await target.evaluate(c => ({ time:+c.dataset.hoverTime, au:c.dataset.hoverAu }));
        const hitX = rect.x + 46 + (hit.time - axis.start) / (axis.end - axis.start) * (rect.width - 46 - 16);
        const snapshots = [];
        for (const dx of [2, 6]) {
          const x = hitX + dx;
          // Traverse continuously: a teleport beyond the card gap can land
          // directly on its scrollable surface instead of the chart below it.
          await page.mouse.move(x, y, { steps: 8 });
          const expectedCursor = axis.start + (x - rect.x - 46) / (rect.width - 46 - 16) * (axis.end - axis.start);
          // WebKit rounds dispatched mouse coordinates to CSS pixels.
          await page.waitForFunction(({ id, time, tolerance }) => Math.abs(+document.getElementById(id).dataset.hoverCursorTime - time) < tolerance, { id:`bitstream-diagram-${mode}`, time:expectedCursor, tolerance });
          const lines = await page.locator('#analysis-canvas, .bitstream-diagrams canvas').evaluateAll(cs => cs.map(c => +c.dataset.hoverCursorTime));
          assert.ok(Math.abs(lines[0] - expectedCursor) < tolerance && lines.every(t => Math.abs(t - lines[0]) < 2), 'all selected views share the smooth cursor time');
          assert.equal(await target.getAttribute('data-hover-au'), hit.au, 'small pointer moves keep the same frame hit');
          snapshots.push(await page.locator('.analysis-view-card:visible').evaluateAll(cs => cs.map(c => ({ diagram:c.dataset.diagram, x:c.getBoundingClientRect().x, text:c.textContent }))));
        }
        for (const before of snapshots[0]) {
          const after = snapshots[1].find(c => c.diagram === before.diagram);
          assert.ok(Math.abs(after.x - before.x - 4) <= 1, `${mode} moves ${before.diagram} card continuously with the cursor`);
          assert.equal(after.text, before.text, 'frame details do not change between hits');
        }
        assert.equal((await call('get_review_session')).positionUs, inspectionPosition, 'smooth inspection does not seek playback');
        if (input === 'library') {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.screenshot({ path: artifact(`smooth-cursor-${mode}.png`) });
        }
      }
      // Theme changes must redraw real glyph outlines, including the overview's
      // overlay. Reading pixels catches the original hard-coded white border.
      for (const theme of ['light', 'dark']) {
        await page.locator('#settings-open').click();
        await page.locator('#settings-tab-appearance').click();
        await page.locator(`[data-theme-choice="${theme}"]`).click();
        await page.locator('#settings-close').click();
        await page.waitForFunction(() => !document.querySelector('#settings').open && document.activeElement === document.querySelector('#settings-open'));
        const target = page.locator('#bitstream-diagram-nalu-size'), rect = await target.boundingBox();
        await page.mouse.move(rect.x + 46 + (rect.width - 46 - 16) * .3, rect.y + rect.height / 2);
        await page.waitForFunction(() => !!document.getElementById('bitstream-diagram-nalu-size').dataset.hoverAu);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const outlines = await page.locator('#analysis-overlay, .bitstream-diagrams canvas').evaluateAll(canvases => canvases.map(canvas => {
          const probe = document.createElement('canvas'); probe.width = probe.height = 1;
          const probeCtx = probe.getContext('2d');
          probeCtx.fillStyle = getComputedStyle(canvas).getPropertyValue('--text').trim(); probeCtx.fillRect(0, 0, 1, 1);
          const color = probeCtx.getImageData(0, 0, 1, 1).data;
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 200 && [0, 1, 2].every(c => Math.abs(pixels[i + c] - color[c]) < 3)) count++;
          return { id: canvas.id, count };
        }));
        for (const outline of outlines) assert.ok(outline.count > 3, `${theme}: ${outline.id} visibly outlines the hit with the theme foreground`);
        const referencePalette = await page.locator('#bitstream-diagram-references').evaluate(canvas => {
          const style = getComputedStyle(canvas), ctx = canvas.getContext('2d');
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const probe = document.createElement('canvas'); probe.width = probe.height = 1;
          const pc = probe.getContext('2d');
          const colors = ['--analysis-reference-l0', '--analysis-reference-l1'].map(token => {
            pc.clearRect(0, 0, 1, 1); pc.fillStyle = style.getPropertyValue(token).trim(); pc.fillRect(0, 0, 1, 1);
            return [...pc.getImageData(0, 0, 1, 1).data].slice(0, 3);
          });
          const counts = colors.map(color => {
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 180 && color.every((v, c) => Math.abs(pixels[i + c] - v) < 4)) count++;
            return count;
          });
          return { colors, counts };
        });
        assert.ok(referencePalette.colors[0][0] > referencePalette.colors[0][2], 'L0 uses a warm hue instead of the P-node blue');
        assert.ok(referencePalette.colors[1][1] - Math.max(referencePalette.colors[1][0], referencePalette.colors[1][2]) > 20, 'L1 uses green, distinct from orange L0 and blue P nodes');
        assert.ok(referencePalette.counts[0] > 3, `${theme}: L0 edges render in the new palette`);
        assert.equal(await page.locator('[data-reference-list="1"] i').evaluate(dot => getComputedStyle(dot).borderTopStyle), 'dashed', 'L1 legend repeats the dashed edge style');
        if (input === 'library') await page.screenshot({ path: artifact(`hit-outlines-${theme}.png`) });
      }
      await page.locator('#settings-open').click();
      await page.locator('[data-theme-choice="light"]').click();
      await page.locator('#settings-close').click();
      await page.mouse.move(hoverBounds.x-10,hoverBounds.y);
      await page.locator('#bitstream-diagram-nalu-size').evaluate(c => {
        const r=c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel',{deltaX:-100000,clientX:r.left+46,bubbles:true,cancelable:true}));
      });
      await page.waitForFunction(() => {
        const q=window.__vpAnalysis;
        return q?.view.start<0 && q.glyphs.some(g=>g.kind==='sample' && g.axisUs===0);
      });
      const edge = await page.evaluate(() => {
        const c=document.getElementById('analysis-canvas'),d=c.dataset,q=window.__vpAnalysis;
        return {first:q.glyphs.find(g=>g.kind==='sample' && g.axisUs===0),left:+d.plotLeft,right:+d.plotRight,start:+d.axisStart,end:+d.axisEnd};
      });
      const interval = 1_000_000/30, expectedWidth=interval/(edge.end-edge.start)*(edge.right-edge.left)*.7;
      assert.ok(Math.abs(edge.first.width-expectedWidth)<.05,'overview frame bars have the same width formula as NALU bars');
      assert.ok(edge.first.cx-edge.first.width/2>edge.left,'first frame is fully inside the plot instead of cropped');
      const zeroX = edge.left+(0-edge.start)/(edge.end-edge.start)*(edge.right-edge.left);
      assert.ok(zeroX-edge.left>=8,'time zero leaves room for reference node and bar');
      await page.waitForFunction(() => {
        const cs=[...document.querySelectorAll('#analysis-canvas, .bitstream-diagrams canvas, #analysis-shared-axis')];
        return cs.every(c=>(c.id==='analysis-shared-axis'?c.dataset.viewStart:c.dataset.axisStart)===cs[0].dataset.axisStart && (c.id==='analysis-shared-axis'?c.dataset.viewEnd:c.dataset.axisEnd)===cs[0].dataset.axisEnd);
      });
      const edgeAxes = await page.locator('#analysis-canvas, .bitstream-diagrams canvas, #analysis-shared-axis').evaluateAll(cs=>cs.map(c=>c.id==='analysis-shared-axis'?[c.dataset.viewStart,c.dataset.viewEnd]:[c.dataset.axisStart,c.dataset.axisEnd]));
      assert.ok(edgeAxes.every(range=>range[0]===edgeAxes[0][0] && range[1]===edgeAxes[0][1]),'first-frame padding is shared by every chart and the bottom range pointers');
      if (input==='library') await page.screenshot({path:artifact('first-frame-padding.png')});
      for (const mode of ['bitrate', 'size', 'nalu-types', 'nalu-size']) {
        await selectDiagrams(page, mode);
        const target = page.locator(mode === 'bitrate' || mode === 'size' ? '#analysis-canvas' : `#bitstream-diagram-${mode}`);
        await target.waitFor({ state: 'visible' });
        const rect = await target.boundingBox();
        await page.mouse.move(rect.x + 46 + (rect.width - 46 - 16) * .35, rect.y + rect.height / 2);
        const single = page.locator('.analysis-view-card:visible');
        await single.waitFor({ state: 'visible' });
        assert.equal(await single.count(), 1, 'a single selected row still shows one group card');
        const text = await single.innerText();
        if (mode === 'bitrate') { assert.match(text, /展示负载率/); assert.doesNotMatch(text, /帧大小/); }
        else if (mode === 'size') { assert.match(text, /帧大小/); assert.doesNotMatch(text, /展示负载率/); }
        else {
          assert.match(text, /编码帧[\s\S]*选中 NALU/); assert.equal(await single.getAttribute('data-diagram'), 'nalu');
          if (mode === 'nalu-types') { assert.match(text, /个/); assert.doesNotMatch(text, /KiB|类型|数量|大小/); }
          else { assert.match(text, /KiB/); assert.doesNotMatch(text, /类型|数量|大小/); }
        }
      }
      await selectDiagrams(page, choices);
      await hoverStyle('combined');
      assert.equal(await page.evaluate(() => localStorage.getItem('voidplayer.chart-hover-style')), 'combined', 'appearance selection is persisted independently of the workspace');

      for (const mode of ['nalu-size', 'nalu-types', 'references']) {
        const target = page.locator(`#bitstream-diagram-${mode}`);
        await target.scrollIntoViewIfNeeded();
        await target.focus(); await page.keyboard.press('ArrowRight');
        const card = page.locator('.analysis-linked-card');
        await card.waitFor({ state: 'visible' });
        assert.equal(await page.locator('.analysis-card:visible').count(), 1, 'only one card across all charts');
        const linked = await page.locator('.bitstream-diagrams canvas').evaluateAll(cs => cs.map(c => ({time:c.dataset.hoverTime, au:c.dataset.hoverAu})));
        assert.ok(linked.every(c => c.time && c.time === linked[0].time && c.au && c.au === linked[0].au), 'all deep views highlight the same exact AU');
        assert.equal(await card.locator('.analysis-card-section').count(), 3, 'stream, NALU and references form three sections');
        assert.equal((await call('get_review_session')).positionUs, inspectionPosition, 'keyboard inspection does not trigger global frame stepping');
        const sections = await card.locator('.analysis-card-section:visible').evaluateAll(parts => parts.map(part => ({
          title:part.querySelector('strong').textContent, rect:part.getBoundingClientRect().toJSON(),
          labelWidth:part.querySelector('tbody th').getBoundingClientRect().width,
        })));
        assert.deepEqual(sections.map(part=>part.title), ['码流','NALU','帧参考']);
        assert.ok(sections.every(part=>Math.abs(part.rect.y-sections[0].rect.y)<1), 'the three sections sit alongside');
        assert.ok(Math.abs(sections[0].labelWidth-72)<1, 'stream metrics retain their label column');
        const metadata = await card.locator('[data-kind="nalu"] .analysis-card-frame').evaluate(row => {
          const cell = row.querySelector('td'), text = document.createRange(); text.selectNodeContents(cell);
          return { layout:getComputedStyle(row).display, width:row.getBoundingClientRect().width, bodyWidth:row.parentElement.getBoundingClientRect().width, lines:text.getClientRects().length };
        });
        assert.equal(metadata.layout, 'flex', 'combined NALU uses the shared metadata layout');
        assert.ok(Math.abs(metadata.width-metadata.bodyWidth)<1, 'frame metadata uses the complete section width');
        assert.equal(metadata.lines, 1, 'frame metadata stays on one line when the full row has room');
        assert.ok(sections[1].rect.x > sections[0].rect.x+sections[0].rect.width && sections[2].rect.x > sections[1].rect.x+sections[1].rect.width,'sections occupy distinct horizontal columns');
        assert.ok((await card.boundingBox()).height < 230,'the shared card stays short enough to compare without scrolling');
        assert.match(await card.locator('.analysis-stream-grid [data-metric="bitrate"] td').innerText(), /Mbps|—/);
        assert.equal(await card.locator('.analysis-card-columns').count(), 0, 'NALU cards omit redundant column headings');
        assert.equal(await card.locator('[data-kind="nalu"] .analysis-card-total td').count(), 2, 'NALU totals retain count and size columns');
        assert.match(await card.innerText(), /编码帧/);
        assert.match(await card.innerText(), mode === 'references' ? /≈\d[\s\S]*L0[\s\S]*L1/ : /选中 NALU[\s\S]*KiB/);
        const rect = await card.boundingBox(), viewport = page.viewportSize();
        assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height);
        if (input === 'library') await page.screenshot({ path: artifact(`multiple-${mode}-card.png`) });
        const anchor = await target.boundingBox();
        const panelBox = await page.locator('#analysis-panel').boundingBox();
        assert.ok(Math.abs(rect.y - (panelBox.y + panelBox.height + 6)) <= 1, 'combined details stay below the whole analysis panel');
        await page.mouse.move(anchor.x + anchor.width * .25, anchor.y + anchor.height / 2);
        await card.waitFor({ state: 'visible' });
        const leftCard = await card.boundingBox();
        await page.mouse.move(anchor.x + anchor.width * .75, anchor.y + anchor.height / 2);
        await card.waitFor({ state: 'visible' });
        const rightCard = await card.boundingBox();
        assert.ok(rightCard.x - leftCard.x > anchor.width * .2, 'combined details follow the hover line horizontally');
        assert.equal(rightCard.y, leftCard.y, 'hovering keeps the card beneath the panel');
        const visibleAxis = await target.evaluate(c => ({ start:+c.dataset.axisStart, end:+c.dataset.axisEnd }));
        const firstMediaFraction = Math.max(.01, -visibleAxis.start / (visibleAxis.end-visibleAxis.start) + 2/(anchor.width-46 - 16));
        for (const fraction of [firstMediaFraction, .99]) {
          await page.mouse.move(anchor.x + 46 + (anchor.width - 46 - 16) * fraction, anchor.y + anchor.height / 2);
          const edgeCard = await card.boundingBox();
          assert.ok(edgeCard.x >= 8 && edgeCard.x + edgeCard.width <= viewport.width - 7, 'following card remains within both screen edges');
        }
        await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
        await card.waitFor({ state: 'visible' });
        const hoverTime = await card.getAttribute('data-hover-time');
        // Crossing a chart header stays within the shared inspection area.
        await page.mouse.move(anchor.x + anchor.width / 2, anchor.y - 2);
        await card.waitFor({ state: 'visible' });
        assert.equal(await card.getAttribute('data-hover-time'), hoverTime, 'chart headers do not dismiss or recompute the shared card');
        await page.keyboard.press('Escape'); await card.waitFor({ state: 'hidden' });
        const box = await target.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await card.waitFor({ state: 'visible' });
        assert.equal((await call('get_review_session')).positionUs, inspectionPosition, 'pointer hover only reads chart records');
        await page.mouse.move(4, 4); await card.waitFor({ state: 'hidden' });
      }
      // Every diagram uses real DTS positions, rather than merely matching a PTS AU.
      await page.getByRole('button', { name: 'DTS', exact: true }).click();
      await page.waitForFunction(() => [...document.querySelectorAll('.bitstream-diagrams canvas')].every(c=>c.dataset.axis==='dts'));
      const decodeRange = await axis(page.locator('#bitstream-diagram-nalu-size'));
      const decodeChart = await call('query_bitstream_chart', { slot:'A', axis:'dts', startUs:decodeRange.start, endUs:decodeRange.end, pixelWidth:1024 });
      assert.equal(decodeChart.axis, 'dts');
      const targetFrame = decodeChart.pictures.find(p=>p.sourceDtsUs!=null && p.sourceDtsUs!==p.sourcePtsUs && p.references?.state==='ready' && p.sourceDtsUs-decodeChart.firstPtsUs+decodeChart.offsetUs>decodeRange.start+20_000 && p.sourcePtsUs-decodeChart.firstPtsUs+decodeChart.offsetUs<decodeRange.end-20_000);
      assert.ok(targetFrame, 'B-frame fixture exposes distinct real presentation and decode timestamps in the shared window');
      const expectedDts = targetFrame.sourceDtsUs-decodeChart.firstPtsUs+decodeChart.offsetUs;
      for (const mode of ['nalu-size','nalu-types','references']) {
        const target = page.locator(`#bitstream-diagram-${mode}`);
        await target.scrollIntoViewIfNeeded();
        const g = await target.evaluate(c=>({box:c.getBoundingClientRect().toJSON(),left:+c.dataset.plotLeft,right:+c.dataset.plotRight,radius:+c.dataset.nodeRadius,maxLayer:+c.dataset.maxLayer}));
        const x = g.box.x+g.left+(expectedDts-decodeRange.start)/(decodeRange.end-decodeRange.start)*(g.right-g.left);
        const bottom=g.box.height-4, inset=g.radius+2;
        const y = mode==='references' ? bottom-inset-(targetFrame.referenceLayer?.level??0)/Math.max(1,g.maxLayer)*(bottom-8-inset*2) : g.box.height/2;
        await page.mouse.move(x,g.box.y+y);
        await page.waitForFunction(({au,time})=>[...document.querySelectorAll('.bitstream-diagrams canvas')].every(c=>+c.dataset.hoverAu===au && +c.dataset.hoverTime===time), {au:targetFrame.picture.au,time:expectedDts});
        assert.match(await page.locator('.analysis-linked-card').innerText(), /DTS[\s\S]*PTS/);
        assert.doesNotMatch(await page.locator('.analysis-linked-card').innerText(), /展示负载率/);
        assert.equal((await call('get_review_session')).positionUs, inspectionPosition);
      }
      // Activation in decode-time view still seeks the frame's presentation time.
      await page.locator('#bitstream-diagram-nalu-size').focus(); await page.keyboard.press('Enter');
      const expectedPts=targetFrame.sourcePtsUs-decodeChart.firstPtsUs+decodeChart.offsetUs;
      await page.waitForFunction(t=>window.voidPlayer.getState().positionUs===t,expectedPts);
      await call('seek_review',{ptsUs:inspectionPosition}); await page.keyboard.press('Escape');
      await selectDiagrams(page,'nalu-size');
      assert.equal(await page.locator('#analysis-axis').isVisible(),true,'time-base control remains available without overview charts');
      await page.getByRole('button', { name: 'PTS', exact: true }).click();
      await page.waitForFunction(()=>document.getElementById('bitstream-diagram-nalu-size').dataset.axis==='pts');
      const ptsChart=await call('query_bitstream_chart',{slot:'A',axis:'pts',startUs:decodeRange.start,endUs:decodeRange.end,pixelWidth:1024});
      assert.deepEqual(ptsChart.pictures.find(p=>p.picture.au===targetFrame.picture.au)?.referenceLayer,targetFrame.referenceLayer,'switching time bases preserves inferred reference levels');
      await selectDiagrams(page,choices);
      await page.waitForFunction(() => {
        const charts = document.querySelector('.analysis-charts');
        const plots = document.querySelectorAll('#analysis-canvas, .bitstream-diagrams canvas');
        return plots.length === 4 && [...plots].every(c => c.dataset.timeAxis === 'false' && Math.abs(c.getBoundingClientRect().height-c.parentElement.clientHeight)<=1);
      });
      const compactGeometry = await page.locator('#analysis-canvas, .bitstream-diagrams canvas').evaluateAll(cs => cs.map(c => {
        const r = c.getBoundingClientRect(), container = c.closest('.analysis-charts').getBoundingClientRect();
        return { left: r.left + +c.dataset.plotLeft, right: r.left + +c.dataset.plotRight, height: r.height, timeAxis: c.dataset.timeAxis, fitsPlot:Math.abs(r.height-c.parentElement.clientHeight)<=1 };
      }));
      assert.equal(compactGeometry.length, 4);
      assert.ok(compactGeometry.every(c => c.fitsPlot && c.height >= 36 && c.timeAxis === 'false'), `all selected plots retain full height without duplicate time axes: ${JSON.stringify(compactGeometry)}`);
      assert.ok(compactGeometry.every(c => Math.abs(c.left - compactGeometry[0].left) <= 1 && Math.abs(c.right - compactGeometry[0].right) <= 1), 'every chart shares the overview plot boundaries');
      const sharedAxis = page.locator('#analysis-shared-axis');
      assert.equal(await sharedAxis.isVisible(), true);
      await openRangeEditor(page);
      const rangeStart = page.locator('.analysis-window-handle.start');
      const rangePreview = page.locator('#analysis-range-time-start .analysis-range-time-text');
      await rangeStart.hover();
      assert.equal(await rangePreview.isVisible(), true, 'range start time remains visible');
      assert.equal(await rangePreview.textContent(), await rangeStart.getAttribute('aria-valuetext'));
      assert.equal(await rangeStart.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'hover leaves the invisible hit area transparent');
      assert.notEqual(await rangeStart.evaluate(e => getComputedStyle(e, '::before').transform), 'none', 'hover enlarges the visible bar itself');
      assert.ok(Number(await rangeStart.getAttribute('aria-valuenow')) >= 0, 'PTS range handle excludes decorative negative-time padding');
      const handleBounds = await rangeStart.boundingBox();
      assert.ok(handleBounds.width >= 32 && handleBounds.height >= 28, 'small visible handle retains a larger hit area');
      const initialRangeStart = await rangeStart.getAttribute('aria-valuenow');
      await page.mouse.move(handleBounds.x + handleBounds.width - 3, handleBounds.y + handleBounds.height / 2);
      await page.mouse.down();
      assert.equal(await rangeStart.getAttribute('data-dragging'), 'true', 'press in the outer hit area visibly captures the handle');
      await page.mouse.move(handleBounds.x + handleBounds.width - 3, handleBounds.y + handleBounds.height / 2);
      assert.equal(await rangeStart.getAttribute('aria-valuenow'), initialRangeStart, 'grabbing the outer hit area does not jump the range');
      await page.mouse.up();
      assert.equal(await rangeStart.getAttribute('data-dragging'), null);
      await rangeStart.focus();
      await page.mouse.move(0, 0);
      assert.equal(await rangePreview.isVisible(), true, 'keyboard focus retains the permanent range time');
      await rangeStart.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('#analysis-range-time-start .analysis-range-time-text').textContent === document.querySelector('.analysis-window-handle.start').getAttribute('aria-valuetext'));
      await rangeStart.press('Home');
      await page.waitForFunction(() => {
        const axis = document.querySelector('#analysis-shared-axis').dataset, chart = document.querySelector('#analysis-canvas').dataset;
        return axis.axisStart === chart.axisStart && axis.axisEnd === chart.axisEnd && +document.querySelector('.analysis-window-handle.start').getAttribute('aria-valuenow') === 0;
      });
      await rangeStart.evaluate(e => e.blur());
      assert.equal(await rangePreview.isVisible(), true, 'range time remains visible after leaving and blurring');
      assert.equal(await page.locator('#analysis-window-preview').count(),0,'hover time bubbles are removed');
      const sharedAxisGeometry = await sharedAxis.evaluate(c => {
        const r = c.getBoundingClientRect(), charts = document.querySelector('.analysis-charts').getBoundingClientRect();
        return { left: r.left + +c.dataset.plotLeft, right: r.left + +c.dataset.plotRight, height: r.height, belowCharts: r.top >= charts.bottom - 1, start: c.dataset.viewStart, end: c.dataset.viewEnd };
      });
      assert.ok(sharedAxisGeometry.belowCharts && sharedAxisGeometry.height === 22, 'one shared time axis sits below the chart stack');
      assert.equal(sharedAxisGeometry.left, compactGeometry[0].left);
      assert.equal(sharedAxisGeometry.right, compactGeometry[0].right);
      assert.equal(sharedAxisGeometry.start, await page.locator('#analysis-canvas').getAttribute('data-axis-start'));
      assert.equal(sharedAxisGeometry.end, await page.locator('#analysis-canvas').getAttribute('data-axis-end'));
      await sharedAxis.evaluate(c => {
        const r = c.getBoundingClientRect();
        const event = new WheelEvent('wheel', { ctrlKey: true, deltaY: -280 * Math.log(2), clientX: r.left + 46 + (r.width - 46 - 16) / 2, bubbles: true, cancelable: true });
        c.dispatchEvent(event);
        if (!event.defaultPrevented) throw new Error('shared axis must own pinch input');
      });
      await page.waitForFunction(() => {
        const shared = document.querySelector('#analysis-shared-axis').dataset;
        return [...document.querySelectorAll('#analysis-canvas, .bitstream-diagrams canvas')].every(c => c.dataset.axisStart === shared.viewStart && c.dataset.axisEnd === shared.viewEnd);
      });
      const axisZoom = (await call('export_workspace')).layout.analysisView.view;
      assert.ok(Math.abs(axisZoom.end - axisZoom.start - (+sharedAxisGeometry.end - +sharedAxisGeometry.start) / 2) <= 2, 'pinching the shared axis zooms all plots together');
      assert.equal((await call('get_review_session')).positionUs, inspectionPosition, 'shared axis navigation does not seek playback');
      const navigator = page.locator('#analysis-range-axis');
      assert.equal(await navigator.isVisible(), true, 'full-clip navigation is separate from the chart axis');
      const axisDomains = await page.evaluate(() => {
        const chart = document.querySelector('#analysis-shared-axis').dataset, full = document.querySelector('#analysis-range-axis').dataset;
        return { chart:[+chart.axisStart,+chart.axisEnd], view:[+chart.viewStart,+chart.viewEnd], full:[+full.domainStart,+full.domainEnd] };
      });
      assert.deepEqual(axisDomains.chart, axisDomains.view, 'visible time labels match the zoomed chart window');
      assert.ok(axisDomains.full[1]-axisDomains.full[0] > axisDomains.chart[1]-axisDomains.chart[0], 'full-clip navigator retains its independent absolute scale');
      const navBox = await navigator.boundingBox();
      const targetTime = Math.round((axisDomains.full[1]-Math.max(0,axisDomains.full[0]))*.7);
      const targetX = navBox.x + 10 + (targetTime-axisDomains.full[0])/(axisDomains.full[1]-axisDomains.full[0])*(navBox.width-20);
      const viewBeforeSeek = (await call('export_workspace')).layout.analysisView.view;
      await page.mouse.click(targetX, navBox.y+3);
      await page.waitForFunction(t => Math.abs(window.voidPlayer.getState().positionUs-t)<100_000,targetTime);
      assert.deepEqual((await call('export_workspace')).layout.analysisView.view,viewBeforeSeek,'clicking the full-clip rail seeks without changing the chart window');
      await page.waitForFunction(() => +document.querySelector('.analysis-range-playhead').dataset.positionUs===window.voidPlayer.getState().positionUs);
      const band = await page.locator('.analysis-window-band').boundingBox();
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x,y)?.classList.contains('analysis-window-band'),{x:band.x+band.width/2,y:band.y+1}),true,'the middle of a narrow selection remains available for panning');
      const positionBeforePan = (await call('get_review_session')).positionUs;
      await page.mouse.move(band.x+band.width/2,band.y+1); await page.mouse.down();
      await page.mouse.move(band.x+band.width/2+20,band.y+1); await page.mouse.up();
      await page.waitForFunction(start=>+document.querySelector('#analysis-shared-axis').dataset.axisStart!==start,viewBeforeSeek.start);
      assert.equal((await call('get_review_session')).positionUs,positionBeforePan,'dragging the selected window pans the charts without seeking playback');
      await call('seek_review',{ptsUs:inspectionPosition});
      // The band drag above intentionally panned the charts: re-baseline here so
      // the wheel check below tests vertical scrolling, not the earlier pan.
      // (axisZoom predates the pan since 68031e7 and can never match again.)
      multiple.layout.analysisView.view = (await call('export_workspace')).layout.analysisView.view;
      if (input === 'library') await page.screenshot({ path: artifact('multiple-compact-charts.png') });
      // At the minimum panel height, readable minima take priority over fitting.
      await page.getByRole('separator', { name: '调整码流分析高度', exact: true }).press('Home');
      await page.waitForFunction(() => {
        const charts = document.querySelector('.analysis-charts');
        const overview = document.querySelector('.analysis-overview');
        return charts.scrollHeight > charts.clientHeight + 1 && overview.getBoundingClientRect().height >= charts.clientHeight;
      });
      const minimumGeometry = await page.evaluate(() => {
        const panel = document.querySelector('.analysis-panel'), charts = document.querySelector('.analysis-charts');
        const style = getComputedStyle(panel), minimum = +document.querySelector('#analysis-resize').getAttribute('aria-valuemin');
        const available = minimum - document.querySelector('.analysis-head').getBoundingClientRect().height
          - document.querySelector('.analysis-shared-axis').getBoundingClientRect().height
          - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
        const rowHeights=JSON.parse(document.querySelector('#analysis-canvas').dataset.rowHeights);
        return { available, overviewMinimum:rowHeights.length*Math.max(36,available)+document.querySelector('#analysis-load-metrics').getBoundingClientRect().height, height: charts.clientHeight, overview: document.querySelector('.analysis-overview').getBoundingClientRect().height,
          deep: [...charts.querySelectorAll(':scope > .bitstream-diagrams')].map(el => el.getBoundingClientRect().height) };
      });
      assert.ok(Math.abs(minimumGeometry.height - minimumGeometry.available) <= 1, 'minimum panel exposes exactly the available chart area');
      assert.ok(Math.abs(minimumGeometry.overview - minimumGeometry.overviewMinimum) <= 1, 'each overview row retains the entire usable height of a standalone chart');
      assert.ok(minimumGeometry.deep.every(height => height >= minimumGeometry.available - 1), 'each separate deep chart retains at least one minimum panel of usable height');
      const fixedAxis = await sharedAxis.boundingBox();
      await page.locator('#analysis-canvas').scrollIntoViewIfNeeded();
      const scrollBox = await page.locator('#analysis-canvas').boundingBox();
      const visibleCharts = await page.locator('.analysis-charts').boundingBox();
      const startScroll = await page.locator('.analysis-charts').evaluate(el => el.scrollTop);
      checkpoint('vertical-scroll-baseline', { input, view: multiple.layout.analysisView.view, startScroll, fixedAxis });
      const visibleTop = Math.max(scrollBox.y, visibleCharts.y), visibleBottom = Math.min(scrollBox.y + scrollBox.height, visibleCharts.y + visibleCharts.height);
      await page.mouse.move(scrollBox.x + scrollBox.width / 2, (visibleTop + visibleBottom) / 2);
      await page.mouse.wheel(0, 160);
      await phase('analysis-vertical-scroll', () => page.waitForFunction(before => document.querySelector('.analysis-charts').scrollTop > before, startScroll));
      assert.deepEqual((await call('export_workspace')).layout.analysisView.view, multiple.layout.analysisView.view, 'vertical scrolling does not pan time');
      assert.deepEqual(await sharedAxis.boundingBox(), fixedAxis, 'shared axis stays visible while charts scroll');
      const previousViewport = page.viewportSize();
      await page.setViewportSize({ width: 821, height: 786 });
      await selectDiagrams(page, ['size', 'references']);
      await page.waitForFunction(() => {
        const charts = document.querySelector('.analysis-charts'), overview = document.querySelector('.analysis-overview');
        return Math.abs(overview.getBoundingClientRect().height - charts.clientHeight) <= 1;
      });
      const narrowMinimum = await page.locator('.analysis-charts').evaluate(el => ({
        available: el.clientHeight, minimum: parseFloat(el.style.getPropertyValue('--analysis-view-min-height')),
        canvas: document.querySelector('#analysis-canvas').getBoundingClientRect().height,
      }));
      assert.ok(Math.abs(narrowMinimum.minimum - narrowMinimum.available) <= 1 && Math.abs(narrowMinimum.canvas - narrowMinimum.available) <= 1, 'minimum chart follows the actual toolbar height in a narrow viewport');
      await page.setViewportSize(previousViewport);
      await selectDiagrams(page, choices);
      await page.getByRole('separator', { name: '调整码流分析高度', exact: true }).press('End');
      await page.locator('#analysis-canvas').scrollIntoViewIfNeeded();
      // Whole-film inspection is explicitly aggregated, never a guessed frame.
      await page.locator('[data-seg="full"]').click();
      await page.waitForFunction(() => document.querySelector('#bitstream-diagram-nalu-size').dataset.aggregated === 'true');
      await page.locator('#bitstream-diagram-nalu-size').press('ArrowRight');
      await page.locator('.analysis-linked-card').waitFor({ state: 'visible' });
      assert.match(await page.locator('.analysis-linked-card').innerText(), /汇总帧数[\s\S]*平均每帧/);
      await page.keyboard.press('Escape');
      // Restore the comparison viewport before testing workspace persistence.
      await page.locator('#bitstream-diagram-nalu-size').evaluate(c => { const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -280 * Math.log(20), clientX: r.left + r.width / 2, bubbles: true, cancelable: true })); });
      // Save the resulting range rather than assuming the zoom anchor did not move.
      multiple.layout.analysisView.view = (await call('export_workspace')).layout.analysisView.view;
      await page.locator('#analysis-diagrams [data-value="bitrate"]').press('Enter');
      assert.equal(await page.locator('#analysis-diagrams [data-value="bitrate"]').getAttribute('aria-pressed'), 'false', 'Enter toggles a view off directly');
      await page.locator('#analysis-diagrams [data-value="bitrate"]').press('Enter');
      assert.equal(await page.locator('#analysis-diagrams [data-value="bitrate"]').getAttribute('aria-pressed'), 'true', 'Enter toggles the view back on');
      if (input === 'library') await page.screenshot({ path: artifact('multiple-chart-buttons.png') });
      await page.keyboard.press('Escape');
      await selectDiagrams(page, []);
      assert.equal(await sharedAxis.isVisible(), false, 'empty selection has no shared axis');
      assert.equal(await page.locator('.bitstream-diagrams canvas').count(), 0);
      assert.equal(await page.locator('.analysis-no-charts').isVisible(), true);
      assert.equal(await page.locator('.analysis-linked-card:visible').count(), 0, 'empty selection hides the shared card');
      assert.ok(requests.slice(requestsBefore).filter(r => r.method === 'POST' && /bitstream-analysis\/requests/.test(r.url)).every(r => r.target?.mode==='stream' && r.target.window), 'chart selections and hover do not launch whole-source analysis');
      const importing = call('import_workspace', { document: multiple });
      if (input === 'local-file') {
        await page.getByLabel('重新选择 incremental.mp4', { exact: true }).setInputFiles(path.join(limitsDir, 'incremental.mp4'));
        await page.getByRole('button', { name: '打开工作区', exact: true }).click();
      }
      await importing;
      await page.waitForFunction(() => document.querySelectorAll('.bitstream-diagrams canvas').length === 3);
      assert.deepEqual((await call('export_workspace')).layout.analysisView.diagrams, choices);
      assert.deepEqual((await call('export_workspace')).layout.analysisView.view, multiple.layout.analysisView.view);
      await selectDiagrams(page, 'overview');
      await page.waitForFunction(() => document.querySelector('#analysis-canvas').dataset.timeAxis === 'false');
      assert.equal(await sharedAxis.isVisible(), true, 'overview alone retains the fixed panel axis');

    }
}
