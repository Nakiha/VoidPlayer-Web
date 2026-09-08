import assert from 'node:assert/strict';
import path from 'node:path';
import {webkit,chromium} from 'playwright';
import {createMediaServer} from '../server/app.ts';
const root=path.resolve(import.meta.dirname,'..'),server=createMediaServer({roots:[path.join(root,'fixtures/video')],staticDir:path.join(root,'dist'),onLog(){}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const name=process.argv[2]??'webkit',browser=await(name==='chromium'?chromium:webkit).launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1200,height:900},deviceScaleFactor:2});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.waitForFunction(()=>window.voidPlayer);
 const call=(name,args={})=>page.evaluate(({name,args})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),{name,args});
 const lib=await call('list_library');await call('load_library_item',{slot:'A',id:lib.entries.find(e=>e.name==='av1_10s_1920x1080.webm').id});
 for (const ptsUs of [0,1083000,3000000]) {
  await call('seek_review',{ptsUs});await page.locator('.brand').click();await page.keyboard.press('n');await page.locator('[data-drawing-tool=rect]').click();
  const r=await page.locator('#drawing-A').boundingBox();await page.mouse.move(r.x+r.width*.2,r.y+r.height*.2);await page.mouse.down();await page.mouse.move(r.x+r.width*.4,r.y+r.height*.5,{steps:6});await page.mouse.up();
  await page.waitForTimeout(220);await page.locator('#mark-close').click();
 }
 await page.locator('#toggle-subtracks').click();
 const identities=()=>page.locator('.track-marker').evaluateAll(nodes=>nodes.map(e=>({id:e.dataset.markId,color:e.style.getPropertyValue('--mark-color'),shape:e.querySelector('.mark-symbol').dataset.markShape})));
 const before=await identities();assert.equal(before.length,3);
 const savedMarks=JSON.stringify((await call('get_review_session')).marks);
 const colorToken=before[0].color.slice(4,-1);
 await page.evaluate(token=>document.documentElement.style.setProperty(token,'#eab866'),colorToken);
 for(const selector of ['.track-marker','.mark-entry']) {
  assert.equal(await page.locator(`${selector}[data-mark-id="${before[0].id}"] .mark-symbol`).evaluate(e=>getComputedStyle(e).color),'rgb(234, 184, 102)');
 }
 assert.equal(JSON.stringify((await call('get_review_session')).marks),savedMarks,'theme colors never alter saved drawings');
 await page.evaluate(token=>document.documentElement.style.removeProperty(token),colorToken);

 for(const identity of before) {
  const symbol=page.locator(`.mark-entry[data-mark-id="${identity.id}"] .mark-symbol`);
  assert.equal(await symbol.getAttribute('data-mark-shape'),identity.shape);assert.equal(await symbol.evaluate(e=>e.style.getPropertyValue('--mark-color')),identity.color);
  const marker=page.locator(`.track-marker[data-mark-id="${identity.id}"]`);await marker.hover();
  assert.equal(await marker.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.equal(await symbol.locator('> *').evaluate(e=>getComputedStyle(e).strokeWidth),'2px');
  assert.equal(await page.locator(`.annotation-row[data-mark-id="${identity.id}"]`).evaluate(e=>e.classList.contains('mark-linked-hover')),true);
  assert.equal(await page.locator('#subtrack-preview .mark-symbol').count(),0);
  const thumbnail=page.locator('#subtrack-preview .seek-preview-thumbnail');
  assert.equal(await thumbnail.getAttribute('data-mark-id'),identity.id);
  await thumbnail.evaluate(image=>image.decode());
  const imageRect=await thumbnail.boundingBox(),timeRect=await page.locator('#subtrack-preview time').boundingBox();
  assert.ok(imageRect.width>0 && imageRect.y+imageRect.height<=timeRect.y);
  if(process.env.MARK_CARDS_SCREENSHOT)await page.locator('#subtrack-preview').screenshot({path:`/tmp/voidplayer-mark-preview-${name}.png`});
 }
 await page.locator('#toggle-marks').click();await page.waitForTimeout(300);
 if(process.env.MARK_CARDS_SCREENSHOT)await page.screenshot({path:`/tmp/voidplayer-mark-cards-${name}.png`});
 assert.equal(await page.locator('.annotation-edit').count(),0);
 assert.equal(await page.locator('#marks-resize,.subtrack-tools').count(),0);
 const strip=await page.locator('.annotation-strip').boundingBox(), tracks=await page.locator('.subtrack-scroll').boundingBox();
 assert.ok(Math.abs(strip.x-tracks.x)<1 && tracks.y+tracks.height<=strip.y+1);
 const cards=await page.locator('.annotation-row').evaluateAll(rows=>rows.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
 assert.ok(cards.every(c=>c.y===cards[0].y && c.height>120 && c.width>=190),JSON.stringify(cards));
 assert.ok(cards[1].x>cards[0].x+cards[0].width);
 assert.equal(await page.locator('#subtrack-add-mark .icon').getAttribute('data-icon'),'plusRegular');
 assert.ok((await page.locator('.annotation-remove .icon').evaluateAll(nodes=>nodes.map(e=>e.dataset.icon))).every(icon=>icon==='trash'));
 await page.mouse.move(1195, 5);
 const backgrounds=await page.locator('.annotation-row').evaluateAll(rows=>rows.map(e=>getComputedStyle(e).backgroundColor));
 assert.ok(backgrounds.every(background=>background==='rgba(0, 0, 0, 0)'));
 for(const card of await page.locator('.annotation-row').all()) {
  assert.equal(await card.evaluate(e=>getComputedStyle(e).borderTopWidth),'0px');
  assert.equal(await card.evaluate(e=>getComputedStyle(e).boxShadow),'none');
  assert.equal(await card.locator('.mark-content img').count(),1);
  const geometry=await card.evaluate(e=>{const card=e.getBoundingClientRect();return [...e.querySelectorAll('button,img,time')].filter(n=>n.getBoundingClientRect().width).map(n=>{const r=n.getBoundingClientRect();return {tag:n.tagName,left:r.left,right:r.right,cardLeft:card.left,cardRight:card.right};});});assert.ok(geometry.every(r=>r.left>=r.cardLeft && r.right<=r.cardRight),JSON.stringify(geometry));
 }
 await page.locator('#toggle-marks').click();await page.locator('#toggle-marks').click();assert.deepEqual(await identities(),before);
 const id=before[1].id;await page.locator(`.mark-entry[data-mark-id="${id}"]`).click();
 await page.waitForFunction(()=>!window.voidPlayer.getState().busy && window.voidPlayer.getState().positionUs===1083000);
 assert.equal((await call('get_review_session')).positionUs,1083000);
 const mark=(await call('get_review_session')).marks.find(m=>m.id===id);
 await call('update_review_mark',{id,text:'检查边缘细节',drawings:mark.drawings});assert.deepEqual(await identities(),before);
 await page.locator(`.annotation-row[data-mark-id="${id}"] .mark-entry`).dblclick();await page.locator('#mark-close').waitFor({state:'visible'});await page.locator('#mark-close').click();

 await page.locator(`.annotation-row[data-mark-id="${id}"] .annotation-remove`).click();
 assert.equal((await call('get_review_session')).marks.length,3,'delete requires an explicit choice');
 await page.locator('.annotation-delete-confirm').click();assert.equal((await call('get_review_session')).marks.length,2);assert.equal(await page.locator(`.track-marker[data-mark-id="${id}"]`).count(),0);

 // A second track stays in the strip even when another track is selected.
 await call('load_library_item',{slot:'B',id:lib.entries.find(e=>e.name==='ci_h264_smoke.mp4').id});
 await call('seek_review',{ptsUs:1000000});
 const second=await call('add_review_mark',{slot:'B',text:'检查 B 轨道',drawings:[{id:'b-rect',tool:'rect',color:'#ff3b30',strokeWidth:3,points:[{x:.2,y:.2},{x:.5,y:.5}]}]});
 await call('set_review_track_offset',{slot:'B',offsetUs:250000});
 const target=second.frame.ptsUs+250000;
 assert.equal(await page.locator('#selected-marks .annotation-row').count(),3);
 await page.locator('.subtrack-name[data-drag-surface="A"]').click();
 assert.equal(await page.locator('#selected-marks .annotation-row').count(),3);
 await page.locator(`.annotation-row[data-mark-id="${second.id}"] .mark-entry`).dblclick();
 await page.locator('#mark-close').waitFor({state:'visible'});
 assert.equal((await call('get_review_session')).positionUs,target,'card seeks in session time including offset');
 assert.equal(await page.locator('#drawing-B .annotation-object[data-shape-id="b-rect"]').count(),1,'editing uses the owning track');
 await page.locator('#mark-close').click();
 assert.equal((await call('get_review_session')).marks.find(m=>m.id===second.id).frame.ptsUs,second.frame.ptsUs,'UI does not rewrite the saved media timestamp');
 await page.locator(`[data-mark-thumbnail="${second.id}"] img`).evaluate(image=>image.decode());
 assert.equal(await page.locator('.mark-content > img').count(),0,'late thumbnails stay in their dedicated image region');
 const ordered=await page.locator('#selected-marks .annotation-row').evaluateAll(rows=>rows.map(e=>e.dataset.markId));
 assert.equal(ordered[1],second.id,'all tracks share display-time order');
 await page.locator('#toggle-marks').click();
 assert.equal(await page.locator('#selected-marks img:visible').count(),0,'compact mode shows symbols only, including refreshed thumbnails');
 const compact=await page.locator('.annotation-strip').boundingBox();assert.equal(compact.height,44);
 const bSymbol=page.locator(`.mark-entry[data-mark-id="${second.id}"]`);
 await bSymbol.hover();await page.locator('#annotation-preview').waitFor({state:'visible'});
 const popup=await page.locator('#annotation-preview').boundingBox();assert.ok(popup.y+popup.height<compact.y,'hover card opens above the bottom strip');
 await page.locator('#annotation-preview .mark-thumbnail img').evaluate(image=>image.decode());
 await page.locator('#annotation-preview .annotation-remove').click();
 await page.locator('#annotation-preview').getByRole('button',{name:'取消',exact:true}).click();
 assert.equal((await call('get_review_session')).marks.length,3);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#annotation-preview').isVisible(),false);
 // Keyboard users can enter the floating card and return to its symbol.
 await bSymbol.focus();await page.keyboard.press('ArrowUp');
 assert.ok(await page.locator('#annotation-preview').evaluate(e=>e.contains(document.activeElement)));
 await page.keyboard.press('Escape');assert.equal(await bSymbol.evaluate(e=>e===document.activeElement),true);
 if(process.env.MARK_CARDS_SCREENSHOT) {
  await page.setViewportSize({width:1512,height:850});
  for(const scheme of ['light','dark']) {
   await page.emulateMedia({colorScheme:scheme});await page.mouse.move(1400,5);
   await page.screenshot({path:`/tmp/voidplayer-mark-strip-${scheme}-${name}.png`});
   await bSymbol.hover();await page.screenshot({path:`/tmp/voidplayer-mark-hover-${scheme}-${name}.png`});
   await page.locator('#toggle-marks').click();await page.mouse.move(1400,5);
   await page.screenshot({path:`/tmp/voidplayer-mark-cards-${scheme}-${name}.png`});
   await page.locator('#toggle-marks').click();
  }
 }
 await page.setViewportSize({width:480,height:800});await page.locator('#toggle-marks').click();
 const scroll=page.locator('#selected-marks');
 assert.ok(await scroll.evaluate(e=>e.scrollWidth>e.clientWidth),'cards scroll horizontally in a narrow window');
 await scroll.evaluate(e=>e.scrollLeft=e.scrollWidth);
 assert.ok(await scroll.evaluate(e=>e.scrollLeft>0));
 const right=await page.locator('.annotation-row').last().boundingBox();assert.ok(right.x+right.width<=480);
 assert.ok(await page.locator('#subtracks-panel,.annotation-strip').evaluateAll(nodes=>nodes.every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})),'dock and strip stay inside the narrow viewport');
 if(process.env.MARK_CARDS_SCREENSHOT)await page.screenshot({path:`/tmp/voidplayer-mark-cards-narrow-${name}.png`});
 await call('remove_review_track',{slot:'B'});
 assert.equal(await page.locator('#selected-marks .annotation-row').count(),2,'removing a track removes only its strip entries');
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: stable matching mark identities, 2px strokes, colored hover linkage, card layout/thumbnails, all-track ordering, offset seek/edit, confirmed delete, keyboard hover cards and responsive strip`);
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
