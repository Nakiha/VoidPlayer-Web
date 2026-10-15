import { beginPlaybackTrace } from '../../playback-trace.mjs';
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { withBrowserFixture } from "../../browser-fixture.mjs";
import { selectAnalysisMatrixRows } from "../../analysis-matrix.mjs";
import { repositoryRoot } from "../../manifest.mjs";
import { assertBenchmarkCorrectness, verifyPlaybackPresentation } from "../../playback-presentation.mjs";

async function selectDiagrams(page, choice) {
  if (!await page.locator('#analysis-panel').isVisible()) await page.locator('#toggle-analysis').click();
  const selected = Array.isArray(choice) ? choice : choice === 'overview' ? ['bitrate', 'size'] : [choice];
  for (const value of ['bitrate', 'size', 'nalu-size', 'nalu-types', 'references']) {
    const item = page.locator(`#analysis-diagrams [data-value="${value}"]`);
    if ((await item.getAttribute('aria-pressed') === 'true') !== selected.includes(value)) await item.click();
  }
  // Direct toggles no longer wait for a popup to close. Let the chart layout
  // and its ResizeObserver render settle before measuring pointer targets.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// Backend lifecycle cases remain explicit through the same session facade.
async function requestInspection(page, slot) {
  await page.evaluate(slot => { void window.voidPlayer.tools.find(t => t.name === 'request_bitstream_stream').execute({slot}).catch(() => {}); }, slot);
}

const matrix = JSON.parse(
  await readFile(
    path.join(repositoryRoot, "scripts/bitstream-analysis-matrix.json"),
    "utf8",
  ),
);
const engine = process.argv[2] ?? "webkit";
const overlayOnly = process.argv.includes('--overlay-only');
const layoutOnly = overlayOnly || process.argv.includes('--layout-only');
const diagramsOnly = process.argv.includes('--diagrams-only');
const incrementalOnly = process.argv.includes('--incremental-only');
const matrixOnly = process.argv.includes('--matrix-only');
const desktopPerformance=process.argv.includes('--desktop-performance');
const matrixPart = process.argv.find(arg => arg.startsWith('--matrix-part='))?.slice('--matrix-part='.length);
const matrixFixture = process.argv.find(arg => arg.startsWith('--matrix-fixture='))?.slice('--matrix-fixture='.length);
const matrixRows = selectAnalysisMatrixRows(matrix.rows, process.argv).filter(row => !matrixFixture || row.fixture === matrixFixture);
assert.ok(matrixRows.length, 'Matrix filter matches a fixture');
assert.ok(!matrixPart || matrixOnly, 'Matrix partition requires --matrix-only');
assert.ok(!desktopPerformance || engine==='chromium' && matrixOnly && matrixPart==='ts', 'Desktop performance is an explicit Chromium TS matrix check');
const matrixCase = `bitstream-analysis-matrix${matrixPart ? '-' + matrixPart : ''}`;
assert.ok([layoutOnly, diagramsOnly, incrementalOnly, matrixOnly].filter(Boolean).length <= 1, 'Choose only one analysis case mode');
let gatedId, releaseIndexGate = true, heldBatches = 0;
const indexGateWaiters=new Set();
const releaseGate=()=>{releaseIndexGate=true;for(const resolve of indexGateWaiters)resolve();indexGateWaiters.clear();};
const limitsDir = path.join(
  repositoryRoot,
  ".run",
  "analysis-limit-fixtures",
  layoutOnly ? `${engine}-layout` : matrixOnly ? `${engine}-matrix${matrixPart ? '-' + matrixPart : ''}` : diagramsOnly ? `${engine}-diagrams` : incrementalOnly ? `${engine}-index` : engine,
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
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'testsrc2=size=128x64:rate=30:duration=4', '-an', '-c:v', 'libx264', '-g', '30', '-bf', '2',
  '-x264-params', 'scenecut=0:open-gop=0', path.join(limitsDir, 'stream.mp4')]);
await copyFile(path.join(limitsDir, 'stream.mp4'), path.join(limitsDir, 'stream-2.mp4'));
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'testsrc2=size=128x64:rate=30:duration=10', '-an', '-c:v', 'libx264', '-g', '30', '-bf', '2',
  '-x264-params', 'scenecut=0:open-gop=0', path.join(limitsDir, 'incremental.mp4')]);
// MP4 descriptions now use a complete sample-table adapter. FLV retains
// asynchronous playback indexing and an independent append-only analysis cursor.
for(const name of ['stream.mp4','incremental.mp4','stream-2.mp4'])await copyFile(path.join(limitsDir,name),path.join(limitsDir,'queue-'+name));
for(const action of ['continue','cancel'])execFileSync('ffmpeg',['-y','-v','error','-i',path.join(limitsDir,'incremental.mp4'),'-an','-c:v','copy','-f','flv',path.join(limitsDir,`incremental-${action}.flv`)]);
await withBrowserFixture(
  {
    caseName: layoutOnly ? 'bitstream-analysis-layout' : matrixOnly ? matrixCase+(desktopPerformance?'-desktop':'') : diagramsOnly ? 'bitstream-analysis-diagrams' : incrementalOnly ? "bitstream-analysis-index" : "bitstream-analysis",
    roots: [path.join(repositoryRoot, "fixtures/video"), path.join(repositoryRoot, "fixtures/flv-analysis"), path.join(repositoryRoot, "fixtures/fmp4-analysis"), path.join(repositoryRoot, "fixtures/ts-analysis"), limitsDir],
    engine,
    ...(desktopPerformance?{launchOptions:{headless:false}}:{}),
    pageOptions: { deviceScaleFactor: 2 },
    timeoutMs: layoutOnly ? 300000 : 600000,
    dependencies: { async startService({ temp, roots, defer }) {
      const { MediaLibraryIndex } = await import('../../../../server/library.ts');
      const { createMediaServer } = await import('../../../../server/app.ts');
      const library = new MediaLibraryIndex(roots, { database: path.join(temp, 'library.sqlite'), watch: false });
      const call=library.indexJobs.call.bind(library.indexJobs),startBuild=library.indexJobs.startBuild.bind(library.indexJobs);
      library.indexJobs.startBuild=(request,options={})=>{
        const held=()=>request.id===gatedId&&!releaseIndexGate;
        const handle=startBuild(request,{...options,onProgress(progress){options.onProgress?.(held()?{...progress,packets:Math.min(progress.packets,128)}:progress);}});
        // A joining subscriber must receive the held validated frontier even
        // if the tiny fixture scan finished before it attached.
        void handle.promise.then(()=>{if(held())options.onProgress?.({phase:'scan',packets:128,scannedBytes:request.size,totalBytes:request.size});}).catch(()=>{});
        return handle;
      };
      library.indexJobs.call=async(op,data={},...args)=>{
        if(data.id===gatedId&&op==='get'&&!releaseIndexGate){heldBatches++;await new Promise(resolve=>indexGateWaiters.add(resolve));}
        const result=await call(op,data,...args);
        if(data.id===gatedId&&op==='stream-manifest'&&!releaseIndexGate&&result?.manifest){heldBatches++;return {...result,manifest:{...result.manifest,complete:false}};}
        return result;
      };
      const server = createMediaServer({ roots, library, staticDir: path.join(repositoryRoot, 'dist'), onLog() {} });
      let closed = false;
      const close = async () => {
        if (closed) return; closed = true;releaseGate();
        try { server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { await library.close(); }
      };
      defer('partial-server', close); library.start();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      return { server, close, url: `http://127.0.0.1:${server.address().port}/` };
    } },
  },
  async ({ page, ready, artifact }) => {
    const errors = [],
      requests = [],
      rows = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) =>
      requests.push({ url: request.url(), method: request.method(), ...(request.method()==='POST' && /bitstream-analysis\/requests/.test(request.url()) ? {target:request.postDataJSON()?.target} : {}) }),
    );
    await page.addInitScript(() => { window.__vpAnalysisQA = true; });
    await ready();
    page.setDefaultTimeout(30000);
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
    let overlaySlot='A';
    const openAnalysis=async(slot='A')=>{overlaySlot=slot;if(!await page.locator('#analysis-overlay-panel').isVisible())await page.locator('#toggle-analysis-overlay').click();const button=page.locator(`#bitstream-tracks [data-slot="${slot}"]`);if(await button.getAttribute('aria-pressed')!=='true')await button.click();};
    const analyze=openAnalysis;
    const hideOverlay=async()=>{const button=page.locator(`#bitstream-tracks [data-slot="${overlaySlot}"]`);if(await button.getAttribute('aria-pressed')==='true')await button.click();};
    const setMode = async mode => {
      await page.locator('#bitstream-mode').click();
      await page.locator(`#bitstream-mode-menu [data-value="${mode}"]`).click();
    };
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
    if (layoutOnly) {
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
        assert.equal(await page.locator(`#bitstream-overlay-${overlaySlot}`).evaluate(el=>el.style.opacity),'0.63','custom opacity reaches the actual overlay');
        await page.locator('#bitstream-opacity-value').click(); await page.locator('#bitstream-opacity-input').fill('90'); await page.locator('#bitstream-opacity-input').press('Escape');
        assert.equal(await page.locator('#bitstream-opacity-value').textContent(),'63%');
        assert.equal(await page.locator('#analysis-overlay-panel').isVisible(),true,'Escape in the value editor keeps the panel open');
        await page.locator('#bitstream-opacity').click(); await page.locator('#bitstream-opacity-menu [data-value="75"]').click();
        await page.setViewportSize({width:520,height:786});
        assert.equal(await page.locator('.bitstream-toolbar-title').isVisible(),false,'the title is the first content hidden on narrower viewports');
        assert.ok(await page.locator('#bitstream-inspector').evaluate(el=>el.offsetHeight<=28),'compact controls delay toolbar wrapping');
        await page.setViewportSize({width:821,height:786});
        await page.waitForFunction(()=>{const popup=document.querySelector('#analysis-overlay-panel'), bar=document.querySelector('#annotation-toolbar');const a=popup.getBoundingClientRect(), b=bar.getBoundingClientRect();return a.bottom<=b.top-4 || a.top>=b.bottom+4;});
        const sharedChrome=await page.evaluate(()=>['analysis-overlay-panel','annotation-toolbar'].map(id=>{const e=document.getElementById(id),s=getComputedStyle(e);return {padding:s.padding,background:s.backgroundColor,border:s.border,borderRadius:s.borderRadius,shadow:s.boxShadow,filter:s.backdropFilter,height:e.getBoundingClientRect().height};}));
        assert.deepEqual(sharedChrome[0],sharedChrome[1],'viewport toolbars share material, inset and height');
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
        await setMode('qp');
        await page.locator('#bitstream-close').click();
        await call('seek_review',{ptsUs:1100000});
        await page.waitForFunction(()=>['A','B'].every(slot=>{
          const overlay=document.querySelector(`#bitstream-overlay-${slot}`);
          const token=window.voidPlayer.tools.find(t=>t.name==='get_presented_frame').execute({slot});
          return overlay && !overlay.hidden && overlay.dataset.picture===JSON.stringify([token.picture.sourceVersion,token.picture.stream,token.picture.configuration,token.picture.au,0,0,'frame']);
        }));
        assert.ok(await page.locator('#analysis-overlay-panel').isHidden(),'both enabled track overlays follow their own current picture with controls closed');
        for(const slot of ['A','B']) {await openAnalysis(slot);assert.match(await page.locator('#bitstream-mode').innerText(),/QP/,'display type survives a missing current-frame cache and remains selected across track toggles');await hideOverlay();}
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
        await page.locator('#analysis-current').click();
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
                assert.ok(axis.visible && axis.height===22 && Math.abs(axis.bottom-axis.panelBottom)<=1 && Math.abs(axis.top-axis.chartsBottom)<=1,`${selected}: time axis remains outside the scroll area at the panel bottom`);
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
      assert.deepEqual(errors,[]);
      await page.screenshot({path:artifact('stable-chart-mount.png')});
      await writeFile(artifact('overlay-cache-timings.json'),JSON.stringify(rows,null,2));
      console.log(overlayOnly ? `PASS ${engine}: local/library dual-track overlay toolbar, shared opacity, hover details, peer avoidance and closed-toolbar frame updates` : `PASS ${engine}: five chart toggles, paired/all views, local/library dual tracks, fixed time axis during scrolling, minimum/maximum panel heights and narrow/wide first-paint stability`);
      return;
    }
    if (!incrementalOnly) {
    if (!diagramsOnly) {
    for (const input of (process.argv.includes('--checkpoint-only') ? ["local-file"] : ["local-file", "library"]))
      for (const decoding of (process.argv.includes('--checkpoint-only') ? ["software"] : ["browser", "software"]))
        for (const row of matrixRows) {
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
                path.join(repositoryRoot, "fixtures", row.fixtureDir ?? "video", row.fixture),
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
          assert.equal(await page.locator('#inspector-analysis-tab').count(),0,'left inspector contains only source information');
          if (input === 'local-file' && decoding === 'browser' && row.codec === 'h264' && row.container === 'mp4') {
            await page.locator('#toggle-analysis').click();
            await selectDiagrams(page, 'nalu-size');
            await page.waitForFunction(() => {
              const state = window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot:'A'});
              return state.state === 'ready' && state.stream?.pictures > 0;
            }, undefined, {timeout:60000});
            assert.equal((await call('get_bitstream_analysis_state', {slot:'A'})).reason, undefined, 'automatic viewport produces real output without errors');
            await page.locator('.bitstream-diagrams canvas').first().waitFor({state:'visible'});
            await selectDiagrams(page, 'references');
            await page.waitForFunction(() => window.voidPlayer.tools.find(t=>t.name==='get_bitstream_analysis_state').execute({slot:'A'}).state!=='pending', undefined, {timeout:60000});
            assert.notEqual((await call('get_bitstream_analysis_state')).state,'pending','automatic analysis reaches a terminal state before the next inspection');
            assert.equal(await page.locator('.analysis-picture-overlay').count(), 0);
            await selectDiagrams(page, 'overview');
            await page.locator('#toggle-analysis').click();
          }
          if (row.container === 'flv' || row.container === 'ts') {
            const prefixToken = await call('get_presented_frame', { slot: 'A' });
            const capability = (await call('get_analysis_capabilities'))[0].capability;
            if (capability.indexState === 'building') assert.equal(prefixToken.picture, null, 'growing FLV index cannot promise global PTS uniqueness');
            // An explicit indexed seek starts the shared metadata job. Analysis
            // payloads still use their own reader and no playback decoder.
            await call('seek_review', { ptsUs: 1000000 });
            await page.waitForFunction(() => window.voidPlayer.tools.find(t => t.name === 'get_analysis_capabilities').execute({})[0]?.capability.indexState === 'complete');
            await call('seek_review', { ptsUs: 0 }); await stable();
          }
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
            row.codec === "h264" && row.container === "mp4"
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
              await analyze();
              await requested;
              await call("step_review", { direction: 1 });
              release();
              const cold = page.locator("#bitstream-overlay-A");
              await cold.waitFor({ state: "attached" });
              if (await cold.isVisible()) {
                const current = await call('get_presented_frame', {slot:'A'});
                assert.equal(await cold.getAttribute('data-picture'), JSON.stringify([
                  current.picture.sourceVersion,current.picture.stream,current.picture.configuration,current.picture.au,0,0,'frame',
                ]), 'lazy activation paints only the current picture, including automatic replacement analysis');
              }
            } finally {
              release();
              await page.unroute(pattern);
            }
            await hideOverlay();
            await call("seek_review", { ptsUs: 0 });
          }
          await analyze();
          const overlay = page.locator("#bitstream-overlay-A");
          await overlay.waitFor({ state: "visible" });
          assert.equal(await page.locator('#bitstream-tracks [data-slot="A"]').getAttribute('aria-pressed'),'true');
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
            await setMode(mode);
            assert.ok(await overlay.isVisible());
            if (
              input === "local-file" &&
              decoding === "browser" &&
              row.codec === "h264" && row.container === "mp4" &&
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
          const tooltip = page.locator(".viewport-surface .bitstream-hit-tooltip");
          await tooltip.waitFor({ state: "visible" });
          assert.match(
            await tooltip.innerText(),
            /QP/,
            "block hit information remains visible after UI tooltip migration",
          );
          const beforePick = await call('get_presented_frame', { slot: 'A' });
          await page.evaluate(({ x, y }) => document.getElementById('stage-A').dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true })), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
          assert.equal(await page.locator('#bitstream-block').count(),0,'block clicks never introduce pinned details');
          assert.deepEqual(await call('get_presented_frame', { slot: 'A' }), beforePick, 'selecting a block never seeks');
          await call("step_review", { direction: 1 });
          // Enabled overlays may automatically fill missing frame details; they never seek.
          assert.equal((await call('get_presented_frame',{slot:'A'})).sourcePtsUs, (await call('get_review_session')).tracks[0].frame.sourcePtsUs);
          assert.ok(await tooltip.isHidden(),'frame changes hide the hovered old block');
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
          if (input === 'local-file' && decoding === 'browser' && row.codec === 'h264' && row.container === 'mp4') {
            const next = await call('get_presented_frame', { slot: 'A' });
            await analyze();
            try { await overlay.waitFor({ state: 'visible' }); }
            catch (error) { console.error('Next-picture overlay state:', await call('get_bitstream_analysis_state', { slot: 'A' })); throw error; }
            assert.equal(await overlay.getAttribute('data-picture'), JSON.stringify([next.picture.sourceVersion, next.picture.stream, next.picture.configuration, next.picture.au, 0, 0, 'frame']), 'next frame can be analyzed directly without toggling visibility');
          }
          await call("seek_review", { ptsUs: 0 });
          await overlay.waitFor({ state: "visible" });
          await hideOverlay();
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
          const beforeCachedRange = requests.length;
          const cachedRange = await call('request_bitstream_range', { slot: 'A', startUs: 10000, endUs: 50000 });
          assert.ok(cachedRange.pictures >= 2, 'overlapping range enumerates its own pictures');
          if (input === 'local-file') assert.ok(!requests.slice(beforeCachedRange).some(r => /voidplayer-analysis\.(js|wasm)/.test(r.url)),
            'a completely cached local range reads metadata without loading analysis WASM');
          if (decoding === "browser" && row.codec === "h264" && row.container === "mp4") {
            await call("request_bitstream_range", {
              slot: "A",
              startUs: 0,
              endUs: 120000,
            });
            await call("seek_review", { ptsUs: 0 });
            await analyze();
            await overlay.waitFor({ state: "visible" });
            await setMode("qp");
            const beforeSustained = await page.evaluate(() => ({...document.getElementById('bitstream-overlay-A').analysisMetrics}));
            let playingWallMs = 0;
            for (let i = 0; i < 20; i++) {
              await call('seek_review', {ptsUs:0});
              const proof = await verifyPlaybackPresentation(page, { minPlayingMs:60 }, {engine,caseName:'sustained-cache',targetPtsUs:0});
              playingWallMs += proof.playingMs;
            }
            const afterSustained = await page.evaluate(() => ({...document.getElementById('bitstream-overlay-A').analysisMetrics}));
            const sustained = { playingWallMs,
              presentations:afterSustained.presentations-beforeSustained.presentations,
              hits:afterSustained.cacheHits-beforeSustained.cacheHits,
              draws:afterSustained.draws-beforeSustained.draws,
              resizes:afterSustained.resizes-beforeSustained.resizes };
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
            await hideOverlay();
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
          if (row.container === 'fmp4' || row.container === 'ts') {
            await call('seek_review', { ptsUs: row.container === 'ts' ? 8_700_000 : 350000 }); await stable();
            const rearToken = await call('get_presented_frame', { slot: 'A' });
            const rearResult = await call('request_bitstream_analysis', { slot: 'A' });
            assert.deepEqual(rearResult.picture, rearToken.picture, 'nonkey fragment seek preserves actual presented AU');
            assert.equal(rearResult.sourcePtsUs, rearToken.sourcePtsUs);
            await analyze(); await overlay.waitFor({ state: 'visible' });
            assert.equal(await overlay.getAttribute('data-picture'), JSON.stringify([rearToken.picture.sourceVersion, rearToken.picture.stream, 0, rearToken.picture.au, 0, 0, 'frame']));
            await hideOverlay();
            const crossing = await call('request_bitstream_range', { slot: 'A', startUs: 280000, endUs: 480000 });
            assert.ok(crossing.pictures >= 10, 'real interval crosses a nonkey fragment');
            const decoder = (await call('get_review_session')).tracks[0].decoder;
            if (row.codec === 'vvc' || decoding === 'software') assert.equal(decoder, 'ffmpeg-wasm', 'actual software packet path');
            await call('seek_review', { ptsUs: 0 });
          }
          if (row.container === 'ts') await page.evaluate(beginPlaybackTrace);
          let profileSession, profile;
          if (row.container === 'ts' && process.argv.includes('--playback-profile')) {
            assert.equal(engine,'chromium','CPU profiler is an explicit Chromium diagnostic');
            profileSession=await page.context().newCDPSession(page);
            await profileSession.send('Profiler.enable');await profileSession.send('Profiler.start');
          }
          let report, readiness, benchmarkError;
          const diagnosticErrors=[];
          try { report = await call("benchmark_review", { durationMs: 2000 }); }
          catch(error) {benchmarkError=error;}
          finally {
            if (row.container === 'ts') try {readiness = await page.evaluate(()=>window.__finishPlaybackTrace());}
            catch(error){diagnosticErrors.push({phase:'trace-finish',error:String(error)});}
            if (profileSession) {
              try {profile=(await profileSession.send('Profiler.stop')).profile;}catch(error){diagnosticErrors.push({phase:'profile-stop',error:String(error)});}
              finally {try {await profileSession.detach();}catch(error){diagnosticErrors.push({phase:'profile-detach',error:String(error)});}}
            }
          }

          // Persist each row before asserting: a no-presentation report has no
          // track measurements and must produce a useful failure, not a TypeError.
          const playbackEvidence = { engine, input, decoding, fixture: row.fixture, report, diagnosticErrors, ...(benchmarkError ? {benchmarkError:String(benchmarkError)} : {}), ...(readiness ? {readiness} : {}) };
          const drawn = report?.measurements.tracks.A?.drawn ?? 0;
          if (benchmarkError || report.error !== null || report.staleAfterPause || drawn === 0) {
            try {playbackEvidence.state = await call('get_review_session');}catch(error){diagnosticErrors.push({phase:'state',error:String(error)});}
            try {playbackEvidence.logs = await call('get_review_logs', { level: 'debug', limit: 2000 });}catch(error){diagnosticErrors.push({phase:'logs',error:String(error)});}
          }
          let artifactError;
          try {
            await writeFile(artifact(`playback-${input}-${decoding}-${row.codec}.json`), JSON.stringify(playbackEvidence, null, 2));
            if (profile) await writeFile(artifact(`playback-cpu-${input}-${decoding}-${row.codec}.json`),JSON.stringify(profile));
          }catch(error){artifactError=error;}
          if (benchmarkError) throw benchmarkError;
          if (artifactError) throw artifactError;
          const playbackRow = {
            codec: row.codec,
            input,
            decoding,
            decoder: (await call("get_review_session")).tracks[0].decoder,
            token,
            metrics: result.metrics,
            range,
            playback: report,
            functionalPresentation: { status: 'waiting' },
          };
          rows.push(playbackRow);
          // Preserve the original fixed-window sample even if the independent
          // functional proof fails. Never replace it with the longer wait.
          await writeFile(artifact('matrix.json'), JSON.stringify({ engine, rows, errors }, null, 2));
          try {
            assert.equal(report.error, null);
            assert.equal(report.staleAfterPause, false);
            assertBenchmarkCorrectness(report);
            await call('seek_review', { ptsUs: 0 });
            playbackRow.functionalPresentation = { status: 'passed', ...await verifyPlaybackPresentation(page, {}, { engine, caseName: `${row.container}-${row.codec}-${input}-${decoding}`, targetPtsUs: 0 }) };
            await writeFile(artifact('matrix.json'), JSON.stringify({ engine, rows, errors }, null, 2));
          } catch (error) {
            playbackRow.functionalPresentation = { status: 'failed', error: error.message };
            await writeFile(artifact('matrix.json'), JSON.stringify({ engine, rows, errors }, null, 2));
            throw error;
          }
        }
    // A response for a frame superseded during the request must never become visible.
    await hideOverlay();
    // Select from the actual final fixture: unpartitioned and fixture-filtered
    // runs also cache the fMP4 280–480 ms cross-fragment interval.
    const lifecyclePtsUs = matrixRows.at(-1)?.container === 'ts' ? 4_700_000 : matrixRows.at(-1)?.container === 'fmp4' ? 800000 : 400000;
    await call("seek_review", { ptsUs: lifecyclePtsUs });
    await page.evaluate(() => { void window.voidPlayer.tools.find(t=>t.name==='request_bitstream_analysis').execute({slot:'A'}).catch(()=>{}); });
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
    await hideOverlay();
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

    }
    if (matrixOnly) {
      const built = JSON.parse(await readFile(path.join(repositoryRoot, 'dist/build-info.json'), 'utf8'));
      const coreRequests = requests.map(request => new URL(request.url)).filter(url => url.pathname.startsWith('/vendor/') && /\.(js|wasm|json)$/.test(url.pathname));
      assert.ok(coreRequests.some(url => /voidplayer-core.*\.wasm$/.test(url.pathname)), 'playback Worker fetches a real core');
      assert.ok(coreRequests.some(url => url.pathname.endsWith('/voidplayer-analysis.wasm')), 'analysis Worker fetches a real core');
      for (const url of coreRequests) assert.equal(url.searchParams.get('v'), built.coreAssetDigests[url.pathname], `main/Worker core version: ${url.pathname}`);
      assert.equal(rows.filter(row => row.codec).length, process.argv.includes('--checkpoint-only') ? matrixRows.length : matrixRows.reduce((count, row) => count + row.inputs.length * 2, 0), 'every admitted codec/input/playback preference is checked');
      assert.deepEqual(errors, []);
      await writeFile(artifact('matrix.json'), JSON.stringify({ engine, rows, errors }, null, 2));
      await page.screenshot({ path: artifact('final.png') });
      console.log(`PASS ${engine}: isolated codec/overlay matrix, cache, range, sustained load and cancellation`);
      return;
    }
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
            const event = new WheelEvent('wheel', { ...args, clientX: rect.left + 46 + (rect.width - 46) * .3,
              clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true });
            c.dispatchEvent(event); return event.defaultPrevented;
          }, { deltaY, ctrlKey, deltaMode });
          assert.equal(prevented, true, 'chart owns the gesture instead of browser page zoom');
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
        };
        const gesture = async (type, scale) => {
          const prevented = await chart.evaluate((c, args) => {
            const rect = c.getBoundingClientRect(), event = new Event(args.type, { bubbles: true, cancelable: true });
            Object.assign(event, { scale: args.scale, clientX: rect.left + 46 + (rect.width - 46) * .3 });
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
          await page.mouse.move(rect.x + 46 + (rect.width - 46) * .5, rect.y + rect.height / 2);
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

    if (!incrementalOnly) {
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
    }

    if (!incrementalOnly) {
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

    if (!incrementalOnly) for (const input of ['local-file', 'library']) {
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
      const whole = await call('query_bitstream_chart', { slot: 'A' });
      assert.equal(whole.count, 300); assert.equal(whole.aggregated, true); assert.equal(whole.pictures.length, 0);
      assert.ok(whole.buckets.length <= 258); assert.equal(whole.buckets.reduce((sum, b) => sum + b.pictures, 0), 300);
      for (const diagram of ['nalu-size', 'nalu-types', 'references']) {
        await selectDiagrams(page, diagram);
        const chart = page.locator('.bitstream-diagrams canvas');
        await page.waitForFunction(mode => { const c = document.querySelector('.bitstream-diagrams canvas'); return c.dataset.diagram === mode && +c.dataset.totalPictures === 300 && c.dataset.aggregated === 'true'; }, diagram);
        assert.ok(+await chart.getAttribute('data-axis-start') < 0, 'full range leaves space before the first frame'); assert.equal(+await chart.getAttribute('data-axis-end'), 10_000_000);
        assert.equal(await page.locator('.bitstream-diagram-navigation [data-page]').count(), 0);
        await chart.evaluate(c => { const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -280 * Math.log(4), clientX: r.left + 46 + (r.width - 46) / 2, bubbles: true, cancelable: true })); });
        await page.waitForFunction(() => { const c = document.querySelector('.bitstream-diagrams canvas'); return c.dataset.aggregated === 'false' && +c.dataset.pictures > 60 && +c.dataset.pictures <= 80; });
        const local = await chart.evaluate(c => window.voidPlayer.tools.find(t => t.name === 'query_bitstream_chart').execute({ slot: 'A', startUs: +c.dataset.axisStart, endUs: +c.dataset.axisEnd }));
        assert.ok(local.pictures.every(p => p.sourcePtsUs >= local.startUs && p.sourcePtsUs < local.endUs));
        if (input === 'library') await page.screenshot({ path: artifact(`whole-chart-${diagram}-zoomed.png`) });
        await page.locator('[data-seg="full"]').click();
        await page.waitForFunction(() => document.querySelector('.bitstream-diagrams canvas').dataset.aggregated === 'true');
        if (input === 'library') await page.screenshot({ path: artifact(`whole-chart-${diagram}.png`) });
        assert.deepEqual(await page.evaluate(() => ({ positionUs: window.voidPlayer.getState().positionUs, playing: window.voidPlayer.getState().playing })), playback, 'whole-film overview and detail zoom never seek');
      }
      assert.ok(requests.slice(requestsBefore).filter(r => r.method === 'POST' && /bitstream-analysis\/requests/.test(r.url)).every(r => r.target?.mode==='stream' && r.target.window), 'viewport navigation only requests visible GOPs');
      await page.locator('#analysis-current').click();
      await page.waitForFunction(() => { const c = document.querySelector('.bitstream-diagrams canvas'); return c.dataset.aggregated === 'false' && +c.dataset.axisEnd - +c.dataset.axisStart === 1_000_000; });
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
      await page.locator('#analysis-current').click();
      await page.waitForFunction(() => +document.querySelector('.bitstream-diagrams canvas').dataset.axisEnd - +document.querySelector('.bitstream-diagrams canvas').dataset.axisStart === 1_000_000);
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
          const d = c.dataset, span = +d.axisEnd-+d.axisStart, plot = c.clientWidth-46;
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
        const lineX = hoverBounds.x + 46 + (hoverBounds.width - 46) * fraction;
        await page.mouse.move(lineX, hoverBounds.y + hoverBounds.height / 2);
        await page.locator('.analysis-view-card[data-diagram="references"]').waitFor({ state: 'visible' });
        const cards = page.locator('.analysis-view-card:visible');
        assert.equal(await cards.count(), 3, 'overview and paired NALU rows each share one card; references have their own');
        assert.equal(await page.locator('.analysis-linked-card:visible').count(), 0);
        const boxes = await cards.evaluateAll(elements => elements.map(element => {
          const r = element.getBoundingClientRect();
          const graph = document.querySelector(element.dataset.diagram === 'overview' ? '#analysis-canvas' : element.dataset.diagram === 'nalu' ? '#bitstream-diagram-nalu-size' : '#bitstream-diagram-references');
          const owner = graph.getBoundingClientRect(), range = graph.dataset;
          const lineX = owner.left + 46 + (+(range.hoverCursorTime || range.hoverTime) - +range.axisStart) / (+range.axisEnd - +range.axisStart) * (owner.width - 46);
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
        const x = bounds.x + 46 + (bounds.width - 46) * .5;
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
        await page.mouse.move(x + (bounds.width - 46) * .2, y);
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
        const y = rect.y + rect.height / 2, tolerance = (axis.end - axis.start) / (rect.width - 46) + 2;
        // Start outside the cards: teleporting onto a previous scrollable tooltip
        // would exercise tooltip scrolling instead of this chart's pointer input.
        await page.mouse.move(4, 4);
        await page.mouse.move(rect.x + 46 + (rect.width - 46) * .3, y);
        await page.waitForFunction(({ id, time, tolerance }) => {
          const c = document.getElementById(id); return !!c.dataset.hoverAu && Math.abs(+c.dataset.hoverCursorTime - time) < tolerance;
        }, { id:`bitstream-diagram-${mode}`, time:axis.start + (axis.end - axis.start) * .3, tolerance });
        const hit = await target.evaluate(c => ({ time:+c.dataset.hoverTime, au:c.dataset.hoverAu }));
        const hitX = rect.x + 46 + (hit.time - axis.start) / (axis.end - axis.start) * (rect.width - 46);
        const snapshots = [];
        for (const dx of [2, 6]) {
          const x = hitX + dx;
          // Traverse continuously: a teleport beyond the card gap can land
          // directly on its scrollable surface instead of the chart below it.
          await page.mouse.move(x, y, { steps: 8 });
          const expectedCursor = axis.start + (x - rect.x - 46) / (rect.width - 46) * (axis.end - axis.start);
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
        await page.mouse.move(rect.x + 46 + (rect.width - 46) * .3, rect.y + rect.height / 2);
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
        await page.mouse.move(rect.x + 46 + (rect.width - 46) * .35, rect.y + rect.height / 2);
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
        const firstMediaFraction = Math.max(.01, -visibleAxis.start / (visibleAxis.end-visibleAxis.start) + 2/(anchor.width-46));
        for (const fraction of [firstMediaFraction, .99]) {
          await page.mouse.move(anchor.x + 46 + (anchor.width - 46) * fraction, anchor.y + anchor.height / 2);
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
        const event = new WheelEvent('wheel', { ctrlKey: true, deltaY: -280 * Math.log(2), clientX: r.left + 46 + (r.width - 46) / 2, bubbles: true, cancelable: true });
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
      multiple.layout.analysisView.view = axisZoom;
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
      const visibleTop = Math.max(scrollBox.y, visibleCharts.y), visibleBottom = Math.min(scrollBox.y + scrollBox.height, visibleCharts.y + visibleCharts.height);
      await page.mouse.move(scrollBox.x + scrollBox.width / 2, (visibleTop + visibleBottom) / 2);
      await page.mouse.wheel(0, 160);
      await page.waitForFunction(before => document.querySelector('.analysis-charts').scrollTop > before, startScroll);
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

    if (!incrementalOnly) {
      // Multi-track deep charts retain independent identities, filters and card ownership.
      await call('load_library_item', { slot: 'B', id: library.entries.find(e => e.name === 'stream.mp4').id });
      await stable(); await call('request_bitstream_stream', { slot:'B' });
      await call('set_review_track_offset', { slot:'B', offsetUs:100_000 });
      await call('seek_review', { ptsUs:500_000 });
      await selectDiagrams(page, ['size','nalu-size','nalu-types','references']);
      await page.locator('#analysis-current').click();
      await page.waitForFunction(() => {
        const charts=[...document.querySelectorAll('.bitstream-diagrams canvas')], shared=document.querySelector('#analysis-shared-axis').dataset;
        return charts.length===6 && +shared.viewStart<500_000 && +shared.viewEnd>500_000 && charts.every(c=>c.dataset.aggregated==='false' && c.dataset.axisStart===shared.viewStart && c.dataset.axisEnd===shared.viewEnd);
      });
      assert.equal(await page.locator('.bitstream-nalu-group').count(),2);
      assert.equal(await page.locator('#analysis-layout').isVisible(),true);
      assert.match(await page.locator('#analysis-layout').innerText(),/码流/);
      const target=page.locator('.bitstream-diagrams[data-slot="B"][data-diagram="references"] canvas');
      const geometry=await target.evaluate(c=>({r:c.getBoundingClientRect().toJSON(),left:+c.dataset.plotLeft,right:+c.dataset.plotRight,start:+c.dataset.axisStart,end:+c.dataset.axisEnd}));
      await target.scrollIntoViewIfNeeded();
      const r=await target.boundingBox();
      const x=r.x+geometry.left+(500_000-geometry.start)/(geometry.end-geometry.start)*(geometry.right-geometry.left);
      await page.mouse.move(x,r.y+r.height/2);
      await page.locator('.analysis-linked-card').waitFor({state:'visible'});
      const ownAus=await page.locator('.bitstream-diagrams canvas').evaluateAll(cs=>cs.map(c=>({slot:c.dataset.slot,mode:c.dataset.diagram,au:+c.dataset.hoverAu,cursor:+c.dataset.hoverCursorTime})));
      assert.ok(ownAus.every(c=>Math.abs(c.cursor-500_000)<2000),JSON.stringify(ownAus));
      for (const slot of ['A','B']) assert.equal(new Set(ownAus.filter(c=>c.slot===slot).map(c=>c.au)).size,1,'all diagrams of one track highlight the same AU');
      assert.notEqual(ownAus.find(c=>c.slot==='A').au,ownAus.find(c=>c.slot==='B').au,'offset tracks resolve their own AU');
      const rows=page.locator('.analysis-linked-card .analysis-track-details');
      assert.equal(await rows.count(),2);
      const referenceAppearance=card=>{
        const table=card.querySelector('[data-kind="references"]');
        return {
          layout:getComputedStyle(table.querySelector('tbody')).display,
          l0:getComputedStyle(table.querySelector('[data-list="0"] th')).color,
          l1:getComputedStyle(table.querySelector('[data-list="1"] th')).color,
          weight:getComputedStyle(table.querySelector('[data-list="0"] td')).fontWeight,
          layer:getComputedStyle(table.querySelector('.analysis-card-depth')).backgroundColor,
        };
      };
      const combinedAppearance=await rows.first().evaluate(referenceAppearance);
      assert.equal(combinedAppearance.layout,'grid','embedded reference details retain the compact shared layout');
      assert.notEqual(combinedAppearance.l0,combinedAppearance.l1,'reference list colors remain distinct in the combined card');
      assert.equal(combinedAppearance.weight,'600');
      assert.equal(await page.locator('.analysis-linked-card > .fl-time').count(),0,'combined card has no shared pointer timestamp');
      for (const slot of ['A','B']) {
        const owned=page.locator(`.analysis-linked-card .analysis-track-details[data-slot="${slot}"]`);
        const time=owned.locator('.analysis-card-track-time');
        assert.match(await time.innerText(),/^\d{2}:\d{2}\.\d{3} · PTS$/,'each track heading carries its matched frame timestamp');
        const hitTime=+(await time.getAttribute('data-hit-time'));
        const trackTime=+(await page.locator(`.bitstream-diagrams[data-slot="${slot}"][data-diagram="references"] canvas`).getAttribute('data-hover-time'));
        assert.equal(hitTime,trackTime,'heading time follows the track match, not the pointer');
        assert.equal(await owned.locator('.analysis-card-section').count(),3);
        assert.match(await owned.locator('[data-diagram="nalu-size"] .analysis-card-frame').innerText(),new RegExp('#'+(ownAus.find(c=>c.slot===slot).au+1)+'(?:\\D|$)'));
        assert.equal(await owned.locator('thead').count(),0,'one row heading identifies all scalar sections');
      }
      await page.screenshot({path:artifact('multitrack-combined.png')});
      await page.keyboard.press('Escape');
      await page.locator('#analysis-diagrams [data-value="size"]').click();
      assert.equal(await page.locator('#analysis-layout').isVisible(),false,'deep charts never expose a merge control');
      await target.press('ArrowRight');
      for (const slot of ['A','B']) assert.match(await page.locator(`.analysis-linked-card .analysis-track-details[data-slot="${slot}"] .analysis-card-track-time`).innerText(),/^\d{2}:\d{2}\.\d{3} · PTS$/,'deep-only panels resolve timestamps without the overview query');
      const legendA=page.locator('.bitstream-diagrams[data-slot="A"][data-diagram="nalu-size"] [data-nalu-type="1"]');
      if (await legendA.count()) {
        await legendA.click();
        assert.equal(await page.locator('.bitstream-diagrams[data-slot="B"][data-diagram="nalu-size"] [data-nalu-type="1"]').getAttribute('aria-pressed'),'true','NAL filters do not leak between tracks');
      }
      // Four independent views fit at maximum height in a tall viewport.
      // Adding both type plots requires scrolling, which hides offscreen cards.
      const cardViewport = page.viewportSize();
      await page.setViewportSize({ ...cardViewport, height: Math.max(800, cardViewport.height) });
      await page.getByRole('separator', { name: '调整码流分析高度', exact: true }).press('End');
      await selectDiagrams(page, ['nalu-size', 'references']);
      await page.waitForFunction(() => { const charts=document.querySelector('.analysis-charts'); return charts.scrollHeight<=charts.clientHeight+1; });
      await page.locator('#settings-open').click(); await page.locator('#settings-tab-appearance').click();
      await page.locator('#chart-hover-style').click(); await page.locator('#chart-hover-style-menu [data-value="separate"]').click(); await page.locator('#settings-close').click();
      // Hidden can precede the queued close event, whose handler returns focus
      // to the invoker. Wait for that handler before focusing the chart, or its
      // later blur can clear the keyboard hover cards we are about to inspect.
      await page.waitForFunction(() => {
        const settings = document.querySelector('#settings');
        return !settings.open && !settings.hasAttribute('data-closing') && document.querySelector('#settings-open').getAttribute('aria-expanded') === 'false';
      });
      await target.focus();
      await target.press('ArrowRight');
      await page.waitForFunction(()=>document.querySelectorAll('.analysis-view-card:not([hidden])').length===4);
      assert.equal(await page.locator('.analysis-view-card:visible').count(),4,'one NALU and one reference card per selected track');
      assert.equal(await page.locator('.analysis-view-card:visible[data-slot="A"]').count(),2);
      assert.equal(await page.locator('.analysis-view-card:visible[data-slot="B"]').count(),2);
      assert.deepEqual(await page.locator('.analysis-view-card:visible[data-slot="B"][data-diagram="references"]').evaluate(referenceAppearance),combinedAppearance,'independent and combined reference bodies share styling');
      const cardBounds=await page.locator('.analysis-view-card:visible').evaluateAll(cards=>cards.map(card=>{
        const owner=card.dataset.diagram==='nalu'
          ? document.querySelector(`.bitstream-nalu-group[data-slot="${card.dataset.slot}"]`) ?? document.querySelector(`.bitstream-diagrams[data-slot="${card.dataset.slot}"][data-diagram="nalu-size"]`)
          : document.querySelector(`.bitstream-diagrams[data-slot="${card.dataset.slot}"][data-diagram="references"]`);
        return {card:card.getBoundingClientRect().toJSON(),owner:owner.getBoundingClientRect().toJSON(),full:card.scrollHeight<=card.clientHeight+1};
      }));
      assert.ok(cardBounds.every(({card,full})=>full && card.top>=8 && card.bottom<=page.viewportSize().height-7),'complete cards stay inside the viewport');
      const ordered=cardBounds.sort((a,b)=>a.owner.top-b.owner.top);
      assert.ok(ordered.slice(1).every(({card},i)=>card.top>=ordered[i].card.bottom+7),'neighbouring panels move to avoid each other');
      for (const diagram of ['nalu','references']) {
        const widths=await page.locator(`.analysis-view-card:visible[data-diagram="${diagram}"]`).evaluateAll(es=>es.map(e=>e.getBoundingClientRect().width));
        assert.ok(Math.abs(widths[0]-widths[1])<1,'same diagram cards have equal widths across tracks');
      }
      const frameRows=await page.locator('.analysis-view-card:visible[data-diagram="nalu"] .analysis-card-frame td').evaluateAll(es=>es.map(e=>{const text=document.createRange();text.selectNodeContents(e);return {height:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight),fits:e.scrollWidth<=e.clientWidth+1,lines:text.getClientRects().length};}));
      assert.ok(frameRows.every(row=>row.fits && row.lines===1 && row.height<row.line*1.5),'frame metadata uses the full row and does not wrap despite spare space');
      await page.screenshot({path:artifact('multitrack-separate.png')});
      await page.keyboard.press('Escape');
      await page.locator('#analysis-status-items button[data-slot="B"]').first().click();
      assert.equal(await page.locator('.bitstream-diagrams canvas').count(),2,'track visibility controls every selected deep diagram');
      await call('remove_review_track',{slot:'B'});
      await page.setViewportSize(cardViewport);
    }

    // Hold real FLV playback completion and the independent analysis frontier
    // at 128 validated packets, beyond several complete GOPs. Neither
    // subscriber may treat this prefix as EOF.
    for (const cancel of diagramsOnly ? [] : [false, true]) {
      await call('remove_review_track', { slot: 'A' });
      await call('set_review_color_mode', { mode: 'browser' });
      gatedId = library.entries.find(e => e.name === `incremental-${cancel ? 'cancel' : 'continue'}.flv`).id;
      releaseIndexGate = false; heldBatches = 0;
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
      assert.ok(heldBatches > 0, 'shared index batch delivery is still gated');
      assert.equal(partial.stream.indexComplete, false);
      assert.ok(partial.stream.pictures > 0 && partial.stream.pictures < 300);
      assert.match(await page.locator('.analysis-track-control[data-slot="A"] .analysis-chip').getAttribute('aria-description'), /等待索引/);
      await page.screenshot({ path: artifact(`index-wait-${cancel ? 'cancel' : 'continue'}.png`) });
      if (!cancel) {
        await call('pause_bitstream_analysis', {slot:'A'});
        const paused = await call('get_bitstream_analysis_state', {slot:'A'});
        assert.equal(paused.state, 'paused'); assert.equal(paused.stream.window, undefined, 'full-film pause keeps full-film scope');
        await page.locator('#analysis-current').click();
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
      releaseGate();
      if (!cancel) {
        await page.waitForFunction(() => {
          const state = window.voidPlayer.tools.find(t => t.name === 'get_bitstream_analysis_state').execute({});
          return state.completedStream?.pictures === 300 && state.completedStream.indexComplete;
        }, undefined, { timeout: 30000 });
      }
      await page.waitForFunction(() => window.voidPlayer.tools.find(t => t.name === 'get_analysis_capabilities').execute({})[0]?.capability.indexState === 'complete');
      if (cancel) {
        await page.locator('#analysis-current').click();
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

    const limitations = [];
    if (!incrementalOnly) for (const input of (process.argv.includes('--checkpoint-only') ? ["local-file"] : ["local-file", "library"]))
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
        await analyze();
        await page.waitForFunction(()=>document.querySelector('#bitstream-tracks [data-slot="A"]').dataset.state!=='pending');
        if (depth === 10) {
          await page
            .locator("#bitstream-overlay-A")
            .waitFor({ state: "visible" });
          await page.locator('#bitstream-mode').click();
          assert.equal(await page.locator('#bitstream-mode-menu [data-value="qp"]').count(), 0);
          await page.locator('#bitstream-mode-menu [data-value="blocks"]').click();
          assert.match(
            await page.locator('#bitstream-tracks [data-slot="A"]').getAttribute('aria-description'),
            /位深.*QP/,
          );
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
    assert.deepEqual(errors, []);
    if (diagramsOnly) {
      assert.equal(rows.filter(row => row.kind === 'whole-stream').length, 2, 'both local and library stream lifecycles are checked');
      assert.equal(limitations.length, 4, 'both inputs and bit-depth limitation cases are checked');
    }
    if (incrementalOnly) assert.equal(rows.filter(row => row.kind === 'incremental-index').length, 2, 'both continuation and cancellation are checked');
    await writeFile(
      artifact("matrix.json"),
      JSON.stringify({ engine, rows, limitations, errors }, null, 2),
    );
    await page.screenshot({ path: artifact("final.png") });
    console.log(diagramsOnly || incrementalOnly
      ? `PASS ${engine}: isolated ${incrementalOnly ? 'incremental index continuation/cancellation' : 'stream/diagram lifecycle and capability limits'}; all assertions passed`
      : `PASS ${engine}: ${rows.filter((r) => r.codec).length} real local/library decode combinations plus sustained-load and capability regressions, picture/offset/cache/range/overlay/cancel isolation`);
  },
);
