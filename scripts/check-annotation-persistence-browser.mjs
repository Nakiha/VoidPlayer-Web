import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {webkit,chromium} from 'playwright';
import {loadConfig} from '../server/config.ts';
import {startService} from '../server/runtime.ts';
const root=path.resolve(import.meta.dirname,'..'), temp=await mkdtemp(path.join(os.tmpdir(),'vp-annotation-sync-'));
const name=process.argv[2]??'webkit';let service,browser;
async function until(read, ready){const deadline=Date.now()+20000;while(Date.now()<deadline){const value=await read();if(ready(value))return value;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for persisted server state');}
try {
 await writeFile(path.join(temp,'voidplayer.config.json'),JSON.stringify({mediaRoots:[{id:'qa',name:'QA',path:path.join(root,'fixtures/video')}],dataDir:'data',logsDir:null,staticDir:path.join(root,'dist'),indexWatch:false}));
 const config=await loadConfig([],'production',temp);config.port=0;service=await startService(config);await service.library.refresh();
 const base=`http://127.0.0.1:${service.server.address().port}`;
 browser=await(name==='chromium'?chromium:webkit).launch({headless:true});
 const context=await browser.newContext({viewport:{width:1512,height:850},colorScheme:'dark'}), errors=[];
 context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 const call=(page,name,args={})=>page.evaluate(({name,args})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),{name,args});
 const open=async()=>{const page=await context.newPage();await page.goto(base);await page.waitForFunction(()=>window.voidPlayer);const lib=await call(page,'list_library');await call(page,'load_library_item',{slot:'A',id:lib.entries.find(e=>e.name==='ci_h264_smoke.mp4').id});return page;};
 const a=await open(),b=await open();
 const mark=await call(a,'add_review_mark',{slot:'A',text:'持久化标注'});
 await b.waitForFunction(id=>window.voidPlayer.getState().marks.some(mark=>mark.id===id),mark.id);
 assert.equal((await call(b,'get_review_session')).marks[0].text,'持久化标注');
 await a.reload();await a.waitForFunction(()=>window.voidPlayer);const lib=await call(a,'list_library');await call(a,'load_library_item',{slot:'A',id:lib.entries.find(e=>e.name==='ci_h264_smoke.mp4').id});
 await a.waitForFunction(id=>window.voidPlayer.getState().marks.some(mark=>mark.id===id),mark.id);
 const entries=await a.request.get(base+'/api/annotations/spaces/default').then(r=>r.json());assert.equal(entries.entries.length,1);

 // Hold only B's write path offline while A deletes the shared record.
 await b.route('**/api/annotations/spaces/default',route=>route.request().method()==='POST'?route.abort():route.continue());
 await call(b,'update_review_mark',{id:mark.id,text:'离线编辑草稿'});
 await b.waitForFunction(()=>document.querySelector('#annotation-save-state').dataset.tooltip?.includes('本机'));
 const actor=(await a.request.get(base+'/api/health').then(r=>r.json())).actor;
 const del=await a.request.post(base+'/api/annotations/spaces/default',{headers:{origin:base,'x-voidplayer-action':'annotation','x-voidplayer-actor':actor.id},data:{operationId:'delete-from-admin',id:mark.id,revision:1,action:'delete'}});assert.equal(del.status(),200);
 await b.unroute('**/api/annotations/spaces/default');
 await b.waitForFunction(()=>document.querySelector('#annotation-save-state').dataset.state==='error');
 await b.locator('#toggle-subtracks').click();await b.locator('#annotation-save-state').click();
 await b.locator('.annotation-conflict').waitFor();
 assert.ok((await call(b,'get_review_session')).marks.some(mark=>mark.text==='离线编辑草稿'),'conflicting draft survives remote deletion');
 await b.getByRole('button',{name:'草稿另存为标注',exact:true}).click();
 await b.locator('.annotation-conflict').waitFor({state:'hidden'});
 await b.locator('#annotation-sync-dialog [aria-label="关闭标注保存"]').click();
 await a.waitForFunction(()=>window.voidPlayer.getState().marks.some(mark=>mark.text==='离线编辑草稿'));
 const afterConflict=await a.request.get(base+'/api/annotations/spaces/default').then(r=>r.json());
 assert.equal(afterConflict.entries.filter(entry=>!entry.deleted).length,1);
 assert.equal(afterConflict.entries.find(entry=>entry.id===mark.id).deleted,true);
 const copy=afterConflict.entries.find(entry=>!entry.deleted);
 // Data management uses the same versioned write path and cannot move playback.
 const position=(await call(a,'get_review_session')).positionUs;
 const admin=await context.newPage();await admin.goto(base+'/admin');await admin.locator('[data-pane=annotations]').click();
 await admin.locator(`[data-annotation-id="${copy.id}"]`).click();
 assert.equal(await admin.locator('#admin-annotation-text').textContent(),'离线编辑草稿');
 await admin.locator('#admin-annotation-delete').click();await admin.locator('#admin-annotation-confirm-delete').click();
 await admin.locator('#admin-annotations-trash').click();await admin.locator(`[data-annotation-id="${copy.id}"]`).click();await admin.locator('#admin-annotation-restore').click();
 await admin.locator('#admin-annotations-active').click();await admin.locator(`[data-annotation-id="${copy.id}"]`).click();
 assert.equal((await call(a,'get_review_session')).positionUs,position);
 for(const scheme of ['dark','light']){await admin.emulateMedia({colorScheme:scheme});await admin.waitForFunction(s=>document.documentElement.dataset.theme===s,scheme);await admin.screenshot({path:`/tmp/voidplayer-annotation-admin-${scheme}-${name}.png`});}
 await b.locator('#annotation-save-state').click();await b.screenshot({path:`/tmp/voidplayer-annotation-save-${name}.png`});
 await b.locator('#annotation-sync-dialog [aria-label="关闭标注保存"]').click();
 // Existing old workspaces must not overwrite current shared revisions.
 const saved=await call(a,'export_workspace');await a.evaluate(value=>window.voidPlayer.importWorkspace(value),saved);
 assert.equal((await a.request.get(base+'/api/annotations/spaces/default').then(r=>r.json())).entries.find(entry=>entry.id===copy.id).revision,3);
 // Lose an acknowledgement after the server commits, then reload the writer.
 let lost=false;
 await b.route('**/api/annotations/spaces/default',async route=>{if(route.request().method()==='POST' && !lost){lost=true;await route.fetch();await route.abort();}else await route.continue();});
 const retry=await call(b,'add_review_mark',{slot:'A',text:'响应丢失重试'});
 await until(()=>b.request.get(base+'/api/annotations/spaces/default').then(r=>r.json()),page=>page.entries.some(e=>e.id===retry.id));
 await b.reload();await b.waitForFunction(()=>window.voidPlayer);const retryLib=await call(b,'list_library');await call(b,'load_library_item',{slot:'A',id:retryLib.entries.find(e=>e.name==='ci_h264_smoke.mp4').id});
 await b.waitForFunction(()=>document.querySelector('#annotation-save-state').dataset.state==='saved');
 const retried=await b.request.get(base+'/api/annotations/spaces/default').then(r=>r.json());assert.equal(retried.entries.find(e=>e.id===retry.id).revision,1);await b.unroute('**/api/annotations/spaces/default');
 // Generate a real thumbnail through the editor and verify it reaches the cache separately.
 await b.locator('.brand').click();await b.keyboard.press('n');await b.locator('[data-drawing-tool=rect]').click();
 const rectangle=await b.locator('#drawing-A').boundingBox();await b.mouse.move(rectangle.x+rectangle.width*.2,rectangle.y+rectangle.height*.2);await b.mouse.down();await b.mouse.move(rectangle.x+rectangle.width*.4,rectangle.y+rectangle.height*.5,{steps:6});await b.mouse.up();await b.locator('#mark-close').click();
 const previews=await until(()=>b.request.get(base+'/api/admin/caches/annotation-previews').then(r=>r.json()),page=>page.entries.length>0);const preview=previews.entries[0];
 const response=await b.request.get(base+preview.previewUrl);assert.equal(response.status(),200);assert.ok((await response.body()).length<128*1024);
 await admin.locator('[data-pane=annotations]').click();await admin.locator(`[data-annotation-id="${preview.id}"]`).click();await admin.locator('#admin-annotation-image').evaluate(img=>img.decode());
 await admin.screenshot({path:`/tmp/voidplayer-annotation-preview-${name}.png`});
 const downloadPromise=admin.waitForEvent('download');await admin.locator('#admin-annotation-export').click();const download=await downloadPromise;const exported=JSON.parse(await readFile(await download.path(),'utf8'));assert.equal(exported.schema,'voidplayer-workspace');assert.ok(exported.marks[0].drawings.length);
 const link=await admin.locator('#admin-annotation-open').getAttribute('href');const opened=await context.newPage();await opened.goto(base+link);await opened.waitForFunction(id=>window.voidPlayer?.getState().marks.some(m=>m.id===id),preview.id);await opened.waitForFunction(()=>document.querySelector('#annotation-save-state').dataset.tooltip?.startsWith('共享评审'));await opened.close();
 // A rejected local write must retain the in-memory draft and retry, never report success.
 await b.evaluate(()=>{const put=IDBObjectStore.prototype.put;window.rejectDraftWrites=true;IDBObjectStore.prototype.put=function(...args){if(this.name==='drafts' && window.rejectDraftWrites)throw new DOMException('Disk full','QuotaExceededError');return put.apply(this,args);};});
 const quota=await call(b,'add_review_mark',{slot:'A',text:'本机写入失败后恢复'});await b.waitForFunction(()=>document.querySelector('#annotation-save-state').dataset.tooltip?.includes('本机保存失败'));assert.ok((await call(b,'get_review_session')).marks.some(m=>m.id===quota.id));
 await b.evaluate(()=>{window.rejectDraftWrites=false;window.dispatchEvent(new Event('focus'));});await until(()=>b.request.get(base+'/api/annotations/spaces/default').then(r=>r.json()),page=>page.entries.some(e=>e.id===quota.id));
 // Restart the actual service, keeping its data and address; confirmed revisions and JPEG survive.
 const port=service.server.address().port;await service.close();service=undefined;config.port=port;service=await startService(config);await service.library.refresh();
 const restored=await b.request.get(base+'/api/annotations/spaces/default').then(r=>r.json());assert.ok(restored.entries.some(e=>e.id===retry.id));assert.equal((await b.request.get(base+preview.previewUrl)).status(),200);
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: shared sync, reload, offline conflicting edit/delete, safe copy, admin restore, snapshot isolation, lost acknowledgement, editor preview, export and service restart`);
}finally{await browser?.close();await service?.close();await rm(temp,{recursive:true,force:true});}
