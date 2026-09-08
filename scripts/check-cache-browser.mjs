import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { webkit, chromium } from 'playwright';
import { loadConfig } from '../server/config.ts';
import { startService } from '../server/runtime.ts';
import { AnnotationStore } from '../server/annotations.ts';
import { syntheticFlv } from '../test/flv-fixture.ts';
import { demuxFlv, FlvReader } from '../src/flv-demux.ts';
import { serializeFlvIndex } from '../src/flv-index-cache.ts';
const root=path.resolve(import.meta.dirname,'..'),temp=await mkdtemp(path.join(os.tmpdir(),'vp-cache-browser-')),name=process.argv[2]??'webkit';
let service,browser,annotations;
try {
 const media=path.join(temp,'media');await mkdir(media);const flv=syntheticFlv();
 await writeFile(path.join(media,'现场拍摄_镜头03_第一轮评审.flv'),flv);
 await writeFile(path.join(temp,'voidplayer.config.json'),JSON.stringify({mediaRoots:[{id:'qa',name:'拍摄素材',path:media}],dataDir:'data',logsDir:null,staticDir:path.join(root,'dist'),indexWatch:false}));
 const config=await loadConfig([],'production',temp);config.port=0;service=await startService(config);await service.library.refresh();await new Promise(r=>setTimeout(r,1100));await service.library.refresh();
 const base=`http://127.0.0.1:${service.server.address().port}`,entry=service.library.browse().entries[0];
 const reader=new FlvReader({file:new Blob([flv])}),index=serializeFlvIndex(await demuxFlv(reader),flv.length);reader.close();
 service.library.frameIndexes.put(entry.id,entry.version,entry.size,index,0);
 browser=await(name==='chromium'?chromium:webkit).launch({headless:true});const context=await browser.newContext({viewport:{width:1512,height:850},colorScheme:'dark'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const jpeg=await page.screenshot({type:'jpeg',quality:50});
 annotations=new AnnotationStore(path.join(config.dataDir,'annotations.sqlite'));
 for(let i=0;i<53;i++){
  const id=`mark-${i}`,document={media:[{id:'media',name:i===0?'极长的媒体名称_'.repeat(18)+'.flv':'现场拍摄_镜头03.flv',size:flv.length,lastModified:1,codec:'avc1',decoder:'webcodecs',width:320,height:180,durationUs:1000000,firstPtsUs:0,source:{kind:'library',id:entry.id,url:`${base}/api/media/${entry.id}?v=${entry.version}`}}],mark:{id,text:i===0?'留意这里的光影，调整下一版调色':'检查边缘细节与画面色彩',severity:3,origin:'human',createdAt:'2026-09-08',slot:'A',mediaId:'media',frame:{ptsUs:0,sourcePtsUs:0,durationUs:40000},comparison:[],region:null,drawings:[]}};
  annotations.mutate('default',{operationId:`create-${id}`,id,revision:0,action:'put',document},{id:'reviewer',name:'剪辑师'});annotations.putPreview('default',id,1,jpeg);
 }
 const before=await page.request.get(base+'/api/admin/caches').then(r=>r.json());assert.equal(before.count,54);assert.ok(before.volume.availableBytes>0);assert.ok(before.types.every(t=>t.location.startsWith(config.dataDir)));
 assert.equal((await page.request.delete(base+'/api/admin/caches/annotation-previews',{data:{all:true}})).status(),403);
 await page.goto(base+'/admin');await page.locator('[data-pane=caches]').click();await page.locator('.cache-row').waitFor();
 assert.equal(await page.locator('[data-pane=frame-indexes]').count(),0);assert.equal(await page.locator('#cache-total-count').textContent(),'54 个缓存');
 for(const scheme of ['dark','light']){await page.emulateMedia({colorScheme:scheme});await page.waitForFunction(s=>document.documentElement.dataset.theme===s,scheme);await page.screenshot({path:`/tmp/voidplayer-caches-frames-${scheme}-${name}.png`});}
 await page.locator('[data-cache-kind=annotation-previews]').click();await page.waitForFunction(()=>document.querySelectorAll('.cache-row').length===50);await page.locator('#cache-more').click();await page.waitForFunction(()=>document.querySelectorAll('.cache-row').length===53);
 await page.locator('#cache-search').fill('光影');await page.locator('#cache-search-form button').click();await page.waitForFunction(()=>document.querySelectorAll('.cache-row').length===1);
 await page.screenshot({path:`/tmp/voidplayer-caches-previews-light-${name}.png`});
 await page.locator('#cache-location summary').click();await page.screenshot({path:`/tmp/voidplayer-caches-location-${name}.png`});await page.locator('#cache-location summary').click();
 await page.locator('#cache-search').fill('没有的关键词');await page.locator('#cache-search-form button').click();await page.getByText('没有匹配的缓存',{exact:true}).waitFor();
 await page.locator('#cache-search').fill('');await page.locator('#cache-search-form button').click();await page.waitForFunction(()=>document.querySelectorAll('.cache-row').length===50);
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await page.screenshot({path:`/tmp/voidplayer-caches-narrow-${name}.png`});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
 await page.setViewportSize({width:1512,height:850});
 // A stale single-entry deletion must not remove a newly generated preview.
 await page.locator('.cache-row button').first().click();const target=await page.locator('.cache-row').first().getAttribute('data-cache-id');const current=annotations.read('default',target);
 annotations.mutate('default',{operationId:'edit-preview',id:target,revision:1,action:'put',document:{...current.document,mark:{...current.document.mark,text:'更新后的标注'}}},{id:'reviewer',name:'剪辑师'});annotations.putPreview('default',target,2,jpeg);
 await page.locator('#cache-confirm-clear').click();await page.locator('#admin-message').filter({hasText:'预览已更新'}).waitFor();assert.ok(annotations.preview('default',target,2));await page.locator('#cache-cancel').click();
 const epoch=annotations.previewEpoch;await page.locator('#cache-clear').click();await page.locator('#cache-confirm-clear').click();await page.getByText('暂无标注预览缓存',{exact:true}).waitFor();
 assert.equal(annotations.list('default').count,53);assert.equal(service.library.frameIndexes.list().count,1);assert.throws(()=>annotations.putPreview('default',target,2,jpeg,epoch),/已被清理/);
 await page.locator('[data-cache-kind=frame-indexes]').click();await page.locator('.cache-row').waitFor();await page.locator('.cache-row button').click();await page.locator('#cache-confirm-clear').click();await page.getByText('暂无帧索引缓存',{exact:true}).waitFor();
 assert.equal(service.library.browse().entries.length,1);assert.equal(annotations.list('default').count,53);assert.throws(()=>service.library.frameIndexes.put(entry.id,entry.version,entry.size,index,0),/已被清理/);
 const after=await page.request.get(base+'/api/admin/caches').then(r=>r.json());assert.equal(after.bytes,0);assert.equal(after.count,0);assert.ok(after.types.every(t=>t.databaseBytes+t.journalBytes>0));assert.deepEqual(errors,[]);
 console.log(`PASS ${name}: cache overview, real disk usage, locations, pagination/search, stale deletion, isolated clears, uploads and responsive screenshots`);
}finally{annotations?.close();await browser?.close();await service?.close();await rm(temp,{recursive:true,force:true});}
