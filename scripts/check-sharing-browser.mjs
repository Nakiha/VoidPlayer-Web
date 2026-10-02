import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {loadConfig} from '../server/config.ts';
import {startService} from '../server/runtime.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'vp-workspace-sharing-'));
const name=process.argv[2]??'webkit';let service,browser;
const evidence=path.resolve('.run/workspace-sharing-browser-'+name);await mkdir(evidence,{recursive:true});
const call=(page,name,args={})=>page.evaluate(({name,args})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),{name,args});
const settings=async page=>{if(!await page.locator('#settings').evaluate(e=>e.open))await page.locator('#settings-open').click();await page.locator('#settings-tab-workspace').click();await page.waitForFunction(()=>!document.querySelector('#saved-workspace-name').disabled);};
try{
  await mkdir(path.join(root,'media'));
  const video=Buffer.from(await readFile(new URL('../test/http-smoke.mp4.base64',import.meta.url),'utf8'),'base64');
  await writeFile(path.join(root,'media/sample.mp4'),video);await writeFile(path.join(root,'media/alternate.mp4'),video);
  const config=await loadConfig(['--folder',path.join(root,'media'),'--data-dir',path.join(root,'data')],'production');config.port=0;config.logsDir=null;
  service=await startService(config);await service.library.refresh();config.port=service.server.address().port;
  const base=`http://127.0.0.1:${config.port}`;
  browser=await(name==='chromium'?chromium:webkit).launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
  const watch=p=>p.on('pageerror',e=>errors.push(e.message));watch(page);
  await page.addInitScript(()=>Object.defineProperty(navigator.clipboard,'writeText',{value:async value=>{window.testClipboard=value;}}));
  await page.goto(base);await page.locator('#identity-welcome [data-guest]').click();
  let lib;for(let i=0;i<100;i++){lib=await call(page,'list_library');if(lib.entries.length===2 && lib.entries.every(e=>e.state==='ready'))break;await new Promise(r=>setTimeout(r,100));}
  for(const [slot,file] of [['A','sample.mp4'],['B','alternate.mp4']])await call(page,'load_library_item',{slot,id:lib.entries.find(e=>e.name===file).id});
  await call(page,'seek_review',{ptsUs:200000});await page.evaluate(()=>window.voidPlayer.setViewport({mode:'split',zoom:1.3}));
  const removed=await call(page,'add_review_mark',{slot:'A',text:'分享期间删除'}),mark=await call(page,'add_review_mark',{slot:'A',text:'这一帧需要讨论'});
  await page.waitForFunction(()=>document.querySelector('#annotation-save-state').dataset.state==='saved');
  assert.equal((await page.request.get(base+'/api/annotations/spaces/default').then(r=>r.json())).entries.length,0);
  await settings(page);await page.locator('#saved-workspace-name').fill('画质对比');await page.locator('#settings-close').click();
  let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/workspaces/share',async route=>{await gate;await route.continue();});
  await page.locator('#workspace-share').click();await page.waitForFunction(()=>document.querySelector('#workspace-share').getAttribute('aria-busy')==='true');
  await page.evaluate(id=>window.voidPlayer.deleteMark(id),removed.id);
  const later=await call(page,'add_review_mark',{slot:'A',text:'分享期间新增'});
  await page.waitForFunction(()=>document.querySelector('#annotation-save-state').dataset.state==='saved');release();
  await page.waitForFunction(()=>!!window.testClipboard && document.querySelector('#workspace-share').getAttribute('aria-busy')==='false');
  const link=await page.evaluate(()=>window.testClipboard),id=new URL(link).searchParams.get('workspace');assert.ok(id);
  assert.equal(await page.locator('dialog[open]').count(),0,'one click shares without a wizard');assert.equal(await page.locator('#review-sharing,#review-context').count(),0);
  const record=await page.request.get(base+'/api/workspaces/'+id).then(r=>r.json());assert.equal(record.name,'画质对比');assert.equal(record.document.marks.length,0);assert.equal(record.document.positionUs,200000);
  await page.screenshot({path:path.join(evidence,'01-one-click-sharing.png')});
  const recipient=await browser.newContext({viewport:{width:1280,height:900}}),other=await recipient.newPage();watch(other);
  await other.goto(link);await other.locator('#identity-welcome [data-guest]').click();
  await other.waitForFunction(id=>window.voidPlayer?.getState().marks.some(m=>m.id===id) && !window.voidPlayer.getState().busy,later.id);
  assert.ok(!(await call(other,'get_review_session')).marks.some(m=>m.id===removed.id),'sharing must not resurrect a deletion');
  const restored=await other.evaluate(()=>window.voidPlayer.exportWorkspace());assert.equal(restored.positionUs,200000);assert.equal(restored.viewport.mode,'split');assert.equal(restored.viewport.zoom,1.3);assert.equal(restored.tracks.length,2);
  if(!await other.locator('#subtracks-panel').isVisible())await other.locator('#toggle-subtracks').click();await other.locator('#toggle-marks').click();
  await call(other,'seek_review',{ptsUs:0});await other.locator(`[data-discuss-mark="${mark.id}"]`).click();await other.locator('[aria-label="回复内容"]').fill('可以直接在工作区里讨论');await other.getByRole('button',{name:'发送回复',exact:true}).click();await other.getByRole('button',{name:'关闭讨论',exact:true}).click();
  await page.waitForFunction(id=>window.voidPlayer.getState().marks.find(m=>m.id===id)?.replies?.length===1,mark.id);assert.equal((await call(other,'get_review_session')).positionUs,0);
  // A recipient writes back with the ordinary save control, no progress publishing.
  await call(other,'seek_review',{ptsUs:400000});await call(other,'remove_review_track',{slot:'B'});
  await settings(other);await other.locator('#saved-workspace-save').click();await other.waitForFunction(()=>!document.querySelector('#saved-workspace-name').disabled);
  const updated=await other.request.get(base+'/api/workspaces/'+id).then(r=>r.json());assert.equal(updated.revision,2);assert.equal(updated.document.positionUs,400000);assert.equal(updated.document.tracks.length,1);
  assert.equal((await call(page,'get_review_session')).positionUs,200000,'another save does not move the current playback view');
  // Concurrent changes remain explicit instead of silently overwriting.
  await settings(page);await page.locator('#saved-workspace-save').click();await page.locator('#saved-workspace-conflict').waitFor({state:'visible'});assert.equal((await page.request.get(base+'/api/workspaces/'+id).then(r=>r.json())).revision,2);
  await page.locator('#saved-workspace-reload').click();await page.waitForFunction(()=>window.voidPlayer.getState().positionUs===400000 && !window.voidPlayer.getState().busy);assert.equal((await call(page,'get_review_session')).tracks.length,1);
  await page.waitForFunction(id=>window.voidPlayer.getState().marks.some(m=>m.id===id),mark.id);
  await page.evaluate(id=>window.voidPlayer.deleteMark(id),mark.id);await other.waitForFunction(id=>!window.voidPlayer.getState().marks.some(m=>m.id===id),mark.id);
  await other.locator('#settings-close').click();await other.reload();await other.waitForFunction(()=>window.voidPlayer?.getState().tracks.length===1&&!window.voidPlayer.getState().busy);await other.waitForFunction(id=>window.voidPlayer.getState().marks.some(m=>m.id===id),later.id);
  assert.ok(!(await call(other,'get_review_session')).marks.some(m=>m.id===mark.id),'opening the link reads current annotations');
  // Sharing again saves to the existing workspace and copies the same address.
  await page.locator('#workspace-share').click();await page.waitForFunction(()=>document.querySelector('#workspace-share').getAttribute('aria-busy')==='false');assert.equal(await page.evaluate(()=>window.testClipboard),link);
  assert.equal((await page.request.get(base+'/api/workspaces?all=1').then(r=>r.json())).entries.length,1);
  await other.reload();await other.waitForFunction(()=>window.voidPlayer?.getState().tracks.length===1&&!window.voidPlayer.getState().busy);
  // Clipboard fallback is the only share dialog, with just a selectable link.
  await other.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{value:async()=>{throw new Error('denied');}}));await other.locator('#workspace-share').click();await other.locator('#workspace-share-link').waitFor({state:'visible'});
  assert.equal(await other.locator('[aria-label="工作区链接"]').inputValue(),link);assert.equal(await other.locator('#review-history,#review-snapshot,#review-publish').count(),0);
  for(const scheme of ['light','dark']){await other.emulateMedia({colorScheme:scheme});await other.screenshot({path:path.join(evidence,`02-${scheme}.png`)});}
  await other.setViewportSize({width:390,height:844});assert.ok(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await other.screenshot({path:path.join(evidence,'03-narrow.png')});await other.getByRole('button',{name:'关闭分享',exact:true}).click();
  await service.close();service=await startService(config);await service.library.refresh();await other.reload();await other.waitForFunction(()=>window.voidPlayer?.getState().positionUs===400000&&!window.voidPlayer.getState().busy);await other.waitForFunction(id=>window.voidPlayer.getState().marks.some(m=>m.id===id),later.id);
  // Source deletion makes the saved link show a missing source, not an immutable copy.
  await rm(path.join(root,'media/sample.mp4'));await service.library.refresh();await other.reload();await other.waitForFunction(()=>window.voidPlayer?.getState().tracks[0]?.pendingRelink && !window.voidPlayer.getState().busy);
  assert.deepEqual(errors,[]);console.log(`PASS ${name}: one-click writable sharing, source/position/layout restoration, recipient saves, conflicts, live annotations/deletion, same URL, clipboard, restart and missing sources`);
}finally{await browser?.close();await service?.close();await rm(root,{recursive:true,force:true});}
