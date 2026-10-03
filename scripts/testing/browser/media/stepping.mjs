import assert from 'node:assert/strict';
import { withBrowserFixture } from '../../browser-fixture.mjs';
const name = process.argv[2] ?? 'webkit';
await withBrowserFixture({ caseName: 'stepping', engine: name, pageOptions: {"viewport": {"width": 1280, "height": 800}} }, async ({ page, ready }) => {

 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await ready();
 
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
 await call('seek_review',{ptsUs:1483000});await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
 await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs===1500000);
 await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs<1500000);
 await page.locator('#next').click();await page.waitForFunction(()=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs===1500000);
 await page.locator('#play').click();await page.waitForFunction(()=>window.voidPlayer.getState().playing);
 await page.locator('#play').click();await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
 const pointerFocus=await page.evaluate(()=>document.activeElement?.id);
 if(name==='chromium')assert.equal(pointerFocus,'play','Chromium pointer click keeps Play focused');
 // WebKit does not always focus buttons on pointer click; other browsers do.
 await page.locator('#play').focus();
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'play','frame keys are tested with Play focused');
 const focusedBefore=(await state()).positionUs;
 await page.keyboard.press('ArrowRight');await page.waitForFunction(before=>!window.voidPlayer.getState().busy&&window.voidPlayer.getState().positionUs>before,focusedBefore);
 const focusedAfter=(await state()).positionUs;
 await page.keyboard.press('ArrowLeft');await page.waitForFunction(before=>!window.voidPlayer.getState().busy&&window.voidPlayer.getState().positionUs<before,focusedAfter);
 await call('seek_review',{ptsUs:1983000});const shortEnd=await state();
 await call('step_review',{direction:1});const continued=await state();
 assert.ok(continued.positionUs>shortEnd.positionUs,'long track steps past the short track end');
 assert.equal(continued.tracks[1].frame.ptsUs,shortEnd.tracks[1].frame.ptsUs,'short track retains its final frame');
 await call('seek_review',{ptsUs:continued.durationUs-1});const end=await state();
 await call('step_review',{direction:1});assert.equal((await state()).positionUs,end.positionUs,'longest end is a no-op');
 assert.deepEqual(errors,[]);
 console.log(`PASS ${name}: AV1 + 10-bit FFV1 mixed-rate step replay, seek/backward/forward, no skipped frames, keyboard/button parity and end boundary`);
});
