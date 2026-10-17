import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { selectDiagrams, openRangeEditor, inspectCurrentWindow } from '../controls.mjs';


export async function run(context) {
const { page, artifact, engine, limitsDir, errors, call, stable, library, referenceFixtures, gate } = context;

      await page.setViewportSize({width:1280,height:720});

      for (const input of ['local-file','library']) {
        if ((await call('get_review_session')).tracks.length) await call('remove_review_track',{slot:'A'});
        if (input==='local-file') await page.locator('#file-A').setInputFiles(path.join(limitsDir,'incremental.mp4'));
        else await call('load_library_item',{slot:'A',id:library.entries.find(e=>e.name==='incremental.mp4').id});
        await stable(); await selectDiagrams(page,'overview');
        const zoomIn=page.locator('#analysis-zoom-in'),zoomOut=page.locator('#analysis-zoom-out'),full=page.locator('[data-seg="full"]');
        assert.equal(await zoomIn.locator('svg').count(),1);assert.equal(await zoomOut.locator('svg').count(),1);assert.equal(await full.locator('svg').count(),1);
        assert.equal(await page.locator('#analysis-current').count(),0);
        for (const [button,label] of [[zoomIn,'放大'],[full,'全时段']]) {
          await button.hover(); await page.waitForFunction(text=>{const e=document.querySelector('#control-tooltip');return !e.hidden&&e.textContent===text;},label);
        }
        assert.equal(await page.locator('.analysis-range-navigation').isVisible(),false,'range navigator is not permanently displayed');
        assert.equal(await page.locator('#analysis-panel .analysis-range-navigation').count(),0,'editor consumes no chart space');
        await call('seek_review',{ptsUs:2_500_000});
        const beforeZoom=await page.locator('#analysis-shared-axis').evaluate(c=>({start:+c.dataset.viewStart,end:+c.dataset.viewEnd}));
        const beforePosition=(await call('get_review_session')).positionUs;
        await zoomIn.click();
        await zoomOut.hover(); await page.waitForFunction(()=>{const e=document.querySelector('#control-tooltip');return !e.hidden&&e.textContent==='缩小';});
        await page.waitForFunction(span=>{const d=document.querySelector('#analysis-shared-axis').dataset;return Math.abs(+d.viewEnd-+d.viewStart-span/2)<=2;},beforeZoom.end-beforeZoom.start);
        const zoomed=await page.locator('#analysis-shared-axis').evaluate(c=>({start:+c.dataset.viewStart,end:+c.dataset.viewEnd}));
        const originalFraction=(beforePosition-beforeZoom.start)/(beforeZoom.end-beforeZoom.start);
        assert.ok(Math.abs((beforePosition-zoomed.start)/(zoomed.end-zoomed.start)-originalFraction)<.001,'zoom in keeps an in-range playhead at its relative chart position');
        await zoomOut.click();
        await page.waitForFunction(span=>{const d=document.querySelector('#analysis-shared-axis').dataset;return Math.abs(+d.viewEnd-+d.viewStart-span)<=2||(d.viewStart===d.domainStart&&d.viewEnd===d.domainEnd);},beforeZoom.end-beforeZoom.start);
        await full.click();
        assert.equal((await call('get_review_session')).positionUs,beforePosition,'zoom and full-duration buttons never seek');
        await openRangeEditor(page);
        const start=page.locator('.analysis-window-handle.start'),end=page.locator('.analysis-window-handle.end');
        await page.waitForFunction(()=>+document.querySelector('.analysis-window-handle.start').getAttribute('aria-valuenow')===0);
        await end.press('Home'); for(let i=0;i<4;i++)await end.press('ArrowRight');
        await page.waitForFunction(()=>+document.querySelector('.analysis-window-handle.end').getAttribute('aria-valuenow')===410_000);
        await page.waitForFunction(()=>{
          const chart=document.querySelector('#analysis-canvas').dataset,axis=document.querySelector('#analysis-shared-axis').dataset;
          return chart.axisStart===axis.axisStart&&chart.axisEnd===axis.axisEnd;
        });
        const navigation=page.locator('#analysis-range-axis'),bounds=await navigation.boundingBox();
        const domain=await navigation.evaluate(e=>({start:+e.dataset.domainStart,end:+e.dataset.domainEnd}));
        const target=7_000_000,x=bounds.x+10+(target-domain.start)/(domain.end-domain.start)*(bounds.width-20);
        const view=(await call('export_workspace')).layout.analysisView.view;
        await page.mouse.click(x,bounds.y+3);
        await page.waitForFunction(t=>Math.abs(window.voidPlayer.getState().positionUs-t)<100_000,target);
        assert.deepEqual((await call('export_workspace')).layout.analysisView.view,view,'rail seek keeps the chart viewport');
        assert.equal(await page.locator('.analysis-range-playhead').isVisible(),true,'current position remains visible outside the zoomed range');
        const position=(await call('get_review_session')).positionUs;
        const beforeOutsideZoom=(await call('export_workspace')).layout.analysisView.view;
        await zoomIn.click();
        await page.waitForFunction(span=>{const d=document.querySelector('#analysis-shared-axis').dataset;return Math.abs(+d.viewEnd-+d.viewStart-span/2)<=2;},beforeOutsideZoom.end-beforeOutsideZoom.start);
        const outsideZoom=(await call('export_workspace')).layout.analysisView.view;
        assert.ok(Math.abs(outsideZoom.start+outsideZoom.end-beforeOutsideZoom.start-beforeOutsideZoom.end)<=2,'zoom uses the viewport centre when the playhead is outside');
        await zoomOut.click();
        await page.waitForFunction(span=>{const d=document.querySelector('#analysis-shared-axis').dataset;return Math.abs(+d.viewEnd-+d.viewStart-span)<=2;},beforeOutsideZoom.end-beforeOutsideZoom.start);
        await openRangeEditor(page);
        const band=page.locator('.analysis-window-band'),box=await band.boundingBox();
        assert.ok(box.width<64,'fixture exercises a narrow window');
        assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.classList.contains('analysis-window-band'),{x:box.x+box.width/2,y:box.y+1}),true,'narrow window centre belongs to pan, not an edge handle');
        await page.mouse.move(box.x+box.width/2,box.y+1);await page.mouse.down();
        await page.mouse.move(box.x+box.width/2+20,box.y+1,{steps:5});await page.mouse.up();
        await page.waitForFunction(s=>+document.querySelector('#analysis-shared-axis').dataset.axisStart!==s,view.start);
        assert.equal((await call('get_review_session')).positionUs,position,'window pan does not seek');
        const moved=(await call('export_workspace')).layout.analysisView.view;
        assert.equal(moved.end-moved.start,view.end-view.start,'window pan preserves zoom');
        await start.hover();assert.equal(await page.locator('#analysis-window-preview').count(),0,'range navigation has no hover time bubble');
        assert.equal(await page.locator('.analysis-range-time').count(),4,'range times include a separate hover readout');
        assert.equal(await navigation.getAttribute('data-time-axis'),'false','range rail has no absolute tick labels');
        assert.equal(await start.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
        await start.press('ArrowRight');
        await page.waitForFunction(s=>+document.querySelector('.analysis-window-handle.start').getAttribute('aria-valuenow')>s,moved.start);
        assert.equal((await call('get_review_session')).positionUs,position,'edge resize does not seek');
        assert.equal(await page.locator('#analysis-range-time-start .analysis-range-time-text').textContent(),await start.getAttribute('aria-valuetext'),'dragged range and editable time stay synchronized');
        await call('seek_review',{ptsUs:+await start.getAttribute('aria-valuenow')});
        for(const width of [360,1280]) {
          await page.setViewportSize({width,height:720});
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          await openRangeEditor(page);
          const railBox=await navigation.boundingBox();
          await page.mouse.move(railBox.x+10+(railBox.width-20)*.5,railBox.y+3);
          assert.equal(await page.locator('.analysis-range-hover').isVisible(),true,'hover adds a separate triangle on the rail');
          assert.equal(await page.locator('#analysis-range-time-hover').isVisible(),true,'hover time appears below the rail');
          const fills=await page.locator('.analysis-range-time.current, .analysis-range-time.hover').evaluateAll(es=>es.map(e=>getComputedStyle(e).backgroundColor));
          assert.notEqual(fills[0],fills[1],'current and hover times have different emphasis');
          const times=await page.locator('.analysis-range-time').evaluateAll(es=>es.filter(e=>!e.hidden).map(e=>({text:e.textContent,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})).sort((a,b)=>a.left-b.left));
          assert.equal(times.length,4,'start, current, end and hover readouts all stay mounted');
          assert.ok(times.every(e=>e.left>=0&&e.right<=width),`permanent range times stay on screen at ${width}px`);
          for(let i=1;i<times.length;i++) assert.ok(times[i].left>=times[i-1].right+6||times[i].top>=times[i-1].bottom||times[i-1].top>=times[i].bottom,'coincident start/current and close end times do not overlap');
          assert.equal(await page.locator('#analysis-range-time-start').textContent(),await start.getAttribute('aria-valuetext'));
        }
        const editorBounds=await page.locator('#analysis-range-editor').boundingBox();
        assert.ok(editorBounds.x>=0&&editorBounds.x+editorBounds.width<=1280,'popover stays inside the viewport');
        const anchoring=await page.evaluate(()=>{const e=document.querySelector('#analysis-range-editor').getBoundingClientRect(),t=document.querySelector('#analysis-range-trigger').getBoundingClientRect();return {dx:Math.abs((e.left+e.width/2)-(t.left+t.width/2)),gap:e.top-t.bottom};});
        assert.ok(anchoring.dx<=1&&anchoring.gap>=4&&anchoring.gap<=10,'range editor stays centered under its trigger');
        const materials=await page.evaluate(()=>['analysis-range-editor','annotation-toolbar'].map(id=>{const s=getComputedStyle(document.getElementById(id));return {background:s.backgroundColor,filter:s.backdropFilter||s.webkitBackdropFilter,border:s.border,borderRadius:s.borderRadius};}));
        assert.deepEqual(materials[0],materials[1],'range editor shares the annotation toolbar glass backplane');
        // 编辑两个端点各自提交，先从全时段开始，两个方向都有合法空间。
        await full.click();
        await openRangeEditor(page);
        // 点击起止胶囊直接编辑：编辑框必须精确覆盖原文字盒，胶囊本身不动。
        const pillBefore=await page.locator('#analysis-range-time-start').boundingBox();
        await page.locator('#analysis-range-time-start').click();
        const startInput=page.locator('#analysis-range-input-start');
        await startInput.waitFor({state:'visible'});
        assert.equal(await page.locator('#analysis-range-time-start').getAttribute('data-editing'),'true','editing switches the capsule to its wireframe state');
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('#analysis-range-time-start')).backgroundColor==='rgba(0, 0, 0, 0)');
        const editingStyle=await page.locator('#analysis-range-time-start').evaluate(e=>{const s=getComputedStyle(e);return {border:s.borderTopColor,text:s.color};});
        assert.notEqual(editingStyle.border,'rgba(0, 0, 0, 0)','wireframe editing keeps an accent outline');
        assert.equal(editingStyle.text,editingStyle.border,'wireframe text and outline share the accent');
        const pillAfter=await page.locator('#analysis-range-time-start').boundingBox();
        assert.deepEqual({x:pillAfter.x,y:pillAfter.y,width:pillAfter.width,height:pillAfter.height},{x:pillBefore.x,y:pillBefore.y,width:pillBefore.width,height:pillBefore.height},'editing never moves or resizes the time capsule');
        const timeOverlay=await page.evaluate(()=>{const text=document.querySelector('#analysis-range-time-start .analysis-range-time-text').getBoundingClientRect(),input=document.querySelector('#analysis-range-input-start').getBoundingClientRect();return [input.left-text.left,input.top-text.top,input.width-text.width,input.height-text.height].map(value=>Math.abs(value));});
        assert.ok(timeOverlay.every(delta=>delta<.5),'time input exactly overlays the capsule text box');
        const seekBeforeEdit=(await call('get_review_session')).positionUs;
        await startInput.fill('00:02.000');
        await page.locator('#analysis-range-time-end').click();
        const endInput=page.locator('#analysis-range-input-end');
        await endInput.fill('00:01.000');
        await call('seek_review',{ptsUs:seekBeforeEdit});
        assert.equal(await startInput.inputValue(),'00:02.000','frame updates preserve the draft after focus moves to the other field');
        await endInput.press('Enter');
        assert.equal(await page.locator('.analysis-range-error').isVisible(),true,'reversed range stays open with an inline error');
        await endInput.fill('00:04.000');
        await endInput.press('Enter');
        await page.waitForFunction(()=>document.querySelector('#analysis-range-trigger span').textContent.includes('00:04.000'));
        assert.deepEqual((await call('export_workspace')).layout.analysisView.view,{start:2_000_000,end:4_000_000});
        assert.equal((await call('get_review_session')).positionUs,seekBeforeEdit,'editing chart range does not seek');
        assert.equal(await page.locator('#analysis-range-editor').evaluate(e=>e.matches(':popover-open')),true,'committing a time keeps the editor open for the next edit');
        assert.match(await page.locator('#analysis-range-trigger').innerText(),/00:02.000.*00:04.000/);
        await page.screenshot({path:artifact(`navigation-${input}.png`)});
        await page.locator('#analysis-range-editor').screenshot({path:artifact(`range-editor-${input}.png`)});
        await page.locator('#analysis-range-time-end').press('Escape');
        await page.waitForFunction(()=>document.querySelector('#analysis-range-trigger').getAttribute('aria-expanded')==='false');
        assert.equal(await page.locator('#analysis-range-trigger').evaluate(e=>e===document.activeElement),true,'Escape closes editor and restores trigger focus');
        await openRangeEditor(page);
        const hoveredPosition=(await call('get_review_session')).positionUs;
        await page.mouse.move(1,1);
        assert.equal(await page.locator('.analysis-range-hover').isHidden(),true,'leaving the rail removes the hover triangle');
        assert.equal(await page.locator('#analysis-range-time-hover').isHidden(),true,'leaving the rail removes only the hover time');
        assert.equal((await call('get_review_session')).positionUs,hoveredPosition,'hover does not seek');
        // Cached viewport work must not make the completed track pill pulse.
        // 先把窗口平移到片头，再逐端编辑成缓存命中区间（不触发整片重扫）。
        await band.press('Home');
        await page.locator('#analysis-range-time-end').click();
        await page.locator('#analysis-range-input-end').fill('00:00.574');
        await page.locator('#analysis-range-input-end').press('Enter');
        await page.locator('#analysis-range-time-start').click();
        await page.locator('#analysis-range-input-start').fill('00:00.264');
        await page.locator('#analysis-range-input-start').press('Enter');
        await page.waitForFunction(()=>document.querySelector('#analysis-range-trigger span').textContent.includes('00:00.264'));
        await selectDiagrams(page,['bitrate','size','nalu-size']);
        await page.waitForFunction(()=>window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot:'A'}).state==='ready');
        const progressAction=page.locator('.analysis-track-control[data-slot="A"] .analysis-progress-action');
        await page.waitForFunction(()=>document.querySelector('.analysis-progress-action').getBoundingClientRect().width===0);
        await page.evaluate(()=>{
          window.__progressWidths=[];window.__sampleProgress=true;
          const sample=()=>{window.__progressWidths.push(document.querySelector('.analysis-progress-action').getBoundingClientRect().width);if(window.__sampleProgress)requestAnimationFrame(sample);};sample();
        });
        await zoomIn.click();await zoomOut.click();
        await openRangeEditor(page);
        await start.press('ArrowRight');
        await band.press('ArrowRight');await band.press('ArrowLeft');
        await selectDiagrams(page,['bitrate','size','references']);await selectDiagrams(page,['bitrate','size','nalu-size']);
        await page.setViewportSize({width:1200,height:720});
        await call('seek_review',{ptsUs:350000});
        await page.waitForTimeout(350);
        const widths=await page.evaluate(()=>{window.__sampleProgress=false;return window.__progressWidths;});
        assert.ok(widths.every(w=>w<.5),'cached zoom, range resize/pan, diagrams, viewport resize and seek never expand the progress action');
        // Hold real task preparation long enough to see expansion, then verify
        // completion contracts through intermediate widths, retaining the node.
        let release;const gate=new Promise(resolve=>{release=resolve;});
        const pattern=input==='local-file'?'**/vendor/voidplayer-analysis/manifest.json*':'**/bitstream-analysis/capabilities*';
        await page.route(pattern,async route=>{await gate;await route.continue().catch(()=>{});});
        const requested=page.waitForRequest(pattern);
        try {
          await page.evaluate(()=>{void window.voidPlayer.tools.find(t=>t.name==='request_bitstream_stream').execute({slot:'A',product:'summary',window:{startUs:0,endUs:500000,axis:'pts'}}).catch(()=>{});});
          await requested;
          await page.waitForFunction(()=>document.querySelector('.analysis-progress-action').getBoundingClientRect().width>25);
          await progressAction.evaluate(e=>{window.__retainedProgressAction=e;});
          const shrinking=page.evaluate(()=>new Promise(resolve=>{
            const widths=[];const sample=()=>{const e=document.querySelector('.analysis-progress-action'),w=e.getBoundingClientRect().width;widths.push(w);if(w===0)resolve({widths,retained:e===window.__retainedProgressAction});else requestAnimationFrame(sample);};sample();
          }));
          release();
          const completion=await shrinking;
          assert.equal(completion.retained,true,'completion retains the animated action node');
          assert.ok(completion.widths.some(w=>w>0&&w<25),'completion shrinks smoothly through intermediate widths');
          assert.equal(await progressAction.isVisible(),false,'completed progress action is hidden after its animation');
        } finally {release();await page.unroute(pattern);}
      }

      for (const name of referenceFixtures) for (const input of ['local-file','library']) {
        await call('remove_review_track',{slot:'A'});
        if (input==='local-file') await page.locator('#file-A').setInputFiles(path.join(limitsDir,name));
        else await call('load_library_item',{slot:'A',id:library.entries.find(e=>e.name===name).id});
        await stable();await selectDiagrams(page,['bitrate','size','references']);
        await page.locator('#analysis-resize').press('End');
        await page.locator('[data-seg="full"]').click();
        await call('request_bitstream_stream',{slot:'A',product:'summary'});
        const chart=await call('query_bitstream_chart',{slot:'A',pixelWidth:4096});
        if (chart.aggregated) {
          // The public chart API deliberately buckets views above 256 frames.
          // Read bounded windows to inspect every retained reference record.
          for(let start=chart.domain.start;start<chart.domain.end;start+=2_000_000) {
            const part=await call('query_bitstream_chart',{slot:'A',startUs:start,endUs:Math.min(chart.domain.end,start+2_000_000),pixelWidth:4096});
            chart.pictures.push(...part.pictures);
          }
        }
        assert.ok(chart.pictures.length>60,'reference regression uses real decoded frame summaries');
        assert.ok(chart.pictures.every(p=>p.nalus.filter(n=>n.type<=31).every(n=>n.temporalId===0)),'fixture has no signaled HEVC temporal sublayers');
        assert.ok(chart.pictures.some(p=>p.referenceLayer?.level>=2),'hierarchical B references remain separated despite all-zero Temporal IDs');
        assert.ok(chart.pictures.every(p=>p.referenceLayer?.source==='inferred'),'inferred hierarchy is never presented as a signaled temporal layer');
        const referenceCanvas=page.locator('#bitstream-diagram-references');
        await page.waitForFunction(()=>+document.querySelector('#bitstream-diagram-references').dataset.maxLayer>=2);
        await call('seek_review',{ptsUs:name==='user-reference.mp4'?14_033_333:1_500_000});
        await inspectCurrentWindow(page);
        const axis=await page.locator('#analysis-shared-axis').evaluate(e=>({start:+e.dataset.viewStart,end:+e.dataset.viewEnd}));
        const zoomed=await call('query_bitstream_chart',{slot:'A',startUs:axis.start,endUs:axis.end,pixelWidth:4096});
        const levels=new Map(chart.pictures.map(p=>[p.picture.au,p.referenceLayer]));
        assert.ok(zoomed.pictures.length>0);
        for(const p of zoomed.pictures)assert.deepEqual(p.referenceLayer,levels.get(p.picture.au),'zoom retains levels computed with off-screen anchors');
        await page.waitForFunction(()=>+document.querySelector('#bitstream-diagram-references').dataset.maxLayer>=2);
        assert.equal(await referenceCanvas.getAttribute('data-layer-source'),'inferred');
        await page.waitForFunction(()=>document.querySelector('#bitstream-diagram-references').clientHeight>=60);
        await writeFile(artifact(`reference-layers-${name}-${input}.json`),JSON.stringify({frames:chart.pictures.length,levels:[...new Set(chart.pictures.map(p=>p.referenceLayer?.level))],zoom:zoomed.pictures.map(p=>({au:p.picture.au,layer:p.referenceLayer,refs:p.references}))},null,2));
        await page.locator('#analysis-panel').screenshot({path:artifact(`reference-layers-${name}-${input}.png`)});
      }

      assert.deepEqual(errors,[]);
console.log(`PASS ${engine}: local/library range navigation, tooltips, progress transitions and all-zero-TID HEVC reference hierarchy`);
return;
}
