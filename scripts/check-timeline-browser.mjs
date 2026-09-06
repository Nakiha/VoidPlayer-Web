import assert from 'node:assert/strict';
import path from 'node:path';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root=path.resolve(import.meta.dirname,'..');
const server=createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const name=process.argv[2]??'webkit';const browser=await (name==='chromium'?chromium:webkit).launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:2});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{const tool=n=>window.voidPlayer.tools.find(t=>t.name===n);const lib=await tool('list_library').execute({});for(const [slot,name] of [['A','av1_10s_1920x1080.webm'],['B','ffv1_yuv444p10le.mkv']])await tool('load_library_item').execute({slot,id:lib.entries.find(e=>e.name===name).id});});
 const seek=ptsUs=>page.evaluate(ptsUs=>window.voidPlayer.tools.find(t=>t.name==='seek_review').execute({ptsUs}),ptsUs);
 const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const timeline=page.locator('#timeline');
 const max=Number(await timeline.getAttribute('max'));
 const durations=await page.evaluate(()=>window.voidPlayer.getState().tracks.map(t=>t.durationUs+t.offsetUs));
 assert.equal(max,Math.max(...durations)-1,'main timeline uses the longest subtrack end');
 for(const ratio of [0,.5,1]){
   await seek(Math.round(max*ratio));await settle();
   const geometry=await page.evaluate(()=>{const input=document.querySelector('#timeline'),pin=document.querySelector('.timeline-playhead'),r=input.getBoundingClientRect(),p=pin.getBoundingClientRect();return{left:r.left,right:r.right,pin:p.left+p.width/2,ratio:Number(getComputedStyle(input).getPropertyValue('--progress-ratio'))};});
   assert.ok(Math.abs(geometry.pin-(geometry.left+(geometry.right-geometry.left)*ratio))<.1,'current marker reaches full-width endpoints');
   assert.ok(Math.abs(geometry.ratio-ratio)<.000001);
 }
 await seek(0);const rail=await timeline.boundingBox();
 for(const ratio of [.001,.37,.999]){
   const x=rail.x+rail.width*ratio;await page.mouse.move(x,rail.y+rail.height/2);
   await page.locator('#timeline-hover').waitFor({state:'visible'});
   const pin=await page.locator('#timeline-hover').boundingBox();assert.ok(Math.abs(pin.x+pin.width/2-x)<1,'hover triangle tracks exact pointer position');
   const head=await page.evaluate(()=>{const current=getComputedStyle(document.querySelector('.timeline-playhead')),hover=getComputedStyle(document.querySelector('#timeline-hover'),'::before'),crop=getComputedStyle(document.querySelector('#timeline-hover'));return {current:[current.width,current.height,current.clipPath,current.backgroundColor],hover:[hover.width,hover.height,hover.clipPath,hover.backgroundColor],height:parseFloat(crop.height),fullHeight:parseFloat(current.height)};});
   assert.deepEqual(head.hover,head.current,'hover crops the same progress pin, with identical geometry and color');
   assert.ok(Math.abs(head.height-head.fullHeight*.33)<.02,'hover only exposes the pin head');
   if(process.env.TIMELINE_SCREENSHOT && ratio===.37)await page.locator('.transport').screenshot({path:'/tmp/voidplayer-timeline-hover.png'});
   await page.mouse.click(x,rail.y+rail.height/2);
   await page.waitForFunction(()=>!window.voidPlayer.getState().busy);
   const actual=await page.evaluate(()=>window.voidPlayer.getState().positionUs);
   assert.ok(Math.abs(actual/max-ratio)<.003,`native range and hover use the same full-width mapping: ${actual/max}`);
 }
 await page.mouse.move(rail.x+rail.width*.2,rail.y+rail.height/2);await page.mouse.down();
 await page.mouse.move(rail.x+rail.width*.8,rail.y+rail.height/2,{steps:8});await page.mouse.up();
 await page.waitForFunction(()=>!window.voidPlayer.getState().busy);
 assert.ok(Math.abs(await page.evaluate(()=>window.voidPlayer.getState().positionUs)/max-.8)<.003,'native range retains drag seeking with a painted marker');
 await timeline.focus();await page.keyboard.press('Home');await page.waitForFunction(()=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs===0);
 await timeline.focus();await page.keyboard.press('End');await page.waitForFunction(max=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs===max,max);
 await page.mouse.move(5,5);assert.equal(await page.locator('#timeline-hover').isVisible(),false);
 await page.locator('#toggle-subtracks').click();await settle();
 assert.equal(await page.locator('.marks-empty').isVisible(),false,'collapsed empty annotations have no placeholder');
 await page.locator('#toggle-marks').click();assert.equal(await page.locator('.marks-empty').isVisible(),true);
 assert.equal(await page.locator('.marks-empty .icon').count(),0);
 await page.waitForTimeout(250);
 assert.equal(Math.round((await page.locator('.subtrack-tools').boundingBox()).width),160,'annotation panel opens at its minimum width');
 await page.locator('#toggle-marks').click();
 await seek(500000);
 await page.locator('#subtrack-add-mark').hover();
 const markButton=await page.evaluate(async()=>{
   const button=document.querySelector('#subtrack-add-mark'),icon=button.firstElementChild;
   const before=getComputedStyle(button).opacity;const samples=[];let replaced=false;
   const observe=new MutationObserver(()=>{samples.push([button.disabled,getComputedStyle(button).opacity]);replaced ||= button.firstElementChild!==icon;});
   observe.observe(button,{attributes:true,childList:true,subtree:true});
   for(const direction of [1,-1,1,-1])await window.voidPlayer.tools.find(t=>t.name==='step_review').execute({direction});
   observe.disconnect();return {before,samples,replaced};
 });
 assert.equal(markButton.replaced,false);assert.ok(markButton.samples.length>0);
 assert.ok(markButton.samples.every(([disabled,opacity])=>!disabled&&opacity===markButton.before),'frame stepping neither dims nor rebuilds the annotation button');
 await page.evaluate(()=>{window.dockNodes=[...document.querySelectorAll('#subtrack-list *')];window.rulerNodes=[...document.querySelectorAll('#subtrack-ruler *')];});
 for(const slot of ['B','A','B','A']){
   const label=page.locator(`[data-track-drag=${slot}] .subtrack-name`);
   await label.click();await settle();
   assert.equal(await page.evaluate(()=>window.dockNodes.every(n=>n.isConnected)&&window.rulerNodes.every(n=>n.isConnected)),true,'track selection never replaces dock/ruler nodes');
   assert.equal(await label.getAttribute('data-tooltip'),null);
   const selected=page.locator(`.subtrack-row[data-track-drag=${slot}]`);
   const duration=selected.locator('.track-duration');const color=await duration.evaluate(e=>getComputedStyle(e).backgroundColor);
   await duration.hover();assert.equal(await duration.evaluate(e=>getComputedStyle(e).backgroundColor),color,'hover preserves selected track color');
   const playhead=selected.locator('.track-playhead:not(.track-seek-preview)');assert.equal(await playhead.evaluate(e=>getComputedStyle(e).width),'2px');
   assert.equal(await playhead.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(0, 122, 255)');
   assert.equal(await page.locator('.subtrack-row:not(.selected) .track-playhead:not(.track-seek-preview)').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(142, 142, 147)');
   await label.hover();await page.waitForTimeout(400);assert.equal(await page.locator('#control-tooltip').isVisible(),false,'filename has no generic tooltip');
 }
 // Resize the shared header/row column without rebuilding tracks or stealing timeline space.
 const splitter=page.locator('#track-label-resize');
 const columnWidth=()=>page.locator('.subtrack-name-heading').evaluate(e=>e.getBoundingClientRect().width);
 const originalWidth=await columnWidth(), splitBox=await splitter.boundingBox();
 await page.mouse.move(splitBox.x+splitBox.width/2,splitBox.y+splitBox.height/2);await page.mouse.down();
 await page.mouse.move(splitBox.x+splitBox.width/2+100,splitBox.y+splitBox.height/2);await page.mouse.up();
 assert.ok(Math.abs(await columnWidth()-originalWidth-100)<1,'header splitter adjusts filename width');
 const aligned=await page.evaluate(()=>{const ruler=document.querySelector('#subtrack-ruler').getBoundingClientRect();return [...document.querySelectorAll('.track-lane')].every(e=>Math.abs(e.getBoundingClientRect().left-ruler.left)<1 && Math.abs(e.getBoundingClientRect().width-ruler.width)<1);});
 assert.equal(aligned,true,'ruler and all tracks retain the same time geometry');
 assert.equal(await page.evaluate(()=>window.dockNodes.every(n=>n.isConnected)),true,'resizing preserves track nodes');
 await splitter.focus();await page.keyboard.press('Home');assert.equal(await columnWidth(),96);
 await page.keyboard.press('End');assert.ok((await page.locator('.track-lane').first().boundingBox()).width>=159,'splitter leaves timeline space');
 await splitter.dblclick();assert.equal(await columnWidth(),originalWidth);
 const cancelBox=await splitter.boundingBox();
 await page.mouse.move(cancelBox.x+cancelBox.width/2,cancelBox.y+cancelBox.height/2);await page.mouse.down();
 await page.mouse.move(cancelBox.x+cancelBox.width/2+80,cancelBox.y+cancelBox.height/2);await page.keyboard.press('Escape');await page.mouse.up();
 assert.equal(await columnWidth(),originalWidth,'Escape restores column width');
 // Both current and preview lines clamp at each track's own boundaries, including offsets.
 const setOffset=offsetUs=>page.evaluate(offsetUs=>window.voidPlayer.tools.find(t=>t.name==='set_review_track_offset').execute({slot:'B',offsetUs}),offsetUs);
 const laneB=page.locator('.subtrack-row[data-track-drag=B] .track-lane');
 for(const offsetUs of [0,1000000,-500000]){
   await setOffset(offsetUs);await seek(0);await settle();
   const start=await page.locator('#subtrack-playhead-B').evaluate(e=>parseFloat(e.style.left));
   assert.ok(Math.abs(start-Math.max(0,offsetUs)/Math.max(...durations)*100)<.001,'current line clamps to the first visible frame for delayed tracks');
   const lane=await laneB.boundingBox(),before=await page.evaluate(()=>window.voidPlayer.getState().positionUs);
   await page.mouse.move(lane.x+lane.width*.8,lane.y+lane.height/2);
   const geometry=await laneB.evaluate(e=>{const box=e.getBoundingClientRect(),bar=e.querySelector('.track-duration').getBoundingClientRect(),hover=e.querySelector('.track-seek-preview').getBoundingClientRect();return {end:bar.right,x:hover.x+hover.width/2,hidden:e.querySelector('.track-seek-preview').hidden};});
   assert.equal(geometry.hidden,false);assert.ok(Math.abs(geometry.x-geometry.end)<1,'hover line stops exactly at the short track EOF');
   assert.equal(await page.evaluate(()=>window.voidPlayer.getState().positionUs),before,'hover never seeks the decoder');
   const expected=await page.locator('.subtrack-row[data-track-drag=A] .track-seek-preview').evaluate(e=>parseFloat(e.style.left)/100);
   await page.mouse.click(lane.x+lane.width*.8,lane.y+lane.height/2);await page.waitForFunction(()=>!window.voidPlayer.getState().busy);
   const state=await page.evaluate(()=>window.voidPlayer.getState());
   assert.ok(Math.abs(state.positionUs/Math.max(...durations)-expected)<.001,'clicking beyond short EOF seeks the common preview time');
   assert.ok(state.tracks.find(t=>t.slot==='B').frame.ptsUs>1900000,'short track keeps its last frame after the common seek');
   const actual=await laneB.evaluate(e=>{const bar=e.querySelector('.track-duration').getBoundingClientRect(),cursor=e.querySelector('.track-playhead:not(.track-seek-preview)').getBoundingClientRect();return {end:bar.right,x:cursor.x+cursor.width/2};});
   assert.ok(Math.abs(actual.x-actual.end)<1,'actual playhead stops at the duration bar EOF, even with offsets');
   if(process.env.TIMELINE_SCREENSHOT && offsetUs===0)await page.locator('.subtracks-panel').screenshot({path:`/tmp/voidplayer-subtrack-eof-${name}.png`});
   await page.mouse.move(5,5);assert.equal(await laneB.locator('.track-seek-preview').isVisible(),false);
 }
 await setOffset(0);
 // Cross the short track's EOF while the long track and the presentation clock keep going.
 await seek(1850000);await timeline.focus();await page.keyboard.press('Space');
 await page.waitForFunction(()=>window.voidPlayer.getState().playing);
 const motion=await page.evaluate(()=>new Promise(resolve=>{
   const samples=[];const start=performance.now();
   function sample(){
     const state=window.voidPlayer.getState(),input=document.querySelector('#timeline');
     samples.push({position:state.positionUs,value:Number(input.value),ratio:Number(input.parentElement.style.getPropertyValue('--progress-ratio')),short:state.tracks.find(t=>t.slot==='B').frame.ptsUs,long:state.tracks.find(t=>t.slot==='A').frame.ptsUs,playing:state.playing});
     if(performance.now()-start<1000)requestAnimationFrame(sample);else resolve(samples);
   }requestAnimationFrame(sample);
 }));
 await page.keyboard.press('Space');
 assert.ok(motion.every(s=>s.playing && s.value===s.position && Math.abs(s.ratio-s.position/max)<.000001),'focused timeline follows actual presentation PTS every animation frame');
 assert.ok(new Set(motion.map(s=>s.value)).size>motion.length*.7,'progress advances at presentation cadence, not 10Hz');
 const afterEnd=motion.filter(s=>s.position>2100000);assert.ok(afterEnd.length>2);
 assert.equal(new Set(afterEnd.map(s=>s.short)).size,1,'short source holds its last frame');
 assert.ok(new Set(afterEnd.map(s=>s.long)).size>1,'long source continues playing');
 const paused=Number(await timeline.inputValue());await page.waitForTimeout(100);assert.equal(Number(await timeline.inputValue()),paused);
 await seek(max);const end=await page.evaluate(()=>window.voidPlayer.getState());
 assert.equal(end.positionUs,max);assert.equal(end.tracks.find(t=>t.slot==='B').frame.ptsUs,afterEnd[0].short);
 await seek(max-150000);await page.locator('#play').click();
 await page.waitForFunction(()=>!window.voidPlayer.getState().playing && !window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs===window.voidPlayer.getState().durationUs-1);
 await page.evaluate(()=>window.voidPlayer.setViewport({zoom:500}));await settle();assert.equal(await page.evaluate(()=>window.voidPlayer.getViewport().zoom),500);
 const surfaces=await page.locator('.frame-presentation').evaluateAll(nodes=>nodes.filter(e=>!e.hidden).map(e=>({width:e.width,height:e.height,rect:e.getBoundingClientRect().toJSON()})));
 assert.ok(surfaces.length>0);for(const surface of surfaces){assert.ok(surface.width<=Math.ceil(surface.rect.width*2)+1);assert.ok(surface.height<=Math.ceil(surface.rect.height*2)+1);}
 if(process.env.TIMELINE_SCREENSHOT)await page.screenshot({path:'/tmp/voidplayer-timeline.png'});
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: resizable filename column, compact annotation panel, per-track EOF/offset current and hover clamps, longest-track end and last-frame hold, presentation-cadence progress, stable annotation button, empty compact rail, full-width seek/hover, stable dock selection and color, bounded 500x surface`);
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
