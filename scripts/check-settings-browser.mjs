import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root=path.resolve(import.meta.dirname,'..'),name=process.argv[2]??'webkit';
const server=createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await(name==='chromium'?chromium:webkit).launch({headless:true});
// Check the rendered stroke, not just matching CSS values: CSS fills and SVG
// strokes can rasterize differently even at the same nominal thickness.
async function checkConnectorPixels(page) {
 const png=await page.locator('.color-flow-connector-horizontal:visible').first().screenshot();
 const columns=await page.evaluate(async png=>{
  const image=new Image();image.src=`data:image/png;base64,${png}`;await image.decode();
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const context=canvas.getContext('2d');context.drawImage(image,0,0);
  const scale=image.width/60;
  return [7,50].map(x=>[...context.getImageData(Math.floor(x*scale),0,1,image.height).data]);
 },png.toString('base64'));
 assert.deepEqual(columns[0],columns[1],'left and right line segments have identical rendered pixels');
 assert.ok(new Set(Array.from({length:columns[0].length/4},(_,row)=>columns[0].slice(row*4,row*4+4).join(','))).size>1,'pixel comparison includes the visible stroke');
}
try {
 const page=await browser.newPage({viewport:{width:1280,height:700},colorScheme:'dark'}), errors=[];let uploads=0, originalSession='';
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/logs'))uploads++;});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 assert.equal(await page.locator('#more-actions').count(),0);assert.equal(await page.locator('#help').count(),0);assert.equal(await page.locator('dialog.log-panel').count(),0);
 await page.locator('#settings-open').click();await page.locator('#settings').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));const geometry=await page.locator('#settings').boundingBox();
 assert.equal(await page.locator('#settings-tab-annotations, #settings-pane-annotations, #annotation-space-choice, #annotation-space-create, #annotation-publish').count(),0,'legacy recovery page is removed');
 assert.equal(await page.locator('#settings [role=tab]').count(),7);
 assert.equal(await page.locator('#settings details, #settings summary').count(),0,'settings contain no disclosure controls');
 assert.equal(await page.locator('#settings [role=tabpanel]:not(#settings-pane-performance) select').count(),0,'settings use shared choice menus');
 for(const pane of ['appearance','workspace','identity','shortcuts','logs','performance','about']) {
  await page.locator(`#settings-tab-${pane}`).click();assert.equal(await page.locator('[role=tabpanel]:visible').count(),1);assert.equal(await page.locator('dialog[open]').count(),1);
  assert.deepEqual(await page.locator('#settings').boundingBox(),geometry,'panes keep a stable window');
  assert.equal(await page.locator(`#settings-tab-${pane}`).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator(`#settings-pane-${pane}`).isVisible(),true);
  const sectionSpacing = await page.locator(`#settings-pane-${pane} .settings-section`).evaluateAll(sections => sections.flatMap(section => {
   const checks = [], next = section.nextElementSibling;
   if(next?.classList.contains('settings-section')) checks.push({kind:'section',gap:next.getBoundingClientRect().top-section.getBoundingClientRect().bottom});
   const heading = section.firstElementChild, body = heading?.nextElementSibling;
   if(heading && body) checks.push({kind:'heading',gap:body.getBoundingClientRect().top-heading.getBoundingClientRect().bottom});
   return checks;
  }));
  for(const check of sectionSpacing) assert.ok(Math.abs(check.gap-(check.kind==='section'?12:6))<1,`${pane} ${check.kind} spacing: ${check.gap}`);
  if(process.env.SETTINGS_SCREENSHOTS) await page.locator('#settings').screenshot({path:`${process.env.SETTINGS_SCREENSHOTS}-${pane}.png`});
  if(pane==='workspace') {
   for(const id of ['saved-workspace-share']) {
    const size=await page.locator(`#${id}`).boundingBox();assert.ok(size.height<40,'workspace actions stay on one line');
   }
  }
  if(pane==='performance') {
   const headings=await page.evaluate(()=>['performance','shortcuts'].map(pane=>{
    const el=document.querySelector(`#settings-pane-${pane} .settings-section-title`),style=getComputedStyle(el);
    return {fontSize:style.fontSize,color:style.color,fontWeight:style.fontWeight,paddingLeft:style.paddingLeft};
   }));
   assert.deepEqual(headings[0],headings[1],'color section heading matches other settings sections');
   await page.locator('[data-color-mode=reference]').click();
   await page.locator('[data-reference-decoder=hardware]').click();
   await page.waitForFunction(()=>document.querySelector('#color-flow-diagram').dataset.decoder==='hardware'&&document.querySelector('#color-flow-diagram').dataset.mode==='reference');
   const decoderGroup=page.locator('#reference-decoder');
   await page.emulateMedia({reducedMotion:'no-preference'});
   for(const decoder of ['software','hardware']) {
    const selected=decoderGroup.locator(`[data-reference-decoder=${decoder}]`), other=decoderGroup.locator(`[data-reference-decoder=${decoder==='software'?'hardware':'software'}]`);
    const icon=page.locator('.color-flow-unit > .icon').first(), before=await icon.boundingBox();
    await selected.click();await page.waitForFunction(decoder=>document.querySelector(`[data-reference-decoder=${decoder}]`).getAttribute('aria-pressed')==='true',decoder);
    assert.equal(await icon.evaluate(el=>el.getAnimations().length),0,'decoder icon swaps without motion even when animations are allowed');
    assert.deepEqual(await icon.boundingBox(),before,'decoder icon keeps its position and size when switching');
    const sizes=await decoderGroup.locator('button').evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().width));
    assert.ok(Math.abs(sizes[0]-sizes[1])<1,'decoder segments have equal widths despite different label lengths');
    assert.notEqual(await decoderGroup.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','decoder options share a visible base');
    const fill=await selected.evaluate(el=>getComputedStyle(el).backgroundColor);
    assert.notEqual(fill,'rgba(0, 0, 0, 0)','selected decoder fills its segment');
    await other.hover();
    assert.equal(await other.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','hover does not make the other segment look selected');
    assert.equal(await selected.evaluate(el=>getComputedStyle(el).backgroundColor),fill,'hover preserves the selected segment');
    assert.equal(await selected.evaluate(el=>getComputedStyle(el).transitionDuration),'0s','decoder selection changes instantly');
    assert.equal(await decoderGroup.locator('[aria-pressed=true]').count(),1,'exactly one decoder is selected');
    await page.locator('#reference-decode-settings').screenshot({path:`/tmp/voidplayer-decoder-segments-${decoder}-${name}.png`});
   }
   for(const mode of ['reference','browser']) {
    await page.locator(`[data-color-mode=${mode}]`).click();
    await page.waitForFunction(mode=>document.querySelector('#color-flow-diagram').dataset.mode===mode,mode);
    for(const width of [1280,550,390,320]) {
     await page.setViewportSize({width,height:800});
     const lanes=await page.locator('.color-flow-nodes').evaluateAll(lanes=>lanes.map(lane=>{
      const rect=el=>el.getBoundingClientRect().toJSON();
      const horizontal=getComputedStyle(lane).display==='grid';
      return {horizontal,bounds:rect(lane),host:rect(lane.parentElement),units:[...lane.querySelectorAll('.color-flow-unit')].map(rect),icons:[...lane.querySelectorAll('.color-flow-unit > .icon')].map(rect),titles:[...lane.querySelectorAll('.color-flow-unit > strong')].map(rect),links:[...lane.querySelectorAll('.color-flow-link')].map(link=>({arrow:rect(link.querySelector(horizontal?'.color-flow-connector-horizontal':'.color-flow-connector-vertical')),text:rect(link.querySelector('span'))}))};
     }));
     for(const lane of lanes) {
      if(lane.horizontal) {
       const centers=lane.icons.map(icon=>icon.y+icon.height/2);
       assert.ok(Math.max(...centers)-Math.min(...centers)<1,'node icons share one axis');
       assert.ok(Math.max(...lane.titles.map(title=>title.y))-Math.min(...lane.titles.map(title=>title.y))<1,'node titles align');
       lane.links.forEach(link=>{
        assert.ok(Math.abs(link.arrow.y+link.arrow.height/2-centers[0])<1,'arrows align to the node axis');
        assert.ok(Math.abs(link.text.y+link.text.height/2-centers[0])<1,'action labels sit on the same axis');
        assert.ok(link.text.x>=link.arrow.x+13&&link.text.x+link.text.width<=link.arrow.x+47,'labels stay inside the gap between line segments');
       });
      } else {
       assert.ok(Math.abs(lane.bounds.x+lane.bounds.width/2-lane.host.x-lane.host.width/2)<1,'vertical steps center within the lane');
       lane.links.forEach((link,index)=>{
        const icon=lane.icons[index];
        assert.ok(Math.abs(link.arrow.x+link.arrow.width/2-icon.x-icon.width/2)<1,'vertical arrows align with node icons');
        assert.ok(link.arrow.y>=lane.units[index].y+lane.units[index].height&&link.arrow.y+link.arrow.height<=lane.units[index+1].y,'connector fits between vertical steps');
       });
      }
     }
     if(width===1280)await checkConnectorPixels(page);
     if(mode==='reference'&&[1280,390].includes(width))await page.locator('#settings').screenshot({path:`/tmp/voidplayer-color-flow-${width===1280?'wide':'compact'}-${name}.png`});
    }
   }
   await page.setViewportSize({width:1280,height:700});
   const retina=await browser.newPage({viewport:{width:1280,height:700},deviceScaleFactor:2,colorScheme:'dark',reducedMotion:'reduce'});
   try {
    await retina.goto(page.url());await retina.locator('#settings-open').click();await retina.locator('#settings-tab-performance').click();
    await checkConnectorPixels(retina);
   } finally { await retina.close(); }
  }
  if(pane==='about') {
   const links=await page.locator('#settings-pane-about a').evaluateAll(es=>es.map(e=>e.getAttribute('href')));
   assert.ok(links.includes('https://github.com/Nakiha/VoidPlayer-Web'));
   for(const href of links.filter(h=>h.startsWith('/'))) { const response=await page.request.get(new URL(href,page.url()).href);assert.equal(response.status(),200);assert.ok(!(await response.text()).includes('<!doctype html>')); }
  }
  if(pane==='logs') {
   const headingAlignment=await page.evaluate(()=>{
    const title=document.querySelector('.settings-floating-header h2').getBoundingClientRect();
    const subtitle=document.querySelector('#settings-pane-logs .settings-section-title').getBoundingClientRect();
    const header=document.querySelector('.settings-floating-header').getBoundingClientRect();
    return { horizontal:Math.abs(title.left-subtitle.left-parseFloat(getComputedStyle(document.querySelector('#settings-pane-logs .settings-section-title')).paddingLeft)), vertical:subtitle.top-header.bottom };
   });
   assert.ok(headingAlignment.horizontal<1 && headingAlignment.vertical>=0 && headingAlignment.vertical<=12,`feedback headings align with a compact gap: ${JSON.stringify(headingAlignment)}`);
   assert.equal(await page.locator('.log-json').isVisible(),true);
   assert.equal(await page.locator('.log-panel [data-action=upload]').isVisible(),true);
   assert.equal(await page.locator('.log-panel .settings-group').count(),0);
   await page.waitForFunction(()=>document.querySelector('.log-json').value.startsWith('{'));
   // 当前日志预览先于 IndexedDB 历史列表显示；等菜单真正启用后再测键盘。
   // disabled 按钮无法获得焦点，ArrowDown 会误操作仍有焦点的设置标签页。
   await page.waitForFunction(()=>!document.querySelector('#log-session').disabled);
   await page.locator('#log-session').focus(); await page.keyboard.press('ArrowDown');
   assert.equal(await page.locator('#log-session-menu').evaluate(e=>e.matches(':popover-open')),true);
   const menuBox=await page.locator('#log-session-menu').boundingBox(), triggerBox=await page.locator('#log-session').boundingBox();
   assert.ok(menuBox.width>=triggerBox.width,'menu is at least as wide as its trigger');
   assert.equal(await page.locator('#log-session-menu').evaluate(e=>getComputedStyle(e).opacity),'1','opening is immediate');
   assert.equal(await page.locator('#log-session-menu').evaluate(e=>e.getAnimations().length),0,'opening has no animation');
   await page.locator('#settings').screenshot({path:`/tmp/voidplayer-settings-menu-width-${name}.png`});
   assert.equal(await page.locator('#log-session-menu [aria-checked=true]').evaluate(e=>e===document.activeElement),true);
   await page.keyboard.press('Escape');
   assert.equal(await page.locator('#settings').evaluate(e=>e.open),true,'Escape closes the menu before settings');
   assert.equal(await page.locator('#log-session').evaluate(e=>e===document.activeElement),true);
   await page.locator('#log-session').click();
   const exit=await page.locator('#log-session-menu').evaluate(e=>new Promise(resolve=>{
    e.addEventListener('beforetoggle',event=>{
     if(event.newState!=='closed')return;
     requestAnimationFrame(()=>{
      const surface=document.querySelector(`[data-menu-exit-for="${e.id}"]`)??e;
      const fade=surface.getAnimations().find(a=>a.effect.getKeyframes().some(frame=>'opacity' in frame));
      if(fade){fade.pause();fade.currentTime=60;}
      const style=getComputedStyle(surface);
      resolve({ghostOpen:surface!==e && surface.matches(':popover-open'),fade:!!fade,opacity:Number(style.opacity),display:style.display,overlay:style.overlay,pointerEvents:style.pointerEvents});
     });
    },{once:true});
    e.hidePopover();
   }));
   assert.ok(exit.fade && exit.opacity>0 && exit.opacity<1,`closing visibly fades: ${JSON.stringify(exit)}`);
   assert.equal(exit.display,'flex'); assert.ok(exit.overlay==='auto'||exit.ghostOpen,'fading surface remains in the top layer'); assert.equal(exit.pointerEvents,'none');
   // Reopening interrupts the fade without waiting or inheriting partial opacity.
   await page.locator('#log-session').click();
   assert.equal(await page.locator('#log-session-menu').evaluate(e=>getComputedStyle(e).opacity),'1');
   assert.equal(await page.locator('[data-menu-exit-for="log-session-menu"]').count(),0,'reopening clears the old fading surface');
   assert.equal(await page.locator('#log-session-menu').evaluate(e=>e.getAnimations().length),0);
   await page.keyboard.press('Enter');
   assert.equal(await page.locator('#log-session-menu').evaluate(e=>e.matches(':popover-open')),false);

   const downloadPromise=page.waitForEvent('download');await page.locator('.log-panel [data-action=download]').click();const download=await downloadPromise;
   const log=JSON.parse(await readFile(await download.path(),'utf8'));originalSession=log.sessionId;assert.ok(log.events.length>0);assert.equal(uploads,0,'viewing and downloading logs never uploads');
  }
  if(['appearance','workspace','identity','shortcuts','logs','performance','about'].includes(pane))await page.locator('#settings').screenshot({path:`/tmp/voidplayer-settings-unified-${pane}-${name}.png`});
 }
 await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement===document.querySelector('#settings-open'));
 await page.locator('#settings-open').click();assert.equal(await page.locator('#settings-tab-about').getAttribute('aria-selected'),'true','reopening remembers last pane');
 await page.keyboard.press('Home');assert.equal(await page.locator('#settings-tab-appearance').getAttribute('aria-selected'),'true');
 await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#settings-tab-workspace').getAttribute('aria-selected'),'true');
 await page.locator('#settings-tab-appearance').click();await page.locator('[data-theme-choice=light]').click();
 assert.equal(await page.locator('#settings').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(240, 241, 243)');
 await page.locator('#settings').screenshot({path:`/tmp/voidplayer-settings-unified-light-${name}.png`});
 await page.setViewportSize({width:390,height:700});
 for(const pane of ['appearance','workspace','identity','shortcuts','logs','performance','about']) {
  await page.locator(`#settings-tab-${pane}`).click();
  const overflow=await page.locator(`#settings-pane-${pane}`).evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));
  assert.ok(overflow.scroll<=overflow.width+1,`no horizontal overflow in ${pane}: ${JSON.stringify(overflow)}`);
  const bordered=await page.locator(`#settings-pane-${pane}`).evaluate(e=>[...e.querySelectorAll('.settings-card,.settings-group,.log-report')].filter(card=>card.getClientRects().length&&getComputedStyle(card).borderTopWidth!=='0px').map(card=>card.className));
  assert.deepEqual(bordered,[],`section cards have no outer border in ${pane}`);
  if(pane==='logs') {
   await page.locator('#log-session').click();
   const menu=await page.locator('#log-session-menu').boundingBox(), trigger=await page.locator('#log-session').boundingBox();
   assert.ok(menu.width>=trigger.width && menu.x>=0 && menu.x+menu.width<=390,'narrow menu follows trigger and fits viewport');
   await page.keyboard.press('Escape');
  }
  const box=await page.locator('#settings').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390&&box.y>=0&&box.y+box.height<=700);
 }
 for (const width of [320,390,550]) {
  await page.setViewportSize({width,height:785});
  const nav=page.locator('.settings-navigation'), tablist=nav.locator('[role=tablist]');
  assert.equal(await tablist.getAttribute('aria-orientation'),'horizontal');
  await page.locator('#settings-tab-about').press('Home');
  await page.locator('#settings-tab-appearance').press('End');
  const selected=await page.locator('#settings-tab-about').boundingBox(), rail=await nav.boundingBox();
  assert.ok(selected.x>=rail.x&&selected.x+selected.width<=rail.x+rail.width+1,`${width}px keyboard navigation reveals the active tab`);
  if(width===320)assert.ok(await nav.evaluate(el=>el.scrollLeft)>0,'narrow tab rail scrolls to the final category');
  await page.locator('#settings-tab-about').press('Home');
  const first=await page.locator('#settings-tab-appearance').boundingBox();
  assert.ok(first.x>=rail.x&&first.x+first.width<=rail.x+rail.width+1,'Home reveals the first category');
  const header=await page.locator('.settings-floating-header').boundingBox(), pane=await page.locator('#settings-pane-appearance').boundingBox();
  assert.ok(header.y+header.height<=rail.y+1&&rail.y+rail.height<=pane.y+1,'title, category rail and content occupy independent rows');
  assert.equal(await page.locator('#settings-tab-appearance').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','mobile selection uses an underline without a filled tile');
  assert.equal(await page.locator('#settings-tab-appearance').evaluate(el=>getComputedStyle(el,'::after').height),'2px');
  if(width===550) {
   for(const theme of ['light','dark']) {
    await page.locator(`[data-theme-choice=${theme}]`).click();
    await page.locator('#settings').screenshot({path:`/tmp/voidplayer-settings-tabs-portrait-${theme}-${name}.png`});
   }
   await page.locator('[data-theme-choice=light]').click();
  }
 }
 await page.setViewportSize({width:390,height:700});
 await page.locator('#settings-tab-logs').click();await page.locator('#settings').screenshot({path:`/tmp/voidplayer-settings-unified-mobile-${name}.png`});
 assert.equal(await page.locator('#settings-current-title').textContent(),'反馈');
 const headerBefore=await page.locator('.settings-floating-header').boundingBox();
 const closeBefore=await page.locator('#settings-close').boundingBox();
 assert.ok(Math.abs((closeBefore.y-headerBefore.y)-(headerBefore.x+headerBefore.width-closeBefore.x-closeBefore.width))<1,'mobile close button has equal top and right inset');
 await page.locator('#settings-pane-logs').evaluate(el=>{el.scrollTop=el.scrollHeight;});
 const headerAfter=await page.locator('.settings-floating-header').boundingBox();
 assert.ok(Math.abs(headerBefore.y-headerAfter.y)<1,'feedback glass header stays fixed while content scrolls');
 await page.locator('#settings-close').click();await page.locator('#settings').waitFor({state:'hidden'});await page.keyboard.press('Control+,');assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 await page.setViewportSize({width:1280,height:700});
 // The keyboard shortcut returns during settings-enter. Wait for its transform to
 // settle, then sample both rectangles in one frame before comparing their insets.
 await page.waitForFunction(()=>{
  const dialog=document.querySelector('#settings');
  return dialog.open&&!dialog.hasAttribute('data-closing')&&dialog.getAnimations().every(animation=>animation.playState==='finished');
 },null,{timeout:30000});
 const [desktopHeader,desktopClose]=await page.evaluate(()=>['.settings-floating-header','#settings-close'].map(selector=>document.querySelector(selector).getBoundingClientRect().toJSON()));
 assert.ok(Math.abs((desktopClose.y-desktopHeader.y)-(desktopHeader.x+desktopHeader.width-desktopClose.x-desktopClose.width))<1,'desktop close button has equal top and right inset');
 if (!process.argv.includes('--ui-only')) {
 await page.evaluate(async()=>{const tools=window.voidPlayer.tools,lib=await tools.find(t=>t.name==='list_library').execute({});await tools.find(t=>t.name==='load_library_item').execute({slot:'A',id:lib.entries.find(e=>e.name==='ci_h264_smoke.mp4').id});});
 await page.locator('#settings-tab-performance').click();
 for (const width of [1280, 791, 390]) {
  await page.setViewportSize({width,height:700});
  const runtime=await page.evaluate(()=>{
   const left=selector=>document.querySelector(selector).getBoundingClientRect().left;
   const rect=selector=>document.querySelector(selector).getBoundingClientRect();
   return {track:left('#color-runtime-tracks'),alignment:left('#alignment'),meta:left('.color-runtime-row .evidence'),rowRight:rect('#performance-current').right,decodeRight:rect('#decode').right};
  });
  assert.ok(Math.abs(runtime.alignment-runtime.track)<1,`${width}px runtime count alignment`);
  assert.ok(Math.abs(runtime.meta-runtime.track)<1,`${width}px runtime metadata alignment`);
  assert.ok(runtime.decodeRight<=runtime.rowRight-13,`${width}px runtime seek fits the card`);
 }
 await page.setViewportSize({width:1280,height:700});
 await page.locator('#benchmark').click();
 await page.waitForFunction(()=>document.querySelector('#benchmark-json').value.includes('voidplayer-playback-benchmark'),{},{timeout:20000});
 assert.equal(await page.locator('dialog[open]').count(),1);assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 assert.equal(await page.evaluate(()=>window.voidPlayer.getState().playing),false);
 assert.equal(await page.locator('#benchmark').isDisabled(),false);
 }
 await page.locator('#settings').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
 // A drag starting inside the window must not dismiss it when released outside.
 const bounds=await page.locator('#settings').boundingBox();
 await page.mouse.move(bounds.x+200,bounds.y+20);await page.mouse.down();await page.mouse.move(5,5);await page.mouse.up();
 assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 await page.mouse.click(5,5);await page.locator('#settings').waitFor({state:'hidden'});
 await page.locator('#settings-open').click();
 const closeColor=await page.locator('#settings-close').evaluate(e=>getComputedStyle(e).color);assert.notEqual(closeColor,'rgb(206, 57, 57)');
 await page.locator('#settings-close').hover();assert.equal(await page.locator('#settings-close').evaluate(e=>getComputedStyle(e).color),'rgb(206, 57, 57)');
 // Reopening during exit cancels the pending close, without a late close/focus jump.
 await page.locator('#settings-close').click();await page.keyboard.press('Control+,');
 await page.locator('#settings').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
 assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#settings-close').click();await page.locator('#settings').waitFor({state:'hidden'});
 await page.locator('#settings-open').click();assert.equal(await page.locator('#settings').evaluate(e=>e.getAnimations().length),0);
 await page.keyboard.press('Escape');await page.locator('#settings').waitFor({state:'hidden'});
 // Archived sessions remain selectable after reload, using the same menu inside the modal.
 await page.reload(); await page.locator('#settings-open').click(); await page.locator('#settings-tab-logs').click();
 await page.waitForFunction(()=>document.querySelector('.log-json').value.startsWith('{'));
 await page.locator('#log-session').click();
 await page.locator(`#log-session-menu [data-value="${originalSession}"]`).click();
 await page.waitForFunction(id=>document.querySelector('.log-json').dataset.sessionId===id,originalSession);
 assert.equal(await page.locator('.log-panel [data-action=refresh]').count(),0);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(id=>document.querySelector(`#log-session-menu [aria-checked=true]`)?.dataset.value===id,originalSession);
 await page.locator('#log-session').click(); await page.locator('#settings-tab-appearance').click();
 assert.equal(await page.locator('#log-session-menu').evaluate(e=>e.matches(':popover-open')),false,'switching panes closes the menu');
 assert.equal(await page.locator('#log-session-menu').evaluate(e=>e.getAnimations().length),0,'reduced motion disables fading');
 assert.equal(uploads,0);assert.deepEqual(errors,[]);console.log(`PASS ${name}: direct settings, seven persistent panes, unified geometry/material, Escape/focus/shortcut/navigation, log download without upload, narrow layouts`);
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
