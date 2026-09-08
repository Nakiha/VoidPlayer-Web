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
 // Fit is unobscured, but the full stage remains available beneath glass at zoom.
 await page.setViewportSize({width:1280,height:520});
 await page.evaluate(()=>window.voidPlayer.setViewport({zoom:1,offsetX:0,offsetY:0}));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const fitted=await page.evaluate(()=>{
   const image=document.querySelector('#image-A').getBoundingClientRect();
   const stage=document.querySelector('#stage-A').getBoundingClientRect();
   const bars=[...document.querySelectorAll('.card-heading,.transport')].filter(e=>e.getBoundingClientRect().width>0&&!e.hidden).map(e=>e.getBoundingClientRect());
   return {height:stage.height,overlap:bars.some(b=>image.left<b.right&&image.right>b.left&&image.top<b.bottom&&image.bottom>b.top)};
 });
 assert.equal(fitted.overlap,false,'the fitted image is entirely outside overlay bands');
 await page.evaluate(()=>window.voidPlayer.setViewport({zoom:4}));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const enlarged=await page.evaluate(()=>({height:document.querySelector('#stage-A').getBoundingClientRect().height,image:document.querySelector('#image-A').getBoundingClientRect().height}));
 assert.equal(enlarged.height,fitted.height,'fit clearance never crops or resizes the stage');
 assert.ok(enlarged.image>fitted.height,'zoomed video can extend beneath translucent controls');
 await page.evaluate(()=>window.voidPlayer.setViewport({offsetX:100000}));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await page.locator('#toggle-chrome').click();
 assert.equal(await page.locator('#recover-A').isVisible(),true,'focus mode preserves the offscreen recovery action');
 await page.locator('#recover-A').click();
 assert.equal(await page.locator('#toggle-chrome').getAttribute('aria-pressed'),'true','recovery does not exit focus mode');
 assert.equal(await page.locator('#recover-A').isVisible(),false,'recovered content no longer needs a hint');
 assert.equal(await page.evaluate(()=>window.voidPlayer.getViewport().zoom),4,'recovery preserves magnification');
 await page.locator('#toggle-chrome').click();

 await page.evaluate(()=>window.voidPlayer.setViewport({zoom:1,offsetX:0,offsetY:0}));
 await page.setViewportSize({width:1280,height:800});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
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
 // Adding a source at a nonzero paused position only presents the newcomer.
 await page.evaluate(async()=>{
   const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);
   await tool('seek_review').execute({ptsUs:2000000});
   const before=window.voidPlayer.getState();window.joinBefore=before;
   const lib=await tool('list_library').execute({});const item=lib.entries.find(e=>e.name==='av1_10s_1920x1080.webm');
   const response=await fetch(`/api/media/${item.id}?v=${item.version}`);
   await window.voidPlayer.loadFile('B',new File([await response.blob()],'local-comparison.webm'));
 });
 const joined=await page.evaluate(()=>({before:window.joinBefore,after:window.voidPlayer.getState()}));
 assert.equal(joined.after.positionUs,2000000);
 assert.deepEqual(joined.after.tracks.find(t=>t.slot==='A').frame,joined.before.tracks.find(t=>t.slot==='A').frame);
 const added=joined.after.tracks.find(t=>t.slot==='B').frame;
 assert.ok(added.ptsUs<=2000000&&added.ptsUs+added.durationUs>2000000);
 // A real failed load exposes the persistent notice action and selects logs.
 await page.locator('#file-B').setInputFiles({name:'broken.flv',mimeType:'video/x-flv',buffer:Buffer.from('not a media file')});
 await page.locator('#notice').waitFor({state:'visible'});
 await page.locator('#notice-logs').click();
 assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 assert.equal(await page.locator('#settings-tab-logs').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#settings-pane-logs').isVisible(),true);
 await page.locator('#settings-close').click();
 await page.waitForFunction(()=>!document.getElementById('settings').open);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'notice-logs');
 assert.deepEqual(errors,[]);
 console.log(`PASS ${name}: click tooltip dismissal, hover re-entry, keyboard focus help, stable playback nodes/focus/opacity, no empty icon frame`);
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
