import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { webkit, chromium } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root=path.resolve(import.meta.dirname,'..'),name=process.argv[2]??'webkit';
const server=createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await(name==='chromium'?chromium:webkit).launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:700},colorScheme:'dark'}), errors=[];let uploads=0, originalSession='';
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/logs'))uploads++;});
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 assert.equal(await page.locator('#more-actions').count(),0);assert.equal(await page.locator('#help').count(),0);assert.equal(await page.locator('dialog.log-panel').count(),0);
 await page.locator('#settings-open').click();await page.locator('#settings').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));const geometry=await page.locator('#settings').boundingBox();
 assert.equal(await page.locator('#settings select').count(),0,'settings use shared choice menus');
 for(const pane of ['appearance','workspace','identity','shortcuts','logs','performance','about']) {
  await page.locator(`#settings-tab-${pane}`).click();assert.equal(await page.locator('[role=tabpanel]:visible').count(),1);assert.equal(await page.locator('dialog[open]').count(),1);
  assert.deepEqual(await page.locator('#settings').boundingBox(),geometry,'panes keep a stable window');
  assert.equal(await page.locator(`#settings-tab-${pane}`).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator(`#settings-pane-${pane}`).isVisible(),true);
  if(pane==='workspace') {
   for(const id of ['export','workspace-import']) {
    const size=await page.locator(`#${id}`).boundingBox();assert.ok(size.height<40,'workspace actions stay on one line');
   }
  }
  if(pane==='about') {
   const links=await page.locator('#settings-pane-about a').evaluateAll(es=>es.map(e=>e.getAttribute('href')));
   assert.ok(links.includes('https://github.com/Nakiha/VoidPlayer-Web'));
   for(const href of links.filter(h=>h.startsWith('/'))) { const response=await page.request.get(new URL(href,page.url()).href);assert.equal(response.status(),200);assert.ok(!(await response.text()).includes('<!doctype html>')); }
  }
  if(pane==='logs') {
   assert.equal(await page.locator('.log-panel details').count(),0);
   assert.equal(await page.locator('.log-json').isVisible(),true);
   const jsonBounds=await page.locator('.log-json').boundingBox();assert.ok(jsonBounds.height>200,'JSON fills the remaining desktop pane');assert.ok(Math.abs(jsonBounds.y+jsonBounds.height-(geometry.y+geometry.height-22))<2,'JSON extends to pane bottom padding');
   assert.equal(await page.locator('.log-panel [data-action=upload]').isVisible(),true);
   assert.equal(await page.locator('.log-panel .settings-group').count(),0);
   await page.waitForFunction(()=>document.querySelector('.log-panel textarea').value.startsWith('{'));
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
  if(pane==='logs') {
   await page.locator('#log-session').click();
   const menu=await page.locator('#log-session-menu').boundingBox(), trigger=await page.locator('#log-session').boundingBox();
   assert.ok(menu.width>=trigger.width && menu.x>=0 && menu.x+menu.width<=390,'narrow menu follows trigger and fits viewport');
   await page.keyboard.press('Escape');
  }
  const box=await page.locator('#settings').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390&&box.y>=0&&box.y+box.height<=700);
 }
 await page.locator('#settings-tab-logs').click();await page.locator('#settings').screenshot({path:`/tmp/voidplayer-settings-unified-mobile-${name}.png`});
 await page.locator('#settings-close').click();await page.locator('#settings').waitFor({state:'hidden'});await page.keyboard.press('Control+,');assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 await page.setViewportSize({width:1280,height:700});
 await page.evaluate(async()=>{const tools=window.voidPlayer.tools,lib=await tools.find(t=>t.name==='list_library').execute({});await tools.find(t=>t.name==='load_library_item').execute({slot:'A',id:lib.entries.find(e=>e.name==='ci_h264_smoke.mp4').id});});
 await page.locator('#settings-tab-performance').click();await page.locator('#benchmark').click();
 await page.waitForFunction(()=>document.querySelector('#benchmark-json').value.includes('voidplayer-playback-benchmark'),{},{timeout:20000});
 assert.equal(await page.locator('dialog[open]').count(),1);assert.equal(await page.locator('#settings').evaluate(e=>e.open),true);
 assert.equal(await page.evaluate(()=>window.voidPlayer.getState().playing),false);
 assert.equal(await page.locator('#benchmark').isDisabled(),false);
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
 await page.waitForFunction(()=>document.querySelector('.log-panel textarea').value.startsWith('{'));
 await page.locator('#log-session').click();
 await page.locator(`#log-session-menu [data-value="${originalSession}"]`).click();
 await page.waitForFunction(id=>JSON.parse(document.querySelector('.log-panel textarea').value).sessionId===id,originalSession);
 await page.locator('.log-panel [data-action=refresh]').click();
 await page.waitForFunction(id=>document.querySelector(`#log-session-menu [aria-checked=true]`)?.dataset.value===id,originalSession);
 await page.locator('#log-session').click(); await page.locator('#settings-tab-appearance').click();
 assert.equal(await page.locator('#log-session-menu').evaluate(e=>e.matches(':popover-open')),false,'switching panes closes the menu');
 assert.equal(await page.locator('#log-session-menu').evaluate(e=>e.getAnimations().length),0,'reduced motion disables fading');
 assert.equal(uploads,0);assert.deepEqual(errors,[]);console.log(`PASS ${name}: direct settings, seven persistent panes, unified geometry/material, Escape/focus/shortcut/navigation, log download without upload, narrow layouts`);
} finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
