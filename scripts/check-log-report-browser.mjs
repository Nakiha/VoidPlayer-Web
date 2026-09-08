import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {webkit,chromium} from 'playwright';
import {createMediaServer} from '../server/app.ts';
const name=process.argv[2]??'webkit',logsDir=await mkdtemp(path.join(os.tmpdir(),'vp-report-'));
const server=createMediaServer({roots:[],staticDir:path.resolve('dist'),logsDir,onLog(){}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await(name==='webkit'?webkit:chromium).launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1512,height:982},colorScheme:'dark'}),errors=[];let uploads=0;
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/logs'))uploads++;});
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.route('**/log-migration-seed',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
 await page.goto(`${origin}/log-migration-seed`);
 await page.evaluate(async()=>{
   await new Promise((resolve,reject)=>{
     const request=indexedDB.open('voidplayer-diagnostics',1);
     request.onupgradeneeded=()=>request.result.createObjectStore('sessions',{keyPath:'sessionId'});
     request.onerror=()=>reject(request.error);
     request.onsuccess=()=>{
       const db=request.result,tx=db.transaction('sessions','readwrite'),time=new Date(Date.now()-3600000).toISOString();
       tx.objectStore('sessions').put({schema:'voidplayer-web-log',version:1,sessionId:'migration-large-history',startedAt:time,updatedAt:time,environment:{},capacity:2000,droppedEvents:0,
         events:Array.from({length:2000},(_,i)=>({seq:i+1,tMs:i,level:'info',cat:'media',msg:`seed ${i}`,data:{details:Array(10).fill('x'.repeat(700))}}))});
       tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
     };
   });
 });
 await page.goto(`${origin}/`);
 const open=async()=>{await page.locator('#settings-open').click();await page.locator('#settings-tab-logs').click();await page.waitForFunction(()=>document.querySelector('.log-json').value.startsWith('{')&&!document.querySelector('.log-panel').matches('[aria-busy=true]'));};
 const read=async()=>{
   const downloaded=page.waitForEvent('download');await page.locator('.log-panel [data-action=download]').click();
   const report=JSON.parse(await readFile(await(await downloaded).path(),'utf8'));
   await page.waitForFunction(()=>document.querySelector('.log-panel').getAttribute('aria-busy')==='false');
   return report;
 };
 await open();const session=(await read()).sessionId;
 await page.locator('#log-session').click();await page.locator('#log-session-menu [data-value="migration-large-history"]').click();
 await page.waitForFunction(()=>document.querySelector('.log-json').dataset.sessionId==='migration-large-history'&&document.querySelector('.log-panel').getAttribute('aria-busy')==='false');
 assert.ok((await page.locator('.log-json').inputValue()).length<=24000);
 assert.match(await page.locator('.log-preview-status').textContent(),/80/);
 assert.equal((await read()).events.length,2000,'schema 1 migration and bounded preview preserve the complete report');
 await page.locator('[data-page=previous]').click();assert.match(await page.locator('.log-preview-status').textContent(),/79\/80/);
 await page.locator('#log-session').click();await page.locator(`#log-session-menu [data-value="${session}"]`).click();
 await page.waitForFunction(id=>document.querySelector('.log-json').dataset.sessionId===id&&document.querySelector('.log-panel').getAttribute('aria-busy')==='false',session);
 const description='定位到 00:05 后画面停止，声音仍继续。\n复现：打开视频 → 拖动进度 → 播放。<不应执行 HTML>';
 const previewBefore=await page.locator('.log-json').inputValue();
 await page.locator('#log-description').fill(description);
 assert.equal(await page.locator('.log-json').inputValue(),previewBefore,'typing does not rewrite the event preview');
 assert.ok(previewBefore.length<=24000);
 assert.equal((await read()).report.description,description);
 assert.ok(!JSON.stringify((await read()).events).includes(description));
 assert.equal(uploads,0);assert.equal((await readdir(logsDir)).length,0,'editing remains local');
 await page.locator('#settings-close').click();await page.locator('#settings').waitFor({state:'hidden'});await open();
 assert.equal(await page.locator('#log-description').inputValue(),description);
 await page.locator('.log-panel [data-action=refresh]').click();await page.waitForFunction(()=>document.querySelector('.log-panel').getAttribute('aria-busy')==='false');
 assert.equal((await read()).report.description,description);
 for(const theme of ['dark','light']){
  await page.locator('#settings-tab-appearance').click();await page.locator(`[data-theme-choice=${theme}]`).click();await page.locator('#settings-tab-logs').click();
  await page.waitForFunction(()=>document.querySelector('.log-panel').getAttribute('aria-busy')==='false');
  assert.ok(await page.locator('#settings-pane-logs').evaluate(el=>el.scrollHeight<=el.clientHeight+1),'no outer scrolling on a 14-inch desktop viewport');
  assert.equal(await page.locator('.log-feedback').isVisible(),false);
  await page.locator('#settings').screenshot({path:`/tmp/voidplayer-log-report-${theme}-${name}.png`});
 }
 await page.locator('#log-help-toggle').click();assert.equal(await page.locator('#log-help').evaluate(el=>el.matches(':popover-open')),true);await page.keyboard.press('Escape');
 assert.equal(await page.locator('#settings').evaluate(el=>el.open),true);
 const downloaded=page.waitForEvent('download');void downloaded.catch(()=>{});await page.locator('.log-panel [data-action=download]').click();
 const document=JSON.parse(await readFile(await(await downloaded).path(),'utf8'));
 assert.equal(document.report.description,description);assert.equal(document.sessionId,session);assert.equal(uploads,0);
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedReport=text;}}}));
 await page.locator('.log-panel [data-action=copy]').click();await page.waitForFunction(()=>window.copiedReport);
 assert.equal(JSON.parse(await page.evaluate(()=>window.copiedReport)).report.description,description);
 await page.route('**/api/logs',route=>route.abort());await page.locator('.log-panel [data-action=upload]').click();
 await page.waitForFunction(()=>document.querySelector('.log-result').textContent.includes('无法连接'));
 assert.equal(await page.locator('#log-description').inputValue(),description);assert.equal((await readdir(logsDir)).length,0);
 await page.unroute('**/api/logs');await page.locator('.log-panel [data-action=upload]').click();
 await page.waitForFunction(()=>document.querySelector('.log-result').textContent.includes('已上传'));
 const files=await readdir(logsDir);assert.equal(files.length,1);
 const stored=JSON.parse(await readFile(path.join(logsDir,files[0]),'utf8'));
 assert.equal(stored.report.description,description);assert.equal(stored.sessionId,session);assert.ok(stored.serverReceipt);
 await page.locator('#log-description').fill('');assert.ok(!('report' in await read()));
 await page.setViewportSize({width:390,height:700});
 assert.ok(await page.locator('#settings-pane-logs').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await page.locator('#settings').screenshot({path:`/tmp/voidplayer-log-report-mobile-${name}.png`});
 await page.reload();await open();assert.equal(await page.locator('#log-description').inputValue(),'');
 const current=(await read()).sessionId;assert.notEqual(current,session);
 await page.locator('#log-description').fill('新会话描述');
 await page.locator('#log-session').click();await page.locator(`#log-session-menu [data-value="${session}"]`).click();
 await page.waitForFunction(id=>document.querySelector('.log-json').dataset.sessionId===id,session);
 assert.equal(await page.locator('#log-description').inputValue(),'','drafts never leak between sessions');
 await page.locator('#log-description').fill('历史会话描述');
 await page.locator('#log-session').click();await page.locator(`#log-session-menu [data-value="${current}"]`).click();
 await page.waitForFunction(id=>document.querySelector('.log-json').dataset.sessionId===id,current);
 assert.equal(await page.locator('#log-description').inputValue(),'新会话描述');
 assert.deepEqual(errors,[]);console.log(`PASS ${name}: bounded preview/download/copy/upload, failed-upload retention, session isolation, no automatic upload, desktop themes and mobile layout`);
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(logsDir,{recursive:true,force:true});}
