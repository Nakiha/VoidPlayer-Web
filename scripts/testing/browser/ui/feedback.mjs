import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withBrowserFixture } from '../../browser-fixture.mjs';
const originalPath = name => readFileSync(new URL(`../../../../node_modules/@phosphor-icons/core/assets/regular/${name}.svg`, import.meta.url), 'utf8').match(/d="([^"]+)"/)[1];
const name=process.argv[2]??'webkit';
await withBrowserFixture({ caseName: 'feedback', engine: name, pageOptions: {viewport:{width:1280,height:800},deviceScaleFactor:2} }, async ({ page, ready }) => {
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install();
 await ready();
 // The entry page loads the player with a dynamic import after the HTTPS check.
 await page.waitForFunction(()=>!!window.voidPlayer?.tools);
 // Check the icon without media: middle pixels must fade in one direction,
 // rather than flash as thin separators move across the central gap.
 await page.waitForLoadState('networkidle');
 await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+100));
 await page.evaluate(()=>window.arrangementNodes=[...document.querySelector('#arrangement svg').children]);
 const record=async value=>{
   await page.evaluate(value=>{
     const svg=document.querySelector('#arrangement svg');
     window.arrangementFrames=[svg.outerHTML];
     const start=performance.now();
     window.voidPlayer.setViewport({arrangement:value});
     const sample=now=>{
       window.arrangementFrames.push(svg.outerHTML);
       if(now-start<300)requestAnimationFrame(sample);
     };
     requestAnimationFrame(sample);
   },value);
   // Advance every scheduled animation frame, independent of the hosted GPU's
   // screen rate. Rasterization below still uses the browser's actual SVG path.
   await page.clock.runFor(320);
   return page.evaluate(async()=>{
     const svg=document.querySelector('#arrangement svg'),frames=window.arrangementFrames;
     const sizes=[18,36,Math.round(svg.getBoundingClientRect().width),Math.round(svg.getBoundingClientRect().width*devicePixelRatio)];
     const pixels=[];
     for(const frame of frames){
       const clone=new DOMParser().parseFromString(frame,'image/svg+xml').documentElement;
       clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('fill','white');
       const samples=[];
       for(const size of sizes){
         clone.setAttribute('width',String(size));clone.setAttribute('height',String(size));
         const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)],{type:'image/svg+xml'}));
         try{
           const image=new Image();image.src=url;await image.decode();
           const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
           const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
           for(const y of [Math.floor(size/2)-1,Math.floor(size/2)])samples.push(ctx.getImageData(Math.floor(size*80/256),y,1,1).data[3]);
         }finally{URL.revokeObjectURL(url);}
       }
       pixels.push(samples);
     }
     return {pixels,shapes:new Set(frames).size};
   });
 };
 const forward=await record('grid'),backward=await record('horizontal');
 await page.evaluate(()=>window.voidPlayer.setViewport({arrangement:'grid'}));
 await page.clock.runFor(60);
 const continuous=await page.evaluate(()=>{
   const svg=document.querySelector('#arrangement svg');
   const before=[...svg.children].map(path=>[path.getAttribute('d'),path.getAttribute('opacity')]);
   window.voidPlayer.setViewport({arrangement:'horizontal'});
   return JSON.stringify(before)===JSON.stringify([...svg.children].map(path=>[path.getAttribute('d'),path.getAttribute('opacity')]));
 });
 await page.clock.runFor(320);
 const arrangement=await page.evaluate(()=>{
   const svg=document.querySelector('#arrangement svg');
   return {sameNodes:window.arrangementNodes.every((node,i)=>node===svg.children[i]),rest:svg.querySelector('path').getAttribute('d')};
 });
 Object.assign(arrangement,{forward,backward,continuous});
 await page.clock.resume();
 for(const [direction,sign] of [['forward',1],['backward',-1]]){
   const {pixels,shapes}=arrangement[direction];
   assert.ok(shapes>5,`${direction}: sample intermediate arrangement shapes`);
   for(let i=1;i<pixels.length;i++)for(let p=0;p<pixels[i].length;p++){
     assert.ok(sign*(pixels[i][p]-pixels[i-1][p])<=1,`${direction}: middle pixel ${p} must not brighten then darken (${pixels[i-1][p]} -> ${pixels[i][p]})`);
   }
 }
 assert.equal(arrangement.continuous,true,'quick reversal preserves both outline and separator opacity');
 assert.equal(arrangement.sameNodes,true,'arrangement morph keeps its SVG paths');
 assert.equal(arrangement.rest,originalPath('squares-four'),'arrangement returns to the original grid glyph');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(()=>window.voidPlayer.setViewport({arrangement:'grid'}));
 assert.equal(await page.locator('#arrangement path').first().getAttribute('d'),originalPath('columns'));
 assert.equal(await page.locator('#arrangement [data-arrangement-separators]').getAttribute('opacity'),'0');
 await page.evaluate(()=>window.voidPlayer.setViewport({arrangement:'horizontal'}));
 assert.equal(await page.locator('#arrangement path').first().getAttribute('d'),originalPath('squares-four'));
 await page.emulateMedia({reducedMotion:'no-preference'});
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
 for(const id of ['arrangement','toggle-inspector','toggle-subtracks','toggle-sources']){
   const button=page.locator(`#${id}`);
   await page.mouse.move(5,5);await button.hover();await tip.waitFor({state:'visible'});
   await page.evaluate(()=>window.tooltipOpens=0);
   await button.click();await page.waitForTimeout(450);
   assert.equal(await tip.isVisible(),false,`${id}: clicked tooltip stays dismissed`);
   assert.equal(await page.evaluate(()=>window.tooltipOpens),0,`${id}: no transient reopening on mouse focus`);
   await page.mouse.move(5,5);await button.hover();await tip.waitFor({state:'visible'});
 }
 // Tab focus still exposes the tooltip; pointer focus does not suppress keyboard help.
 await page.locator('#arrangement').click();await page.keyboard.press('Tab');
 await page.locator('#zoom-select').focus();await tip.waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>document.activeElement.id),'zoom-select');
 await page.locator('#play').focus();
 // Observe every update, not just before/after screenshots: neither dimming,
 // node replacement, nor an empty icon frame may occur during seek -> play.
 await page.evaluate(()=>{
   window.playNodes=[...document.querySelectorAll('#play svg')];
   window.playRestPaths=[...document.querySelectorAll('#play path')].map(path=>path.getAttribute('d'));
   window.playRestBox=document.querySelector('#play svg').getBoundingClientRect().toJSON();
   window.transportNodes=[...document.querySelectorAll('.play-buttons button')];
   window.transportSamples=[];window.transportChildChanges=0;
   window.expectedTransportFocus=document.activeElement.id;
   document.getElementById('play').addEventListener('click',()=>{window.expectedTransportFocus=document.activeElement.id;},{capture:true});
   const row=document.querySelector('.play-buttons');
   window.transportObserver=new MutationObserver(records=>{
     window.transportChildChanges+=records.filter(r=>r.type==='childList').length;
     window.transportSamples.push({focus:document.activeElement.id,expectedFocus:window.expectedTransportFocus,buttons:[...row.querySelectorAll('button')].map(b=>({disabled:b.disabled,opacity:getComputedStyle(b).opacity})),visibleIcons:[...document.querySelectorAll('#play svg')].filter(e=>getComputedStyle(e).display!=='none').length,paths:[...document.querySelectorAll('#play path')].map(path=>path.getAttribute('d')),iconBox:document.querySelector('#play svg').getBoundingClientRect().toJSON()});
   });
   window.transportObserver.observe(row,{subtree:true,childList:true,attributes:true});
 });
 await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+100));
 for(let i=0;i<3;i++){
   // This already-visible control uses trusted input without waiting for a
   // screen-rate stability sample while the JavaScript animation clock pauses.
   await page.locator('#play').click({force:true});
   assert.equal(await page.evaluate(()=>window.voidPlayer.getState().playing),true);
   await page.clock.runFor(100);
   await page.locator('#play').click({force:true});
   assert.equal(await page.evaluate(()=>window.voidPlayer.getState().playing),false);
   await page.clock.runFor(150);
   await page.evaluate(async()=>{
     await Promise.all(document.querySelector('#control-tooltip').getAnimations().map(animation=>animation.finished.catch(()=>{})));
   });
   assert.equal(await tip.isVisible(),false,'playback tooltip stays dismissed during state changes');
 }
 await page.clock.runFor(300);
 await page.clock.resume();
 await page.waitForFunction(()=>[...document.querySelectorAll('#play path')].every((path,i)=>path.getAttribute('d')===window.playRestPaths[i]));
 const morphed=await page.evaluate(()=>({rest:window.playRestPaths,box:window.playRestBox,samples:window.transportSamples}));
 assert.deepEqual(morphed.rest,[originalPath('play')],'play retains the original rounded outline and stroke weight');
 assert.equal(await page.locator('#play path').getAttribute('transform'),`translate(${-256/12} 0)`,'play retains its original optical centering');
 assert.ok(new Set(morphed.samples.map(sample=>sample.paths.join('|'))).size>5,'play/pause has real intermediate shapes, including quick reversals');
 assert.ok(morphed.samples.every(sample=>JSON.stringify(sample.iconBox)===JSON.stringify(morphed.box)),'morphing never moves or resizes the icon');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.locator('#play').click();await page.waitForFunction(()=>window.voidPlayer.getState().playing);
 const pausePaths=await page.locator('#play path').evaluateAll(paths=>paths.map(path=>path.getAttribute('d')));
 assert.deepEqual(pausePaths,[originalPath('pause')],'pause retains the original rounded bars and stroke weight');
 assert.equal(await page.locator('#play path').getAttribute('transform'),'','pause retains its original centering');
 await page.locator('#play').click();await page.waitForFunction(()=>!window.voidPlayer.getState().playing);
 assert.deepEqual(await page.locator('#play path').evaluateAll(paths=>paths.map(path=>path.getAttribute('d'))),morphed.rest,'reduced motion returns immediately to the play endpoint');
 await page.emulateMedia({reducedMotion:'no-preference'});
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
   const response=await fetch(`/api/media/${item.id}/content?v=${item.version}`);
   await window.voidPlayer.loadFile('B',new File([await response.blob()],'local-comparison.webm'));
 });
 const joined=await page.evaluate(()=>({before:window.joinBefore,after:window.voidPlayer.getState()}));
 assert.equal(joined.after.positionUs,2000000);
 assert.deepEqual(joined.after.tracks.find(t=>t.slot==='A').frame,joined.before.tracks.find(t=>t.slot==='A').frame);
 const added=joined.after.tracks.find(t=>t.slot==='B').frame;
 assert.ok(added.ptsUs<=2000000&&added.ptsUs+added.durationUs>2000000);
 // A real failed load uses a dismissible warning toast and links to logs.
 await page.locator('#file-B').setInputFiles({name:'broken.flv',mimeType:'video/x-flv',buffer:Buffer.from('not a media file')});
 await page.locator('.toast-warning').waitFor({state:'visible'});
 assert.equal(await page.locator('#notice').count(),0);
 assert.equal(await page.locator('.track-failure,[id^="failure-"]').count(),0);
 assert.equal(await page.locator('.toast-warning').count(),1);
 await page.locator('.toast-warning .toast-action').click();
 assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 assert.equal(await page.locator('#settings-tab-logs').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#settings-pane-logs').isVisible(),true);
 await page.locator('#settings-close').click();
 await page.waitForFunction(()=>!document.getElementById('settings').open);
 await page.waitForFunction(()=>document.activeElement.id==='settings-open');
 assert.deepEqual(errors,[]);
 console.log(`PASS ${name}: click tooltip dismissal, hover re-entry, keyboard focus help, stable playback nodes/focus/opacity, no empty icon frame`);
});
