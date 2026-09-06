import assert from 'node:assert/strict';
import path from 'node:path';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root=path.resolve(import.meta.dirname,'..');
const server=createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const name=process.argv[2]??'webkit';const browser=await (name==='chromium'?chromium:webkit).launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:2});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});await tool('load_library_item').execute({slot:'A',id:lib.entries.find(e=>e.name==='av1_10s_1920x1080.webm').id});});
 await page.evaluate(()=>{
   window.tooltipOpens=0;
   document.getElementById('control-tooltip').addEventListener('beforetoggle',e=>{if(e.newState==='open')window.tooltipOpens++;});
 });
 const tip=page.locator('#control-tooltip');
 for(const id of ['arrangement','reset-view','toggle-inspector','toggle-subtracks','toggle-sources']){
   const button=page.locator(`#${id}`);
   await page.mouse.move(5,5);await button.hover();await tip.waitFor({state:'visible'});
   await page.evaluate(()=>window.tooltipOpens=0);
   await button.click();await page.waitForTimeout(450);
   assert.equal(await tip.isVisible(),false,`${id}: clicked tooltip stays dismissed`);
   assert.equal(await page.evaluate(()=>window.tooltipOpens),0,`${id}: no transient reopening on mouse focus`);
   await page.mouse.move(5,5);await button.hover();await tip.waitFor({state:'visible'});
 }
 // Tab focus still exposes the tooltip; pointer focus does not suppress keyboard help.
 await page.locator('#reset-view').click();await page.keyboard.press('Tab');
 await page.locator('#zoom-select').focus();await tip.waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>document.activeElement.id),'zoom-select');
 await page.locator('#play').focus();
 // Observe every update, not just before/after screenshots: neither dimming,
 // node replacement, nor an empty icon frame may occur during seek -> play.
 await page.evaluate(()=>{
   window.playNodes=[...document.querySelectorAll('#play svg')];
   window.transportNodes=[...document.querySelectorAll('.play-buttons button')];
   window.transportSamples=[];window.transportChildChanges=0;
   window.expectedTransportFocus=document.activeElement.id;
   document.getElementById('play').addEventListener('click',()=>{window.expectedTransportFocus=document.activeElement.id;},{capture:true});
   const row=document.querySelector('.play-buttons');
   window.transportObserver=new MutationObserver(records=>{
     window.transportChildChanges+=records.filter(r=>r.type==='childList').length;
     window.transportSamples.push({focus:document.activeElement.id,expectedFocus:window.expectedTransportFocus,buttons:[...row.querySelectorAll('button')].map(b=>({disabled:b.disabled,opacity:getComputedStyle(b).opacity})),visibleIcons:[...document.querySelectorAll('#play svg')].filter(e=>getComputedStyle(e).display!=='none').length});
   });
   window.transportObserver.observe(row,{subtree:true,childList:true,attributes:true});
 });
 for(let i=0;i<3;i++){
   await page.locator('#play').click();await page.waitForFunction(()=>window.voidPlayer.getState().playing);
   await page.waitForTimeout(100);
   await page.locator('#play').click();await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
   await page.waitForTimeout(150);
   assert.equal(await tip.isVisible(),false,'playback tooltip stays dismissed during state changes');
 }
 await page.locator('#play').focus();
 await page.keyboard.press('Enter');await page.waitForFunction(()=>window.voidPlayer.getState().playing);
 await page.keyboard.press('Enter');await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
 const observations=await page.evaluate(()=>{
   window.transportObserver.disconnect();
   return {samples:window.transportSamples,childChanges:window.transportChildChanges,sameNodes:window.playNodes.every((n,i)=>n===document.querySelectorAll('#play svg')[i])&&window.transportNodes.every((n,i)=>n===document.querySelectorAll('.play-buttons button')[i])};
 });
 assert.equal(observations.sameNodes,true);assert.equal(observations.childChanges,0,'no button/icon children replaced');
 assert.ok(observations.samples.length>0);
 for(const sample of observations.samples){
   assert.equal(sample.visibleIcons,1,'exactly one play/pause glyph throughout');
   assert.equal(sample.focus,sample.expectedFocus,'transient busy state preserves activation focus');
   for(const button of sample.buttons){assert.equal(button.disabled,false);assert.equal(button.opacity,'1','transport does not dim during startup');}
 }
 assert.deepEqual(errors,[]);
 console.log(`PASS ${name}: click tooltip dismissal, hover re-entry, keyboard focus help, stable playback nodes/focus/opacity, no empty icon frame`);
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
