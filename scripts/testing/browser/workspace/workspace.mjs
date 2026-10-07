import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { withBrowserFixture } from '../../browser-fixture.mjs';
import { repositoryRoot as root } from '../../manifest.mjs';
const name = process.argv[2] ?? 'webkit';
await withBrowserFixture({ caseName: 'workspace', engine: name, pageOptions: {"viewport": {"width": 1280, "height": 900}, "colorScheme": "light"}, launchOptions: name === 'chromium' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {} }, async ({ page, context, url: base, ready, artifact }) => {
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await ready(); 
 const call=(name,args={})=>page.evaluate(({name,args})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),{name,args});
 const lib=await call('list_library');
 for(const [slot,file] of [['A','av1_10s_1920x1080.webm'],['B','ffv1_yuv444p10le.mkv']])await call('load_library_item',{slot,id:lib.entries.find(e=>e.name===file).id});
 await call('set_review_track_offset',{slot:'B',offsetUs:300000});await call('seek_review',{ptsUs:1000000});
 await call('add_review_mark',{slot:'A',text:'Round trip',drawings:[{id:'rectangle',tool:'rect',color:'#ff3b30',strokeWidth:4,points:[{x:.2,y:.2},{x:.6,y:.5}]}]});
 await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });await page.keyboard.press('n');await page.locator('[data-drawing-tool=rect]').click();
 const stage=await page.locator('#drawing-A').boundingBox();await page.mouse.move(stage.x+stage.width*.1,stage.y+stage.height*.1);await page.mouse.down();await page.mouse.move(stage.x+stage.width*.3,stage.y+stage.height*.3,{steps:4});await page.mouse.up();await page.waitForTimeout(250);await page.locator('#mark-close').click();
 await call('reorder_review_tracks',{order:['B','A']});
 await page.locator('#toggle-subtracks').click();await page.locator('#toggle-marks').click();
 await page.locator('#track-label-resize').focus();await page.keyboard.press('ArrowRight');
 await page.evaluate(()=>window.voidPlayer.setViewport({mode:'split',splitPos:.37,zoom:1.5}));
 const saved=await call('export_workspace');
 assert.ok(saved.thumbnails.length>0,'export includes existing mark previews');
 assert.equal(saved.schema,'voidplayer-workspace');assert.equal(saved.serverUrl,base);assert.ok(saved.media.every(m=>m.source.url.startsWith(base)));
 // The current UI shares workspaces; file import remains compatible with gzip artifacts.
 const downloaded = gzipSync(Buffer.from(JSON.stringify(saved)));
 assert.equal(JSON.parse(gunzipSync(downloaded)).schema, 'voidplayer-workspace');
 const restored=await context.newPage();restored.on('pageerror',e=>errors.push(e.message));await restored.goto(base); await restored.waitForFunction(() => window.voidPlayer);
 await restored.locator('#workspace-file').setInputFiles({name:'review.voidplayer',mimeType:'application/gzip',buffer:downloaded});
 await restored.waitForFunction(()=>window.voidPlayer.getState().tracks.length===2&&!window.voidPlayer.getState().busy);
 await restored.waitForFunction(()=>window.voidPlayer.getViewport().mode==='split');
 const after=await restored.evaluate(()=>({state:window.voidPlayer.getState(),view:window.voidPlayer.getViewport(),layout:window.voidPlayer.getWorkspace()}));
 assert.deepEqual(after.state.tracks.map(t=>[t.slot,t.id,t.offsetUs]),saved.tracks.map(t=>[t.slot,t.mediaId,t.offsetUs]));
 assert.deepEqual(after.state.marks,saved.marks);assert.equal(after.state.positionUs,saved.positionUs);assert.deepEqual(after.view,saved.viewport);
 assert.ok(await restored.locator('.annotation-row img').count()>0,'restored annotation cards retain their previews');
 assert.deepEqual(after.layout,saved.layout);assert.equal(after.state.playing,false);
 // Restored openers must also support settings that rebuild decoders.
 await restored.evaluate(async () => {
   const tools = window.voidPlayer.tools;
   const checkExport = () => {
     const review = window.voidPlayer.exportReview(), state = window.voidPlayer.getState();
     if (review.color !== state.color || review.comparison.colorMode !== state.colorMode ||
       JSON.stringify(review.comparison.referenceDecode) !== JSON.stringify(state.referenceDecode) ||
       review.comparisonScope !== 'export-time' || review.markComparisonConditions !== 'not-recorded')
       throw new Error('Review export comparison conditions drifted from the current session');
   };
   checkExport();
   await tools.find(t => t.name === 'set_review_color_mode').execute({ mode: 'reference' });
   checkExport();
   await tools.find(t => t.name === 'set_reference_decode').execute({ decoder: 'software', depth: 4 });
   checkExport();
   await tools.find(t => t.name === 'set_review_color_mode').execute({ mode: 'browser' });
   checkExport();
 });
 assert.deepEqual(await restored.evaluate(() => window.voidPlayer.getState().marks), saved.marks);
 assert.deepEqual(await restored.evaluate(() => window.voidPlayer.getState().tracks.map(t => t.id)), saved.tracks.map(t => t.mediaId));
 // Missing sources retain their saved track and annotation anchors for relink.
 const bad=structuredClone(saved);bad.media.find(m=>m.id===bad.tracks[1].mediaId).source.url=base+'api/media/not-found';
 const failure=await restored.evaluate(async value=>{try{await window.voidPlayer.importWorkspace(value);return '';}catch(e){return e.message;}},bad);
 assert.equal(failure,'');assert.equal(await restored.evaluate(()=>window.voidPlayer.getState().tracks[1].pendingRelink),true);assert.deepEqual(await restored.evaluate(()=>window.voidPlayer.getState().marks),saved.marks);
 const relinkToast=restored.locator('.toast').filter({hasText:'个片源待重新关联'});
 await relinkToast.waitFor({state:'visible'});
 assert.equal(await relinkToast.count(),1,'missing sources have one shared relink notice');
 assert.equal(await relinkToast.locator('.toast-action').textContent(),'重新关联');
 assert.equal(await restored.locator('.track-failure,[id^="failure-"]').count(),0,'track notices no longer overlay the picture');
 assert.equal(await restored.locator('.toast-warning').filter({hasText:'已停用'}).count(),0,'missing sources do not also emit runtime-failure warnings');
 assert.deepEqual(await restored.evaluate(()=>window.voidPlayer.getState().tracks.map(t=>t.id)),saved.tracks.map(t=>t.mediaId));
 // Plain JSON drop uses the same transaction.
 await restored.evaluate(value=>{const data=new DataTransfer();data.items.add(new File([JSON.stringify(value)],'workspace.json',{type:'application/json'}));document.body.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));},saved);
 await restored.waitForFunction(()=>!window.voidPlayer.getState().busy&&!window.voidPlayer.getState().error);
 await relinkToast.waitFor({state:'hidden'});
 // Native range clicks must not be overwritten by pre-seek state emissions.
 await page.evaluate(()=>{
  const range=document.querySelector('#timeline'),descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');window.rangeWrites=[];
  Object.defineProperty(range,'value',{configurable:true,get(){return descriptor.get.call(this);},set(value){window.rangeWrites.push(Number(value));descriptor.set.call(this,value);}});
 });
 for(const ratio of [.8,.2,.95]){
  await page.evaluate(()=>window.rangeWrites=[]);const bounds=await page.locator('#timeline').boundingBox();await page.mouse.click(bounds.x+bounds.width*ratio,bounds.y+bounds.height/2);
  await page.waitForFunction(()=>!window.voidPlayer.getState().busy);
  const {writes,position}=await page.evaluate(()=>({writes:window.rangeWrites,position:window.voidPlayer.getState().positionUs}));
  assert.ok(writes.length>0);assert.ok(writes.every(value=>value===position),`seek must never redraw the old position: ${JSON.stringify({writes,position})}`);
 }
 // Settings change appearance only and persist across pages/reloads.
 const openSettings=async()=>{await page.locator('#settings-open').click();await page.locator('#settings-tab-appearance').click();};
 await openSettings();await page.locator('[data-theme-choice=dark]').click();await page.locator('[data-accent-choice=purple]').click();
 assert.equal(await page.locator('html').getAttribute('data-accent'),'purple');
 // Theme colors transition; assert the final color after the animation settles.
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('#play')).color==='rgb(236, 238, 242)');
 assert.equal(await page.locator('#play').evaluate(e=>getComputedStyle(e).color),'rgb(236, 238, 242)');
 assert.equal(await page.locator('#timeline').evaluate(e=>getComputedStyle(e).getPropertyValue('--accent').trim()),'#bd9aff');
 assert.deepEqual(await page.evaluate(()=>window.voidPlayer.getState().marks),saved.marks);
 await page.screenshot({path:artifact(`voidplayer-settings-dark-${name}.png`)});
 await page.locator('[data-theme-choice=light]').click();await page.screenshot({path:artifact(`voidplayer-settings-light-${name}.png`)});await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open && document.activeElement===document.querySelector('#settings-open'));
 const peer=await context.newPage();await peer.goto(base);assert.equal(await peer.locator('html').getAttribute('data-accent'),'purple');await peer.close();
 // A local reference cannot silently bind another file. Canceling relink preserves the workspace.
 const local=structuredClone(saved);delete local.media.find(m=>m.id===local.tracks[0].mediaId).source;
 await restored.evaluate(value=>{window.localImport=window.voidPlayer.importWorkspace(value);},local);
 await restored.locator('.workspace-relink').waitFor();await restored.locator('.workspace-relink [aria-label="取消导入"]').click();
 await restored.evaluate(()=>window.localImport);assert.deepEqual(await restored.evaluate(()=>window.voidPlayer.getState().marks),saved.marks);
 // Supply the exact local file with its original metadata; restore still retains saved anchors.
 const info=local.media.find(m=>m.id===local.tracks[0].mediaId),bytes=await readFile(path.join(root,'fixtures/video',info.name));
 await restored.evaluate(async({document,bytes,info})=>{const file=new File([Uint8Array.from(atob(bytes),c=>c.charCodeAt(0))],info.name,{lastModified:info.lastModified});await window.voidPlayer.importWorkspace(document,[file]);},{document:local,bytes:bytes.toString('base64'),info});
 assert.deepEqual(await restored.evaluate(()=>window.voidPlayer.getState().marks),saved.marks);
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: gzip import, JSON drop, ordered tracks/offsets/marks/view/layout, missing-source recovery, local relink/cancel, no transient seek rollback, settings and accent persistence`);
});
