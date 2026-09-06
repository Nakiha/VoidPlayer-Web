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
 await page.mouse.move(1195, 5);
 const backgrounds=await page.locator('.annotation-row').evaluateAll(rows=>rows.map(e=>getComputedStyle(e).backgroundColor));
 assert.equal(backgrounds[0],backgrounds[2]);assert.notEqual(backgrounds[0],backgrounds[1]);
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
 await page.locator(`.annotation-row[data-mark-id="${id}"] .annotation-edit`).click();await page.locator('#mark-close').waitFor({state:'visible'});await page.locator('#mark-close').click();
 if(process.env.MARK_CARDS_SCREENSHOT) {
  const grip=page.locator('#dock-resize');const b=await grip.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2,b.y-220,{steps:8});await page.mouse.up();
  await page.locator('#selected-marks').evaluate(e=>e.scrollTop=0);await page.mouse.move(1195,5);
  await page.screenshot({path:`/tmp/voidplayer-mark-cards-${name}.png`});
 }
 await page.locator(`.annotation-row[data-mark-id="${id}"] .annotation-remove`).click();assert.equal((await call('get_review_session')).marks.length,2);assert.equal(await page.locator(`.track-marker[data-mark-id="${id}"]`).count(),0);
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: stable matching mark identities, 2px strokes, colored hover linkage, card layout/thumbnails, edit/seek/delete and collapse`);
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
