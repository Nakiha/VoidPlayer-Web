import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root=path.resolve(import.meta.dirname,'..'),name=process.argv[2]??'webkit';
const server=createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await(name==='chromium'?chromium:webkit).launch({headless:true});
try {
 const context=await browser.newContext({viewport:{width:1280,height:900},colorScheme:'light'}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));const base=`http://127.0.0.1:${server.address().port}/`;
 await page.goto(base);
 const call=(name,args={})=>page.evaluate(({name,args})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),{name,args});
 const lib=await call('list_library');
 for(const [slot,file] of [['A','av1_10s_1920x1080.webm'],['B','ffv1_yuv444p10le.mkv']])await call('load_library_item',{slot,id:lib.entries.find(e=>e.name===file).id});
 await call('set_review_track_offset',{slot:'B',offsetUs:300000});await call('seek_review',{ptsUs:1000000});
 await call('add_review_mark',{slot:'A',text:'Round trip',drawings:[{id:'rectangle',tool:'rect',color:'#ff3b30',strokeWidth:4,points:[{x:.2,y:.2},{x:.6,y:.5}]}]});
 await page.locator('.brand').click();await page.keyboard.press('n');await page.locator('[data-drawing-tool=rect]').click();
 const stage=await page.locator('#drawing-A').boundingBox();await page.mouse.move(stage.x+stage.width*.1,stage.y+stage.height*.1);await page.mouse.down();await page.mouse.move(stage.x+stage.width*.3,stage.y+stage.height*.3,{steps:4});await page.mouse.up();await page.waitForTimeout(250);await page.locator('#mark-close').click();
 await call('reorder_review_tracks',{order:['B','A']});
 await page.locator('#toggle-subtracks').click();await page.locator('#toggle-marks').click();
 await page.locator('#track-label-resize').focus();await page.keyboard.press('ArrowRight');
 await page.evaluate(()=>window.voidPlayer.setViewport({mode:'split',splitPos:.37,zoom:1.5}));
 const saved=await call('export_workspace');
 assert.ok(saved.thumbnails.length>0,'export includes existing mark previews');
 assert.equal(saved.schema,'voidplayer-workspace');assert.equal(saved.serverUrl,base);assert.ok(saved.media.every(m=>m.source.url.startsWith(base)));
 // Actual downloaded artifact is gzip JSON, and a fresh page can restore it.
 await page.locator('#settings-open').click();await page.locator('#settings-tab-workspace').click();const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const download=await downloadPromise;
 assert.match(download.suggestedFilename(),/\.voidplayer$/);const downloaded=await readFile(await download.path());assert.equal(JSON.parse(gunzipSync(downloaded)).schema,'voidplayer-workspace');await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open && document.activeElement===document.querySelector('#settings-open'));
 const restored=await context.newPage();restored.on('pageerror',e=>errors.push(e.message));await restored.goto(base);
 await restored.locator('#workspace-file').setInputFiles({name:'review.voidplayer',mimeType:'application/gzip',buffer:downloaded});
 await restored.waitForFunction(()=>window.voidPlayer.getState().tracks.length===2&&!window.voidPlayer.getState().busy);
 await restored.waitForFunction(()=>window.voidPlayer.getViewport().mode==='split');
 const after=await restored.evaluate(()=>({state:window.voidPlayer.getState(),view:window.voidPlayer.getViewport(),layout:window.voidPlayer.getWorkspace()}));
 assert.deepEqual(after.state.tracks.map(t=>[t.slot,t.id,t.offsetUs]),saved.tracks.map(t=>[t.slot,t.mediaId,t.offsetUs]));
 assert.deepEqual(after.state.marks,saved.marks);assert.equal(after.state.positionUs,saved.positionUs);assert.deepEqual(after.view,saved.viewport);
 assert.ok(await restored.locator('.annotation-row img').count()>0,'restored annotation cards retain their previews');
 assert.deepEqual(after.layout,saved.layout);assert.equal(after.state.playing,false);
 // A bad source must not erase or partially replace a loaded workspace.
 const bad=structuredClone(saved);bad.media.find(m=>m.id===bad.tracks[1].mediaId).source.url=base+'api/media/not-found';
 const failure=await restored.evaluate(async value=>{try{await window.voidPlayer.importWorkspace(value);return '';}catch(e){return e.message;}},bad);
 assert.match(failure,/无法打开/);assert.deepEqual(await restored.evaluate(()=>window.voidPlayer.getState().marks),saved.marks);
 assert.deepEqual(await restored.evaluate(()=>window.voidPlayer.getState().tracks.map(t=>t.id)),saved.tracks.map(t=>t.mediaId));
 // Plain JSON drop uses the same transaction.
 await restored.evaluate(value=>{const data=new DataTransfer();data.items.add(new File([JSON.stringify(value)],'workspace.json',{type:'application/json'}));document.body.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));},saved);
 await restored.waitForFunction(()=>!window.voidPlayer.getState().busy&&!window.voidPlayer.getState().error);
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
 assert.equal(await page.locator('#play').evaluate(e=>getComputedStyle(e).color),'rgb(236, 238, 242)');
 assert.equal(await page.locator('#timeline').evaluate(e=>getComputedStyle(e).getPropertyValue('--accent').trim()),'#bd9aff');
 assert.deepEqual(await page.evaluate(()=>window.voidPlayer.getState().marks),saved.marks);
 await page.screenshot({path:`/tmp/voidplayer-settings-dark-${name}.png`});
 await page.locator('[data-theme-choice=light]').click();await page.screenshot({path:`/tmp/voidplayer-settings-light-${name}.png`});await page.locator('#settings-close').click();await page.waitForFunction(()=>!document.querySelector('#settings').open && document.activeElement===document.querySelector('#settings-open'));
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
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: gzip download/import, JSON drop, ordered tracks/offsets/marks/view/layout, failed-source rollback, local relink/cancel, no transient seek rollback, settings and accent persistence`);
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
