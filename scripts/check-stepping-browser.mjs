import assert from 'node:assert/strict';
import path from 'node:path';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root=path.resolve(import.meta.dirname,'..');
const server=createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const name=process.argv[2]??'webkit';const browser=await (name==='chromium'?chromium:webkit).launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{
   const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});
   for(const [slot,name] of [['A','av1_10s_1920x1080.webm'],['B','ffv1_yuv422p10le.mkv']])await tool('load_library_item').execute({slot,id:lib.entries.find(e=>e.name===name).id});
 });
 const state=()=>page.evaluate(()=>window.voidPlayer.getState());
 const call=(name,args)=>page.evaluate(({name,args})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),{name,args});
 for(const ptsUs of [0,1166000,1483000]){
   await call('seek_review',{ptsUs});
   for(const direction of [...Array(12).fill(1),...Array(4).fill(-1),...Array(6).fill(1)]){
     const before=await state();await call('step_review',{direction});const after=await state();
     assert.ok(direction*(after.positionUs-before.positionUs)>0,`${name}: ${direction} stalled at ${before.positionUs}`);
     if(direction>0) for(let i=0;i<2;i++){
       const delta=after.tracks[i].frame.ptsUs-before.tracks[i].frame.ptsUs;
       assert.ok([0,...(i===0?[16000,17000]:[33000,34000])].includes(delta),`track ${i} skipped a frame: ${delta}`);
     }
   }
 }
 await call('seek_review',{ptsUs:1483000});await page.locator('.brand').click();
 await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs===1500000);
 await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs<1500000);
 await page.locator('#next').click();await page.waitForFunction(()=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs===1500000);
 await call('seek_review',{ptsUs:1983000});const shortEnd=await state();
 await call('step_review',{direction:1});const continued=await state();
 assert.ok(continued.positionUs>shortEnd.positionUs,'long track steps past the short track end');
 assert.equal(continued.tracks[1].frame.ptsUs,shortEnd.tracks[1].frame.ptsUs,'short track retains its final frame');
 await call('seek_review',{ptsUs:continued.durationUs-1});const end=await state();
 await call('step_review',{direction:1});assert.equal((await state()).positionUs,end.positionUs,'longest end is a no-op');
 assert.deepEqual(errors,[]);
 console.log(`PASS ${name}: AV1 + 10-bit FFV1 mixed-rate step replay, seek/backward/forward, no skipped frames, keyboard/button parity and end boundary`);
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
