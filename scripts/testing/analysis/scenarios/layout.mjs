import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { selectDiagrams, inspectCurrentWindow } from '../controls.mjs';


export async function run(context) {
const { page, artifact, engine, limitsDir, overlayOnly, errors, requests, rows, call, openAnalysis, hideOverlay, setMode, stable, library } = context;

      for (const input of ['local-file', 'library']) {
        console.log(`${engine}: overlay and opt-in analysis ${input}`);
        if (await page.locator('#analysis-diagrams').count()) await selectDiagrams(page, 'overview');
        for (const slot of ['A', 'B']) {
          await call('remove_review_track', { slot });
          const name = slot === 'A' ? 'stream.mp4' : 'stream-2.mp4';
          if (input === 'local-file') await page.locator(`#file-${slot}`).setInputFiles(path.join(limitsDir, name));
          else await call('load_library_item', { slot, id: library.entries.find(e => e.name === name).id });
          await page.waitForFunction(slot => { const state=window.voidPlayer.getState(); return !state.busy && state.tracks.some(t=>t.slot===slot && t.frame && !t.failure); }, slot);
        }
        await stable(); await call('seek_review', { ptsUs: 3_200_000 });
        const beforeOverview = requests.length;
        if (!await page.locator('#analysis-panel').isVisible()) await page.locator('#toggle-analysis').click();
        await page.waitForFunction(() => Number(document.querySelector('#analysis-canvas')?.dataset.plotRight) > 0);
        assert.equal(await page.locator('#analysis-load-metrics [data-metric="qp"]').getAttribute('aria-pressed'), 'false', 'QP is opt-in');
        assert.deepEqual((await call('export_workspace')).layout.analysisView.loadMetrics, ['bitrate']);
        assert.ok(!requests.slice(beforeOverview).some(r => /voidplayer-analysis|local-worker|bitstream-analysis/.test(r.url)), 'opening the lightweight overview starts no deep analysis');
        for (const slot of ['A', 'B']) assert.equal((await call('get_bitstream_analysis_state', {slot})).state, 'idle');
        for (const slot of ['A', 'B']) {
          await openAnalysis(slot);
          await page.locator(`#bitstream-overlay-${slot}`).waitFor({state:'visible'});
          await page.waitForFunction(slot => window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({slot}).state === 'ready', slot);
          const state = await call('get_bitstream_analysis_state', {slot});
          assert.equal(state.completedStream, undefined, 'opening an overlay does not scan the whole file');
          assert.equal(state.stream, undefined, 'overlay inspection requests a picture, not a stream');
          const result = await call('request_bitstream_analysis', {slot});
          assert.equal((await call('get_bitstream_analysis_state', {slot})).cacheHit, true);
          assert.ok(result.metrics.startAu >= 90, 'rear picture starts at its verified GOP anchor');
          assert.ok(result.metrics.packets < 60, 'rear picture does not decode the whole file');
          await hideOverlay();
          const startRequests=requests.length;
          const shown=await page.evaluate(async slot=>{const start=performance.now();document.querySelector(`#bitstream-tracks [data-slot="${slot}"]`).click();await new Promise(resolve=>{const check=()=>{const c=document.getElementById(`bitstream-overlay-${slot}`);if(c&&!c.hidden&&c.getBoundingClientRect().width>0)resolve();else requestAnimationFrame(check);};requestAnimationFrame(check);});const c=document.getElementById(`bitstream-overlay-${slot}`);return {visibleAtAnimationFrameMs:performance.now()-start,metrics:c.analysisMetrics};},slot);
          rows.push({kind:'overlay-cache-display',input,slot,...shown,newRequests:requests.length-startRequests});
          console.log('overlay-cache-display',JSON.stringify(rows.at(-1)));
          await hideOverlay();
        }
        await call('seek_review', { ptsUs: 1_000_000 });
        await selectDiagrams(page, 'bitrate');
        const qpButton=page.locator('#analysis-load-metrics [data-metric="qp"]');
        await qpButton.click();
        await page.waitForFunction(()=>Number(document.querySelector('#analysis-canvas').dataset.qpPoints)>0);
        await qpButton.click({button:'right'});
        assert.equal(await page.locator('#analysis-load-metrics [data-metric="bitrate"]').getAttribute('aria-pressed'),'false');
        await qpButton.click({button:'right'});
        assert.equal(await page.locator('#analysis-load-metrics [data-metric="bitrate"]').getAttribute('aria-pressed'),'true');
        assert.deepEqual((await call('export_workspace')).layout.analysisView.loadMetrics.sort(),['bitrate','qp']);
        await qpButton.click();
        await selectDiagrams(page, 'nalu-size');
        await page.waitForFunction(async () => (await Promise.all(['A','B'].map(slot => window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot})))).every(result=>result.state==='ready' && result.stream?.pictures===120), undefined, {timeout:30000});
        // Keep automatic chart demand out of the overlay-only cache assertion.
        // A picture inspection may preempt and then resume a summary stream.
        await selectDiagrams(page, 'overview');
        for (const slot of ['A','B']) {
          await openAnalysis(slot);
          assert.equal(await page.locator('#inspector-analysis-tab').count(), 0);
          assert.equal(await page.locator('#inspector-panel #bitstream-inspector').count(), 0);
          const trackButton=page.locator(`#bitstream-tracks [data-slot="${slot}"]`);
          await page.locator(`#bitstream-overlay-${slot}`).waitFor({state:'visible'});
          await page.waitForFunction(slot=>window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot}).state!=='pending',slot);
          await page.waitForFunction(slot=>document.querySelector(`#bitstream-tracks [data-slot="${slot}"]`).dataset.state!=='pending',slot);
          assert.equal(await page.locator('#bitstream-run,#bitstream-current-state,#bitstream-block,#bitstream-time,#bitstream-visibility').count(),0,'toolbar contains controls only');
          const beforeView=await call('get_bitstream_analysis_state',{slot});
          await trackButton.click();assert.equal(await trackButton.getAttribute('aria-pressed'),'false');
          assert.equal(await page.locator(`#bitstream-overlay-${slot}`).count(),0,'turning off a track releases its overlay');
          await trackButton.click();await page.locator(`#bitstream-overlay-${slot}`).waitFor({state:'visible'});
          assert.deepEqual(await call('get_bitstream_analysis_state',{slot}),beforeView,'cached activation starts no new task');
          const pictureBox=await page.locator(`#bitstream-overlay-${slot}`).boundingBox();
          await page.locator(`#stage-${slot}`).dispatchEvent('pointermove',{clientX:pictureBox.x+pictureBox.width/2,clientY:pictureBox.y+pictureBox.height/2});
          const tooltip=page.locator('.bitstream-hit-tooltip:visible');await tooltip.waitFor({state:'visible'});
          assert.match(await tooltip.innerText(),new RegExp(`${slot}.*PTS[\\s\\S]*QP`));
          const tooltipBox=await tooltip.boundingBox(),viewportBox=await page.locator('.viewport-surface').boundingBox();
          assert.ok(tooltipBox.x>=viewportBox.x+7 && tooltipBox.x+tooltipBox.width<=viewportBox.x+viewportBox.width-7 && tooltipBox.y>=viewportBox.y+7 && tooltipBox.y+tooltipBox.height<=viewportBox.y+viewportBox.height-7,'hover details stay inside the viewport');

          for(const colorScheme of ['dark','light']) {
            await page.emulateMedia({colorScheme});
            const geometry=await page.locator('#bitstream-inspector').evaluate(host=>({font:getComputedStyle(host).fontSize,width:host.clientWidth,content:host.scrollWidth,height:host.offsetHeight}));
            assert.equal(geometry.font,'12px');assert.ok(geometry.content<=geometry.width);
            assert.ok(geometry.height<=48,'wide overlay toolbar stays on one compact row');
          }
          await hideOverlay();
        }
        assert.equal(await page.locator('.bitstream-range').count(), 0, 'the sidebar exposes no manual range-analysis workflow');
        await page.locator('#play').focus();await page.keyboard.press('n');
        await page.locator('#annotation-toolbar').waitFor({state:'visible'});
        await page.setViewportSize({width:821,height:786});
        await openAnalysis('A');
        await page.locator('#bitstream-overlay-A').waitFor({state:'visible'});
        await page.locator('#bitstream-opacity').click();
        await page.locator('#bitstream-opacity-menu [data-value="50"]').click();
        assert.equal(await page.locator('#bitstream-opacity-value').textContent(),'50%');
        await page.locator('#bitstream-opacity-value').click();
        await page.locator('#bitstream-opacity-input').fill('63'); await page.locator('#bitstream-opacity-input').press('Enter');
        assert.equal(await page.locator('#bitstream-overlay-A').evaluate(el=>el.style.opacity),'0.63','custom opacity reaches the actual overlay');
        await page.locator('#bitstream-opacity-value').click(); await page.locator('#bitstream-opacity-input').fill('90'); await page.locator('#bitstream-opacity-input').press('Escape');
        assert.equal(await page.locator('#bitstream-opacity-value').textContent(),'63%');
        assert.equal(await page.locator('#analysis-overlay-panel').isVisible(),true,'Escape in the value editor keeps the panel open');
        await page.locator('#bitstream-opacity').click(); await page.locator('#bitstream-opacity-menu [data-value="75"]').click();
        await page.setViewportSize({width:520,height:786});
        assert.equal(await page.locator('.bitstream-toolbar-title').count(),0,'overlay toolbar has no redundant heading');
        assert.equal(await page.locator('#bitstream-boundaries').textContent(),'','boundaries use only an icon');
        assert.equal(await page.locator('#bitstream-boundaries').getAttribute('aria-label'),'块边界');
        assert.ok(await page.locator('#bitstream-inspector').evaluate(el=>el.offsetHeight<=28),'compact dual-track toolbar stays on one row at 520px');
        // 窄视口下帧号列表整行换位，而不是把轨道控件挤到只剩一条缝。
        await page.waitForFunction(()=>document.querySelector('.analysis-head').classList.contains('status-stacked'));
        const headRows=await page.evaluate(()=>{const head=document.querySelector('.analysis-head'),tools=document.querySelector('.analysis-tools'),status=document.querySelector('.analysis-status');const toolRect=tools.getBoundingClientRect(),statusRect=status.getBoundingClientRect(),headRect=head.getBoundingClientRect();return {stacked:head.classList.contains('status-stacked'),separate:Math.round(statusRect.top-toolRect.bottom)>=-2,statusFullWidth:Math.abs(statusRect.width-(headRect.width-16))<=2,toolsInsideHead:toolRect.right<=headRect.right+1};});
        assert.deepEqual(headRows,{stacked:true,separate:true,statusFullWidth:true,toolsInsideHead:true},'narrow viewports give the frame numbers their own row');
        await page.setViewportSize({width:1280,height:786});
        await page.waitForFunction(()=>!document.querySelector('.analysis-head').classList.contains('status-stacked'));
        await page.setViewportSize({width:821,height:786});
        await page.waitForFunction(()=>{const popup=document.querySelector('#analysis-overlay-panel'), bar=document.querySelector('#annotation-toolbar');const a=popup.getBoundingClientRect(), b=bar.getBoundingClientRect();return a.bottom<=b.top-4 || a.top>=b.bottom+4;});
        const sharedChrome=await page.evaluate(()=>['analysis-overlay-panel','annotation-toolbar'].map(id=>{const e=document.getElementById(id),s=getComputedStyle(e);return {padding:s.padding,background:s.backgroundColor,border:s.border,borderRadius:s.borderRadius,shadow:s.boxShadow,filter:s.backdropFilter,height:e.getBoundingClientRect().height};}));
        assert.deepEqual(sharedChrome[0],sharedChrome[1],'viewport toolbars share material, inset and height');
        const closeStyle = selector => page.locator(selector).evaluate(el => { const s=getComputedStyle(el); return {color:s.color,background:s.backgroundColor}; });
        for (const colorScheme of ['dark', 'light']) {
          await page.emulateMedia({colorScheme});
          await page.locator('#remove-track-A').hover();
          await page.locator('#remove-track-A').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
          const referenceClose = await closeStyle('#remove-track-A');
          for (const selector of ['#bitstream-close', '#mark-close']) {
            await page.mouse.move(0,0);
            const idleClose = await closeStyle(selector);
            await page.locator(selector).hover();
            await page.locator(selector).evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
            assert.deepEqual(await closeStyle(selector), referenceClose, `${selector} shares the library remove action's danger hover in ${colorScheme}`);
            assert.notEqual(referenceClose.color, idleClose.color, 'hover changes the close glyph color');
            assert.notEqual(referenceClose.background, idleClose.background, 'hover changes the close background');
            if (colorScheme === 'dark') await page.locator(selector === '#bitstream-close' ? '#analysis-overlay-panel' : '#annotation-toolbar').screenshot({path:artifact(selector === '#bitstream-close' ? 'overlay-close-hover.png' : 'annotation-close-hover.png')});
          }
        }
        await page.mouse.move(0,0);
        const overlayGrip=await page.locator('#bitstream-grip').boundingBox();
        const overlayBeforeDrag=await page.locator('#analysis-overlay-panel').boundingBox();
        await page.mouse.move(overlayGrip.x+overlayGrip.width/2,overlayGrip.y+overlayGrip.height/2);await page.mouse.down();
        await page.mouse.move(overlayGrip.x+overlayGrip.width/2-20,overlayGrip.y+overlayGrip.height/2-70,{steps:8});await page.mouse.up();
        await page.waitForFunction(top=>document.querySelector('#analysis-overlay-panel').getBoundingClientRect().top<top-40,overlayBeforeDrag.y);
        const draggedPanel=await page.locator('#analysis-overlay-panel').boundingBox(),viewportBounds=await page.locator('.viewport-surface').boundingBox();
        assert.ok(draggedPanel.x>=viewportBounds.x+7 && draggedPanel.y>=viewportBounds.y+7,'overlay handle drags inside the viewport');
        const grip=await page.locator('#drawing-grip').boundingBox();
        const viewportTop=await page.locator('.viewport-surface').evaluate(e=>e.getBoundingClientRect().top);
        await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await page.mouse.down();
        await page.mouse.move(grip.x+grip.width/2,viewportTop+25,{steps:8});await page.mouse.up();
        await page.waitForFunction(()=>{const a=document.querySelector('#analysis-overlay-panel').getBoundingClientRect(),b=document.querySelector('#annotation-toolbar').getBoundingClientRect();return a.top>=b.bottom+4 && a.bottom<=document.querySelector('.transport').getBoundingClientRect().top-4;});
        await page.locator('#bitstream-close').click();
        assert.ok(await page.locator('#annotation-toolbar').isVisible(),'closing overlay controls retains the annotation peer');
        await page.keyboard.press('Escape');
        await page.locator('#annotation-toolbar').waitFor({state:'hidden'});
        for(const slot of ['A','B']) await openAnalysis(slot);
        const overlayTracks=page.locator('#bitstream-tracks');
        const overlayA=overlayTracks.locator('[data-slot="A"]'),overlayB=overlayTracks.locator('[data-slot="B"]');
        const visibility=()=>overlayTracks.locator('.bitstream-track-control').evaluateAll(buttons=>buttons.map(b=>b.getAttribute('aria-pressed')));
        await overlayA.click({button:'right'});assert.deepEqual(await visibility(),['true','false'],'right click isolates an overlay track');
        await overlayB.click({button:'right'});assert.deepEqual(await visibility(),['false','true'],'right click changes the solo track');
        await overlayB.click({button:'right'});assert.deepEqual(await visibility(),['true','true'],'repeating right click restores all overlay tracks');
        for(const expected of [['true','false'],['true','true']]) {
          await overlayA.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:9,clientX:20,clientY:20});
          await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('#bitstream-tracks .bitstream-track-control')].map(b=>b.getAttribute('aria-pressed')))===JSON.stringify(expected),expected);
          await overlayA.dispatchEvent('pointerup',{pointerType:'touch',pointerId:9});
          await overlayA.dispatchEvent('contextmenu');await overlayA.dispatchEvent('click');
          assert.deepEqual(await visibility(),expected,'touch release and native context menu apply the long press only once');
        }
        const pictureBeforeControls=await call('get_review_session');
        await page.locator('#bitstream-tracks [data-slot="A"]').click();
        assert.equal(await page.locator('#bitstream-tracks [data-slot="B"]').getAttribute('aria-pressed'),'true','A visibility does not change B');
        await page.locator('#bitstream-overlay-B').waitFor({state:'visible'});
        await page.locator('#bitstream-tracks [data-slot="A"]').click();
        await page.locator('#bitstream-overlay-A').waitFor({state:'visible'});
        await page.locator('#bitstream-opacity-value').click();
        await page.locator('#bitstream-opacity-input').fill('70');await page.keyboard.press('Enter');
        await page.waitForFunction(()=>['A','B'].every(slot=>document.querySelector(`#bitstream-overlay-${slot}`)?.style.opacity==='0.7'));
        await page.locator('#bitstream-opacity-value').click();
        await page.locator('#bitstream-opacity-input').fill('75');await page.keyboard.press('Enter');
        assert.equal((await call('get_review_session')).positionUs,pictureBeforeControls.positionUs,'overlay controls never seek');
        const requestsBeforeDisplay = requests.length;
        const readOverlay = () => page.locator('#bitstream-overlay-A').evaluate(canvas => {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let visible = 0, cyan = 0, checksum = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) {
            visible++;
            checksum += pixels[i] + pixels[i+1]*3 + pixels[i+2]*5 + pixels[i+3]*7;
            if (pixels[i + 1] > 180 && pixels[i + 2] > 180 && pixels[i] < 140) cyan++;
          }
          return { visible, cyan, checksum };
        });
        await setMode('none');
        assert.equal(await page.locator('#bitstream-boundaries').getAttribute('aria-pressed'), 'true');
        assert.ok((await readOverlay()).visible > 0, 'boundaries alone draw pixels');
        await page.locator('#bitstream-boundaries').click();
        assert.deepEqual(await readOverlay(), { visible: 0, cyan: 0, checksum: 0 }, 'no fill and no boundaries leave a transparent canvas');
        for (const fill of ['qp', 'modes']) {
          await setMode(fill);
          assert.equal(await page.locator('#bitstream-boundaries').getAttribute('aria-pressed'), 'false', 'fill selection never enables boundaries');
          const filled = await readOverlay();
          assert.ok(filled.visible > 0, `${fill} works with no boundary strokes`);
          await page.locator('#bitstream-boundaries').press('Enter');
          assert.equal(await page.locator('#bitstream-boundaries').getAttribute('aria-pressed'), 'true', 'Enter activates the focused boundary button');
          assert.equal(await page.locator(`#bitstream-mode [data-value="${fill}"]`).getAttribute('aria-pressed'), 'true');
          assert.notDeepEqual(await readOverlay(), filled, 'boundaries can be combined with either fill');
          await page.locator('#bitstream-boundaries').click();
        }
        await setMode('none');
        assert.deepEqual(await readOverlay(), { visible: 0, cyan: 0, checksum: 0 });
        const boxWithoutDrawing = await page.locator('#bitstream-overlay-A').boundingBox();
        await page.locator('#stage-A').dispatchEvent('pointermove', { clientX: boxWithoutDrawing.x + boxWithoutDrawing.width / 2, clientY: boxWithoutDrawing.y + boxWithoutDrawing.height / 2 });
        await page.locator('.bitstream-hit-tooltip:visible').waitFor();
        assert.equal(requests.length, requestsBeforeDisplay, 'display switches and hover reuse the existing block data');
        await page.locator('#bitstream-boundaries').click();
        await setMode('qp');
        for (const slot of ['A','B']) await page.locator(`#stage-${slot}`).dispatchEvent('pointerleave');
        await page.mouse.move(0, 0);
        await page.emulateMedia({ colorScheme: 'dark' });
        for (const width of [821, 520, 375, 320]) {
          await page.setViewportSize({ width, height: 786 });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.ok(await page.locator('#bitstream-inspector').evaluate(host => host.scrollWidth <= host.clientWidth), `toolbar fits ${width}px`);
          const segments = await page.locator('#bitstream-mode button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().top));
          assert.ok(Math.max(...segments) - Math.min(...segments) < 1, 'fill choices stay together on a single row');
          if (width >= 520) assert.ok(await page.locator('#bitstream-inspector').evaluate(host => host.offsetHeight <= 28), 'narrow dual-track controls stay on a single row without forced breakpoints');
          if (width === 520) await page.locator('#analysis-overlay-panel').screenshot({ path: artifact('overlay-segments-narrow.png') });
        }
        await page.setViewportSize({ width: 1280, height: 786 });
        await page.locator('#analysis-overlay-panel').screenshot({ path: artifact('overlay-segments-wide.png') });
        if (input === 'library') {
          for (const locale of ['en', 'zh-CN']) {
            await page.locator('#settings-open').click();
            await page.locator('#settings-tab-appearance').click();
            await page.locator('#language-choice').click();
            await page.locator(`#language-choice-menu [data-value="${locale}"]`).click();
            await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
            await page.locator('#settings-close').click();
            assert.equal(await page.locator('#bitstream-mode [data-value="qp"]').getAttribute('aria-pressed'), 'true', 'localization retains the selected fill');
            for (const width of [821, 520, 375, 320]) {
              await page.setViewportSize({ width, height: 786 });
              await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
              assert.ok(await page.locator('#bitstream-inspector').evaluate(host => host.scrollWidth <= host.clientWidth), `${locale} toolbar fits ${width}px`);
            }
            await page.setViewportSize({ width: 1280, height: 786 });
          }
        }
        await page.locator('#bitstream-close').click();
        await call('seek_review',{ptsUs:1100000});
        await page.waitForFunction(()=>['A','B'].every(slot=>{
          const overlay=document.querySelector(`#bitstream-overlay-${slot}`);
          const token=window.voidPlayer.tools.find(t=>t.name==='get_presented_frame').execute({slot});
          return overlay && !overlay.hidden && overlay.dataset.picture===JSON.stringify([token.picture.sourceVersion,token.picture.stream,token.picture.configuration,token.picture.au,0,0,'frame']);
        }));
        assert.ok(await page.locator('#analysis-overlay-panel').isHidden(),'both enabled track overlays follow their own current picture with controls closed');
        for(const slot of ['A','B']) {await openAnalysis(slot);assert.equal(await page.locator('#bitstream-mode [data-value="qp"]').getAttribute('aria-pressed'),'true','display type survives a missing current-frame cache and remains selected across track toggles');await hideOverlay();}
        await page.locator('#bitstream-close').click();
        await call('seek_review',{ptsUs:1000000});
        await page.setViewportSize({width:1280,height:720});
        if(overlayOnly) continue;
        assert.equal(await page.locator('.analysis-tools .analysis-chip').count(), 0, 'track controls only live beside frame numbers');
        const trackA = page.locator('#analysis-status-items .analysis-chip[data-slot="A"]');
        const trackB = page.locator('#analysis-status-items .analysis-chip[data-slot="B"]');
        const expectTracks = async slots => {
          await page.waitForFunction(slots => [...document.querySelectorAll('#analysis-status-items .analysis-chip')].every(e => e.getAttribute('aria-pressed') === String(slots.includes(e.dataset.slot))), slots);
          const state = (await call('export_workspace')).layout.analysisView;
          assert.deepEqual([...state.selected].sort(), [...slots].sort(), 'track selection and workspace state agree');
          assert.equal(await page.locator('#analysis-status .st-num').count(), 2, 'soloing a chart track retains both presented frame numbers');
        };
        await trackA.click({button:'right'}); await expectTracks(['A']);
        await trackA.click({button:'right'}); await expectTracks(['A','B']);
        await trackA.click({button:'right'}); await trackB.click({button:'right'}); await expectTracks(['B']);
        await trackB.click({button:'right'}); await expectTracks(['A','B']);
        for (const slots of [['B'],['A','B']]) {
          await page.mouse.move(0,0);
          await trackB.dispatchEvent('pointerdown', {pointerType:'touch',pointerId:41,clientX:20,clientY:20});
          await trackB.dispatchEvent('pointermove', {pointerType:'mouse',pointerId:1,clientX:1000,clientY:1000});
          await trackB.dispatchEvent('pointerleave', {pointerType:'mouse',pointerId:1});
          await expectTracks(slots);
          await trackB.dispatchEvent('pointerup', {pointerType:'touch',pointerId:41,clientX:20,clientY:20});
          await trackB.dispatchEvent('contextmenu'); await trackB.dispatchEvent('click');
          await expectTracks(slots);
        }
        await trackA.click(); await expectTracks(['B']);
        await trackA.press('Enter'); await expectTracks(['A','B']);
        const diagramButton = (mode, empty = false) => page.locator(`#${empty ? 'analysis-empty-diagrams' : 'analysis-diagrams'} [data-value="${mode}"]`);
        const expectDiagrams = async selected => {
          await page.waitForFunction(selected => [...document.querySelectorAll('.analysis-diagram-toggles button')].every(button => button.getAttribute('aria-pressed') === String(selected.includes(button.dataset.value))), selected);
          assert.deepEqual([...(await call('export_workspace')).layout.analysisView.diagrams].sort(), [...selected].sort(), 'both diagram button groups and workspace selection agree');
        };
        const original = ['bitrate','size','nalu-size'];
        await selectDiagrams(page, original);
        await diagramButton('references').click({button:'right'}); await expectDiagrams(['references']);
        await diagramButton('size').click({button:'right'}); await expectDiagrams(['size']);
        await diagramButton('size').click({button:'right'}); await expectDiagrams(original);
        await selectDiagrams(page, []);
        await diagramButton('nalu-size', true).click({button:'right'}); await expectDiagrams(['nalu-size']);
        await diagramButton('nalu-size').click({button:'right'}); await expectDiagrams([]);
        for (const [empty, selected] of [[true,['nalu-size']],[false,[]]]) {
          const button = diagramButton('nalu-size', empty);
          await page.mouse.move(0,0);
          await button.dispatchEvent('pointerdown', {pointerType:'touch',pointerId:42,clientX:20,clientY:20});
          await expectDiagrams(selected);
          await button.dispatchEvent('pointerup', {pointerType:'touch',pointerId:42,clientX:20,clientY:20});
          await button.dispatchEvent('contextmenu'); await button.dispatchEvent('click');
          await expectDiagrams(selected);
        }
        await selectDiagrams(page, ['nalu-size']);
        await diagramButton('nalu-size').click({button:'right'}); await expectDiagrams(['nalu-size']);
        await diagramButton('nalu-size').click({button:'right'}); await expectDiagrams(['nalu-size']);
        await diagramButton('size').click({button:'right'}); await expectDiagrams(['size']);
        await diagramButton('bitrate').click(); await expectDiagrams(['size','bitrate']);
        await diagramButton('references').click({button:'right'}); await expectDiagrams(['references']);
        await diagramButton('references').click({button:'right'}); await expectDiagrams(['size','bitrate']);
        await selectDiagrams(page, ['nalu-size']);
        const legend = page.locator('.bitstream-diagrams[data-slot="A"] .bitstream-diagram-legend');
        const sps = legend.getByRole('button', {name:'SPS',exact:true});
        const pps = legend.getByRole('button', {name:'PPS',exact:true});
        const expectFilter = async type => {
          await page.waitForFunction(type => [...document.querySelectorAll('.bitstream-diagrams[data-slot="A"] .bitstream-diagram-legend [data-nalu-type]')].every(e => e.getAttribute('aria-pressed') === (type == null || e.dataset.naluType === type ? 'true' : 'false')), type);
          assert.ok(await page.locator('.bitstream-diagrams[data-slot="B"] .bitstream-diagram-legend [data-filter="all"]').getAttribute('aria-pressed') === 'true', 'solo filtering stays within its track');
        };
        await sps.click({button:'right'}); await expectFilter('7');
        await sps.click({button:'right'}); await expectFilter(null);
        await sps.click({button:'right'}); await pps.click({button:'right'}); await expectFilter('8');
        await pps.click({button:'right'}); await expectFilter(null);
        for (const type of ['8',null]) {
          await pps.dispatchEvent('pointerdown', {pointerType:'touch',clientX:20,clientY:20});
          await expectFilter(type);
          await pps.dispatchEvent('pointerup', {pointerType:'touch',clientX:20,clientY:20});
          await pps.dispatchEvent('contextmenu'); await pps.dispatchEvent('click');
          await expectFilter(type);
        }
        await inspectCurrentWindow(page);
        for (const viewport of [{width:821,height:786},{width:1280,height:720}]) {
          await page.setViewportSize(viewport);
          for (const bound of ['Home','End']) {
            console.log(`${engine}: chart mount ${input}/${viewport.width}/${bound}`);
            await page.getByRole('separator', {name:'调整码流分析高度',exact:true}).press(bound);
            for (const mode of ['bitrate','size','nalu-size','nalu-types','references']) {
              for (const base of [[], ...(mode==='size' ? [['bitrate']] : []), ...(mode==='nalu-types' ? [['nalu-size']] : []), ...(mode==='references' ? [['bitrate','size','nalu-size','nalu-types']] : [])]) {
                await selectDiagrams(page, base);
                assert.ok(await page.locator('#analysis-status').isVisible(), 'frame numbers remain visible even with every diagram closed');
                if (!base.length) {
                  const emptyLayout = await page.evaluate(() => {
                    const group=document.querySelector('#analysis-empty-diagrams'), copy=document.querySelector('.analysis-no-charts p');
                    return {inEmpty:group.parentElement.classList.contains('analysis-no-charts'), below:group.getBoundingClientRect().top >= copy.getBoundingClientRect().bottom,
                      groups:document.querySelectorAll('#analysis-diagrams').length};
                  });
                  assert.ok(emptyLayout.inEmpty && emptyLayout.below && emptyLayout.groups === 1, 'empty state places synchronized diagram buttons below its prompt');
                  assert.ok(await page.locator('.analysis-head #analysis-diagrams').isVisible(), 'empty state also keeps the top-left diagram controls');
                }
                const selected = [...base,mode].sort().join(',');
                await page.evaluate(selected => {
                  window.__vpChartMount = {frames:[],done:false};
                  const activeSelection = () => [...document.querySelectorAll('#analysis-diagrams [aria-pressed="true"]')].map(e=>e.dataset.value).sort().join(',');
                  const schedule = () => requestAnimationFrame(() => {
                    // A click can arrive after this frame's callbacks but before
                    // its timer. Only sample frames that started with the new selection.
                    if (activeSelection()===selected) setTimeout(sample,0);
                    else schedule();
                  });
                  const sample = () => {
                    const active=[...document.querySelectorAll('#analysis-diagrams [aria-pressed="true"]')].map(e=>e.dataset.value).sort().join(',');
                    if (active!==selected) { schedule(); return; }
                    const charts=document.querySelector('.analysis-charts'), rect=charts.getBoundingClientRect();
                    window.__vpChartMount.frames.push({
                      selected:active,
                      rows:[...charts.children].filter(e=>!e.hidden).map(e=>({
                        y:e.getBoundingClientRect().y-rect.y,h:e.getBoundingClientRect().height,
                        legend:[...e.querySelectorAll('.bitstream-diagram-legend')].map(l=>l.textContent).join('|'),
                        canvases:[...e.querySelectorAll('canvas')].filter(c=>!c.hidden).map(c=>({h:c.getBoundingClientRect().height,plot:c.parentElement.clientHeight,overview:c.id==='analysis-canvas',rows:JSON.parse(c.dataset.rowHeights||'[]'),minimum:Math.max(36,parseFloat(getComputedStyle(charts).getPropertyValue(c.id==='analysis-canvas'?'--analysis-view-min-height':'--analysis-chart-min-plot-height')))})),
                      })), screens:document.querySelector('.screens').getBoundingClientRect().y,
                    });
                    if (window.__vpChartMount.frames.length<8) schedule();
                    else window.__vpChartMount.done=true;
                  };
                  // Observe after all animation-frame callbacks have applied their layout writes.
                  schedule();
                }, selected);
                await page.locator(`#${base.length ? 'analysis-diagrams' : 'analysis-empty-diagrams'} [data-value="${mode}"]`).click();
                assert.ok(await page.locator('.analysis-head #analysis-diagrams').isVisible(), 'opening a chart keeps the controls in the header');
                assert.equal(await page.locator(`#analysis-diagrams [data-value="${mode}"]`).evaluate(e=>e===document.activeElement), true, 'opening a chart from the empty state transfers focus to its header control');
                assert.equal(await page.locator(`#analysis-empty-diagrams [data-value="${mode}"]`).getAttribute('aria-pressed'), 'true', 'the empty-state controls share the current diagram selection');
                assert.ok(await page.locator('#analysis-status').isVisible(), `${selected}: current frame numbers stay visible in every diagram`);
                assert.equal(await page.locator('#analysis-status .st-num').count(), 2, 'each loaded track retains its current frame number');
                await page.waitForFunction(()=>window.__vpChartMount.done);
                const frames=(await page.evaluate(()=>window.__vpChartMount.frames)).filter(f=>f.selected===selected);
                assert.equal(frames.length,8,`${input}/${viewport.width}/${bound}/${selected}: activation is sampled across several painted frames`);
                const axis = await page.evaluate(() => {
                  const panel=document.querySelector('#analysis-panel').getBoundingClientRect(), charts=document.querySelector('.analysis-charts'), area=charts.getBoundingClientRect(), host=document.querySelector('.analysis-shared-axis'), fixed=host.getBoundingClientRect(), axis=document.querySelector('#analysis-shared-axis');
                  return {visible:!host.hidden,height:fixed.height,bottom:fixed.bottom,panelBottom:panel.bottom,top:fixed.top,chartsBottom:area.bottom,range:[axis.dataset.viewStart,axis.dataset.viewEnd],domain:[axis.dataset.axisStart,axis.dataset.axisEnd],right:axis.getBoundingClientRect().left+Number(axis.dataset.plotRight),
                    plots:[...document.querySelectorAll('#analysis-canvas,.bitstream-diagrams canvas')].filter(c=>!c.hidden && c.getClientRects().length).map(c=>({inline:c.dataset.timeAxis,range:[c.dataset.axisStart,c.dataset.axisEnd],right:c.getBoundingClientRect().left+Number(c.dataset.plotRight)}))};
                });
                assert.ok(axis.visible && axis.height===22 && Math.abs(axis.bottom-axis.panelBottom)<=1 && Math.abs(axis.top-axis.chartsBottom)<=1,`${selected}: chart time axis remains outside the scroll area at the panel bottom`);
                assert.ok(axis.plots.length && axis.plots.every(c=>c.inline==='false' && Math.abs(c.right-axis.right)<1 && JSON.stringify(c.range)===JSON.stringify(axis.range)),`${selected}: all plots use one fixed time axis and range`);
                assert.ok(+axis.domain[0] <= +axis.range[0] && +axis.domain[1] >= +axis.range[1], 'fixed progress bar covers the whole source and contains the visible chart window');
                // The complete plots belong to the outer scroller; the overview never clips its last row.
                const beforeAxis = axis.top;
                await page.evaluate(() => { const charts=document.querySelector('.analysis-charts'); charts.scrollTop=charts.scrollHeight; });
                await page.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
                assert.ok(Math.abs(await page.locator('.analysis-shared-axis').evaluate(e=>e.getBoundingClientRect().top)-beforeAxis)<1,'time axis stays fixed while chart rows scroll');
                const scrollGeometry=await page.evaluate(() => { const charts=document.querySelector('.analysis-charts'), body=document.querySelector('.analysis-body'); const last=[...charts.children].filter(e=>!e.hidden).at(-1); return {bottom:last.getBoundingClientRect().bottom,visibleBottom:charts.getBoundingClientRect().bottom,inner:body.scrollTop,scroll:charts.scrollTop,content:charts.scrollHeight,available:charts.clientHeight,last:last.className}; });
                assert.ok(scrollGeometry.bottom<=scrollGeometry.visibleBottom+1 && scrollGeometry.inner===0,`${selected}: outer scrolling reaches the complete bottom plot (${JSON.stringify(scrollGeometry)})`);
                await page.locator('.analysis-charts').evaluate(e=>e.scrollTop=0);
                const last=frames.at(-1), context=`${input}/${viewport.width}/${bound}/${selected}`;
                for (const frame of frames) {
                  assert.equal(frame.rows.length,last.rows.length,`${context}: chart rows appear together`);
                  assert.ok(Math.abs(frame.screens-last.screens)<1,`${context}: lower track panes do not jump`);
                  frame.rows.forEach((row,i)=>{
                    assert.ok(Math.abs(row.y-last.rows[i].y)<1 && Math.abs(row.h-last.rows[i].h)<1,`${context}: chart row settles before its first paint (${JSON.stringify(row)} -> ${JSON.stringify(last.rows[i])})`);
                    assert.equal(row.legend,last.rows[i].legend,`${context}: legend is present at first paint`);
                    assert.ok(row.canvases.every(c=>Math.abs(c.h-c.plot)<1),`${context}: canvas fills its final plot on every painted frame`);
                    for (const c of row.canvases.filter(c=>c.overview)) {
                      assert.ok(c.rows.length && c.rows.every(h=>h>=c.minimum-1),`${context}: bitrate and size each retain a full plot height`);
                      assert.ok(Math.max(...c.rows)-Math.min(...c.rows)<=1,`${context}: bitrate and size grow equally`);
                    }
                  });
                }
              }
            }
          }
        }
      }

      // The same controls over three real decoded videos in both UI themes.
      // Contrast/alpha assertions complement saved screenshots; they do not infer
      // universal contrast compliance from one static frame.
      if (await page.locator('#analysis-panel').isVisible()) await page.locator('#toggle-analysis').click();
      for (const slot of ['A','B']) await call('remove_review_track', {slot});
      await page.setViewportSize({width:1280,height:900});
      const controlStyle = selector => page.locator(selector).evaluate(el => {
        const s=getComputedStyle(el),probe=document.createElement('canvas'); probe.width=probe.height=1;
        const ctx=probe.getContext('2d');ctx.fillStyle=s.backgroundColor;ctx.fillRect(0,0,1,1);
        return {background:s.backgroundColor,color:s.color,shadow:s.boxShadow,alpha:ctx.getImageData(0,0,1,1).data[3]/255,filter:s.backdropFilter || s.webkitBackdropFilter};
      });
      const settleControl = selector => page.locator(selector).evaluate(el => Promise.all(el.getAnimations().map(a=>a.finished)));
      for (const [background, file] of [['bright','glass-bright.mp4'],['dark','glass-dark.mp4'],['complex','stream.mp4']]) {
        await call('load_library_item', {slot:'A',id:library.entries.find(entry=>entry.name===file).id}); await stable();
        // Cover the chrome as well as the picture center: fitted letterboxing
        // would otherwise test the toolbar against the theme instead of video.
        await page.evaluate(() => window.voidPlayer.setViewport({zoom:1.5}));
        await openAnalysis('A');
        await page.locator('#bitstream-overlay-A').waitFor({state:'visible'});
        await hideOverlay();
        await setMode('none');
        if (await page.locator('#bitstream-boundaries').getAttribute('aria-pressed') === 'true') await page.locator('#bitstream-boundaries').click();
        if (await page.locator('#toggle-annotations').getAttribute('aria-expanded') !== 'true') await page.locator('#toggle-annotations').click();
        for (const colorScheme of ['dark','light']) {
          await page.emulateMedia({colorScheme});
          const before=await call('get_presented_frame',{slot:'A'});
          let hoverReference;
          for(const selector of ['#copy-path-A','#fullscreen','#toggle-chrome','[data-drawing-tool="eraser"]','#bitstream-boundaries','#settings-open']) {
            await page.mouse.move(0,0);await settleControl(selector);
            await page.locator(selector).hover();await settleControl(selector);
            const hovered=await controlStyle(selector);
            assert.ok(hovered.alpha>=.14 && hovered.alpha<.20, `${selector} retains transparent hover over ${background}/${colorScheme}: ${JSON.stringify(hovered)}`);
            assert.equal(hovered.filter,'none','buttons never add a second backdrop filter');
            if (hoverReference) {
              assert.equal(hovered.background,hoverReference.background, 'all glass buttons share one neutral hover');
              assert.equal(hovered.shadow,hoverReference.shadow,'all glass buttons share borderless hover');
            } else hoverReference=hovered;
            await page.mouse.down();await settleControl(selector);
            const pressed=await controlStyle(selector);
            assert.ok(pressed.alpha>hovered.alpha && pressed.alpha<.3, `${selector} press over ${background}/${colorScheme}: ${JSON.stringify({hovered,pressed})}`);
            await page.mouse.move(0,0);await page.mouse.up();
          }
          await page.locator('#bitstream-opacity').hover();await settleControl('#bitstream-opacity-control');
          assert.equal((await controlStyle('#bitstream-opacity-control')).background,hoverReference.background,'numeric controls highlight their whole wrapper');
          assert.equal((await controlStyle('#bitstream-opacity')).alpha,0,'numeric child buttons stay transparent');
          await page.locator('[data-drawing-tool="pen"]').hover();await settleControl('[data-drawing-tool="pen"]');
          const selected=await controlStyle('[data-drawing-tool="pen"]');
          assert.ok(selected.alpha<.35 && selected.color!==hoverReference.color,'selected tools retain an accent tint while hovered');
          for(const selector of ['#bitstream-close','#mark-close','#remove-track-A']) {
            await page.locator(selector).hover();await settleControl(selector);
            const danger=await controlStyle(selector);
            assert.ok(danger.alpha>0 && danger.alpha<.23,'danger hover remains a thin red layer');
            assert.notEqual(danger.color,hoverReference.color);
            await page.mouse.down();await settleControl(selector);
            const pressed=await controlStyle(selector);
            assert.equal(pressed.color,danger.color,'holding a close action retains its red glyph');
            assert.ok(pressed.alpha>danger.alpha && pressed.alpha<.35,'danger press remains translucent');
            await page.mouse.move(0,0);await page.mouse.up();
          }
          await page.locator('#copy-path-A').hover();await settleControl('#copy-path-A');
          await page.screenshot({path:artifact(`glass-${background}-${colorScheme}-copy.png`)});
          await page.locator('[data-drawing-tool="eraser"]').hover();await settleControl('[data-drawing-tool="eraser"]');
          await page.screenshot({path:artifact(`glass-${background}-${colorScheme}-tools.png`)});
          const bar=await page.locator('#annotation-toolbar').boundingBox();
          const clip={x:Math.max(0,Math.floor(bar.x)-8),y:Math.max(0,Math.floor(bar.y)-24),width:Math.ceil(bar.width)+16,height:Math.min(Math.ceil(bar.height)+100,900-Math.max(0,Math.floor(bar.y)-24))};
          await page.screenshot({path:artifact(`glass-${background}-${colorScheme}-detail.png`),clip});
          assert.deepEqual(await call('get_presented_frame',{slot:'A'}),before,'hover/press feedback never changes the presented media frame');
          rows.push({kind:'glass-controls',background,colorScheme,hover:hoverReference});
        }
      }
      const paused=await call('get_presented_frame',{slot:'A'});
      await page.evaluate(() => window.voidPlayer.play());
      await page.locator('#copy-path-A').hover();
      await page.waitForFunction(commit => window.voidPlayer.tools.find(t=>t.name==='get_presented_frame').execute({slot:'A'}).commit>commit,paused.commit);
      await page.locator('#copy-path-A').hover();await settleControl('#copy-path-A');
      const movingHover=await controlStyle('#copy-path-A');
      assert.ok(movingHover.alpha>=.14 && movingHover.alpha<.20,`complex moving video retains the same transparent hover: ${JSON.stringify(movingHover)}`);
      await page.evaluate(() => window.voidPlayer.pause());
      await page.emulateMedia({contrast:'more'});
      await page.locator('#copy-path-A').hover();await settleControl('#copy-path-A');
      assert.equal((await controlStyle('#copy-path-A')).alpha,1,'increased contrast restores opaque feedback');
      await page.emulateMedia({contrast:'no-preference'});
      await page.mouse.move(0,0);

      assert.deepEqual(errors,[]);

      await page.screenshot({path:artifact('stable-chart-mount.png')});

      await writeFile(artifact('overlay-cache-timings.json'),JSON.stringify(rows,null,2));

      console.log(overlayOnly ? `PASS ${engine}: local/library dual-track overlay toolbar, shared opacity, hover details, peer avoidance and closed-toolbar frame updates` : `PASS ${engine}: five chart toggles, paired/all views, local/library dual tracks, fixed time axis during scrolling, minimum/maximum panel heights and narrow/wide first-paint stability`);

      return;
}
