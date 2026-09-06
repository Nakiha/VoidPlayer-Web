import assert from 'node:assert/strict';
import path from 'node:path';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root=path.resolve(import.meta.dirname,'..');
const server=createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const name=process.argv[2]??'webkit',browser=await (name==='chromium'?chromium:webkit).launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:2});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 for (const [slot,file] of [['A','av1_10s_1920x1080.webm'],['B','ffv1_yuv444p10le.mkv'],['C','mhw_hevc_fullrange_bt709_3s.mp4'],['D','dolby_hlg_1080p30.mp4']]) {
   await page.evaluate(async({slot,file})=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n),lib=await tool('list_library').execute({});await tool('load_library_item').execute({slot,id:lib.entries.find(e=>e.name===file).id});},{slot,file});
   await page.locator(`[data-inspect=${slot}]`).click();
   const rows=await page.locator('#track-properties dl').first().evaluate(e=>Object.fromEntries([...e.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent])));
   assert.ok(['色域原色','传递特性','矩阵系数','范围'].every(label=>label in rows));
   assert.ok(rows['像素格式'] || rows['解码像素格式']);
   if(slot==='A') {assert.notEqual(rows['解码像素格式'],'未提供');assert.equal(rows['色域原色'],'未标记');}
   if(slot==='B') {assert.equal(rows['像素格式'],'yuv444p10le');assert.equal(rows['范围'],'有限范围 (TV)');}
   if(slot==='C') {
     for(const label of ['色域原色','传递特性','矩阵系数'])assert.equal(rows[label],'BT.709');
     const source=await page.evaluate(()=>window.voidPlayer.getState().tracks.find(t=>t.slot==='C').colorSource);
     // The MP4 colr tag is PC, while its HEVC frame bitstream tags TV (ffprobe -show_frames).
     assert.equal(rows['范围'],source==='container'?'全范围 (PC)':'有限范围 (TV)');
   }
   if(slot==='D') {assert.equal(rows['色域原色'],'BT.2020');assert.equal(rows['传递特性'],'HLG (ARIB B67)');assert.equal(rows['范围'],'有限范围 (TV)');}
   console.log(slot,JSON.stringify(rows));
 }
 const exported=await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='export_review').execute({}));
 assert.ok(JSON.stringify(exported).includes('yuv444p10le'),'exports carry the same metadata');
 if(process.env.METADATA_SCREENSHOT)await page.locator('#inspector-panel').screenshot({path:'/tmp/voidplayer-metadata-panel.png'});
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: native output/source pixel formats, separate color attributes, PC/TV/unspecified ranges and shared exports`);
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
