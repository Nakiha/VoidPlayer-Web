import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../../../../server/config.ts';
import {AnnotationStore} from '../../../../server/annotations.ts';
import {startService} from '../../../../server/runtime.ts';
import {repositoryRoot} from '../../manifest.mjs';
import {withBrowserFixture} from '../../browser-fixture.mjs';
import {chooseTestGuest} from '../../../test-identity.mjs';
const engine=process.argv[2]??'chromium';
await withBrowserFixture({caseName:'i18n-admin',engine,pageOptions:{viewport:{width:1280,height:900},locale:'en-US',reducedMotion:'reduce'},dependencies:{startService:async({temp,defer})=>{
 await writeFile(path.join(temp,'voidplayer.config.json'),JSON.stringify({mediaRoots:[{id:'media',name:'素材 User',path:path.join(repositoryRoot,'fixtures/video')}],staticDir:path.join(repositoryRoot,'dist'),dataDir:'data',logsDir:'logs',indexWatch:false}));
 const config=await loadConfig([],'production',temp);config.port=0;
 const service=await startService(config);let closed=false;const close=async()=>{if(closed)return;closed=true;await service.close();};defer('partial-service',close);await service.library.refresh();
 return {...service,close,url:`http://127.0.0.1:${service.server.address().port}/`};
}}},async({page,context,url,artifact,temp,defer})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url+'admin');await chooseTestGuest(page);await page.locator('#identity').filter({hasText:/访客/}).waitFor();
 assert.equal(await page.locator('html').getAttribute('lang'),'en');assert.match(await page.title(),/Administration/);
 const annotations=new AnnotationStore(path.join(temp,'data/annotations.sqlite'));defer('seed-store',()=>annotations.close());
 const jpeg=await page.screenshot({type:'jpeg',quality:40});
 for(let i=0;i<53;i++){
  const id=`locale-mark-${i}`, document={media:[{id:'source-user',name:'用户 Video.mp4',size:10,lastModified:1,codec:'avc1',decoder:'webcodecs',width:320,height:180,durationUs:1000000,firstPtsUs:0,source:{kind:'library',id:'a'.repeat(24),url:url+'api/media/'+ 'a'.repeat(24)+'?v=fixture'}}],mark:{id,text:i===52?'':'用户评论 User '+i,severity:3,origin:'human',createdAt:'2026-10-03',slot:'A',mediaId:'source-user',frame:{ptsUs:0,sourcePtsUs:0,durationUs:40000},comparison:[],region:null,drawings:[]}};
  annotations.mutate('default',{operationId:id,id,revision:0,action:'put',document},{id:'user-author',name:'用户作者 User'});annotations.putPreview('default',id,1,jpeg);
 }
 await page.evaluate(async()=>{const r=await fetch('/api/logs',{method:'POST',headers:{'x-voidplayer-action':'log','content-type':'application/json'},body:JSON.stringify({schema:'voidplayer-web-log',sessionId:'i18n-admin',events:[{type:'test',text:'用户日志 User <tag>'}]})});if(!r.ok)throw new Error(await r.text());});
 const peer=await context.newPage();await peer.goto(url+'admin');
 async function locale(value){await peer.evaluate(value=>localStorage.setItem('voidplayer.language',value),value);await page.waitForFunction(value=>document.documentElement.lang===value,value);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
 await page.locator('[data-pane=library]').click();await page.locator('.admin-root-row').waitFor();
 await page.locator('#add-root').click();const row=page.locator('.admin-root-row').last();
 await row.locator('[data-field=name]').fill('未保存 User {name}');await row.locator('[data-field=path]').fill('/uncommitted/素材');
 await row.locator('[data-field=name]').evaluate(e=>{window.__root=e;window.__rootRow=e.closest('.admin-root-row');e.focus();e.setSelectionRange(2,6);});
 for(const value of ['zh-CN','en']){
  await locale(value);
  assert.deepEqual(await page.evaluate(()=>({same:window.__root===document.querySelector('.admin-root-row:last-child [data-field=name]'),row:window.__rootRow===window.__root.closest('.admin-root-row'),focus:document.activeElement===window.__root,value:window.__root.value,path:window.__rootRow.querySelector('[data-field=path]').value,selection:[window.__root.selectionStart,window.__root.selectionEnd],canSave:!document.querySelector('#save-roots').disabled})),{same:true,row:true,focus:true,value:'未保存 User {name}',path:'/uncommitted/素材',selection:[2,6],canSave:true});
 }
 assert.match(await row.locator('[data-field=name]').getAttribute('aria-label'),/Directory/);assert.match(await page.locator('#root-save-state').innerText(),/Unsaved/);
 await page.screenshot({path:artifact('admin-library-en-draft.png')});
 // A structured server conflict must preserve input and retain the raw diagnostic.
 await page.route('**/api/admin/roots',route=>route.request().method()==='PUT'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'原始配置原因',code:'configuration-changed'})}):route.continue());
 await page.locator('#save-roots').click();await page.locator('#admin-message').filter({hasText:'原始配置原因'}).waitFor();
 assert.match(await page.locator('#admin-message').innerText(),/draft is preserved/);await locale('zh-CN');assert.match(await page.locator('#admin-message').innerText(),/草稿仍保留/);assert.equal(await row.locator('[data-field=name]').inputValue(),'未保存 User {name}');
 await page.unroute('**/api/admin/roots');await page.locator('#reset-roots').click();await page.waitForFunction(()=>document.querySelectorAll('.admin-root-row').length===1);await locale('en');
 // Seed a real workspace via the current player facade and server API.
 const player=await context.newPage();await player.goto(url);await player.waitForFunction(()=>window.voidPlayer?.tools);await chooseTestGuest(player);
 await player.evaluate(async()=>{const document=window.voidPlayer.exportWorkspace();const response=await fetch('/api/workspaces',{method:'POST',headers:{'x-voidplayer-action':'workspace','content-type':'application/json'},body:JSON.stringify({name:'用户工作区 User <name>',document})});if(!response.ok)throw new Error(await response.text());});
 await page.locator('[data-pane=workspaces]').click();await page.locator('#admin-workspaces-list button').first().click();
 await page.locator('#admin-workspace-name').fill('未提交 rename {name}');await page.locator('#admin-workspace-delete').click();
 await page.locator('#admin-workspace-name').evaluate(e=>{window.__rename=e;window.__summary=document.querySelector('#admin-workspace-summary');window.__confirm=document.querySelector('#admin-workspace-delete-confirm');window.__workspaceJSON=document.querySelector('#admin-workspace-json').value;e.focus();e.setSelectionRange(1,4)});
 for(const value of ['zh-CN','en']){await locale(value);assert.deepEqual(await page.evaluate(()=>({input:window.__rename===document.querySelector('#admin-workspace-name'),summary:window.__summary===document.querySelector('#admin-workspace-summary'),confirm:window.__confirm===document.querySelector('#admin-workspace-delete-confirm'),open:!window.__confirm.hidden,focus:document.activeElement===window.__rename,value:window.__rename.value,selection:[window.__rename.selectionStart,window.__rename.selectionEnd],raw:window.__workspaceJSON===document.querySelector('#admin-workspace-json').value})),{input:true,summary:true,confirm:true,open:true,focus:true,value:'未提交 rename {name}',selection:[1,4],raw:true});}
 assert.match(await page.locator('#admin-workspace-summary').innerText(),/Creator|Last edited/);assert.match(await page.locator('#admin-workspace-delete-confirm').innerText(),/Delete/);assert.equal(await page.locator('#admin-workspaces-list strong').innerText(),'用户工作区 User <name>');
 await page.screenshot({path:artifact('admin-workspace-en-confirm.png')});
 await page.locator('#admin-workspace-cancel-delete').click();await page.locator('#admin-workspaces-search').fill('用户');await page.locator('#admin-workspaces-search-button').click();await page.locator('#admin-workspaces-list button').waitFor();
 await locale('zh-CN');assert.equal(await page.locator('#admin-workspaces-search').inputValue(),'用户');assert.equal(await page.locator('#admin-workspace-name').inputValue(),'未提交 rename {name}');await locale('en');
 // Real revision conflicts must save copies of the selected document, including maximum-length names.
 const copyCases=[];
 const selectedDocument=JSON.parse(await page.locator('#admin-workspace-json').inputValue());
 for(const language of ['en','zh-CN']){
  await locale(language);
  for(const length of [195,196,197,200]){
   const name='x'.repeat(length),suffix=language==='en'?' copy':' 副本';
   const original=await page.evaluate(async({document,name})=>{
    const response=await fetch('/api/workspaces',{method:'POST',headers:{'x-voidplayer-action':'workspace','content-type':'application/json'},body:JSON.stringify({name,document})});
    if(response.status!==201)throw new Error(await response.text());return response.json();
   },{document:selectedDocument,name:`conflict-${language}-${length}`});
   await page.locator('#admin-workspaces-search').fill(original.name);await page.locator('#admin-workspaces-search-button').click();
   await page.locator('#admin-workspaces-list button').filter({hasText:original.name}).click();
   await page.waitForFunction(name=>document.querySelector('#admin-workspace-name').value===name&&!document.querySelector('#admin-workspace-name').disabled,original.name);
   const newerDocument={...selectedDocument,positionUs:123};
   await page.evaluate(async({original,document})=>{
    const response=await fetch('/api/workspaces/'+original.id,{method:'PUT',headers:{'x-voidplayer-action':'workspace','content-type':'application/json','if-match':`"${original.revision}"`},body:JSON.stringify({name:'newer server copy',document})});
    if(!response.ok)throw new Error(await response.text());
   },{original,document:newerDocument});
   await page.locator('#admin-workspace-name').fill(name);
   const conflictResponse=page.waitForResponse(response=>response.url().endsWith('/api/workspaces/'+original.id)&&response.request().method()==='PUT');
   await page.locator('#admin-workspace-rename').click();assert.equal((await conflictResponse).status(),409);
   await page.locator('#admin-workspace-conflict').waitFor({state:'visible'});
   const copyResponse=page.waitForResponse(response=>response.url().endsWith('/api/workspaces')&&response.request().method()==='POST');
   await page.locator('#admin-workspace-copy').click();const response=await copyResponse;assert.equal(response.status(),201,`${language}: copy ${length}`);
   const copied=await response.json();assert.equal(copied.name,name.slice(0,200-suffix.length)+suffix);assert.notEqual(copied.id,original.id);
   await page.waitForFunction(name=>document.querySelector('#admin-workspace-name').value===name&&!document.querySelector('#admin-workspace-name').disabled,copied.name);
   const records=await page.evaluate(async ids=>Promise.all(ids.map(async id=>{const response=await fetch('/api/workspaces/'+id);if(!response.ok)throw new Error(await response.text());return response.json();})),[original.id,copied.id]);
   assert.equal(records[0].name,'newer server copy');assert.deepEqual(records[0].document,newerDocument);
   assert.deepEqual(records[1].document,selectedDocument);assert.equal(records[1].revision,1);
   assert.equal(await page.locator('#admin-workspace-conflict').isHidden(),true);
   copyCases.push({language,length,status:response.status(),copiedLength:copied.name.length});
  }
 }
 await locale('en');
 // Populated cache rows, pagination, search drafts and inline confirmation all relabel in place.
 await page.locator('[data-pane=caches]').click();await page.locator('#cache-total-count').filter({hasText:/cache/}).waitFor();
 await page.locator('[data-cache-kind=annotation-previews]').click();await page.waitForFunction(()=>document.querySelectorAll('.cache-row').length===50);await page.locator('#cache-more').click();await page.waitForFunction(()=>document.querySelectorAll('.cache-row').length===53);
 await page.locator('.cache-row[data-cache-id="locale-mark-52"] button').click();await page.locator('#cache-search').fill('draft search');await page.locator('#cache-search').evaluate(e=>{window.__cacheSearch=e;window.__cacheRow=document.querySelector('.cache-row');window.__cacheConfirm=document.querySelector('#cache-confirm');e.focus();e.setSelectionRange(1,4)});
 for(const value of ['zh-CN','en']){await locale(value);assert.deepEqual(await page.evaluate(()=>({search:window.__cacheSearch===document.querySelector('#cache-search'),row:window.__cacheRow===document.querySelector('.cache-row'),confirm:window.__cacheConfirm===document.querySelector('#cache-confirm'),open:!window.__cacheConfirm.hidden,count:document.querySelectorAll('.cache-row').length,focus:document.activeElement===window.__cacheSearch,value:window.__cacheSearch.value,selection:[window.__cacheSearch.selectionStart,window.__cacheSearch.selectionEnd],active:document.querySelector('[data-cache-kind="annotation-previews"]').getAttribute('aria-pressed')})),{search:true,row:true,confirm:true,open:true,count:53,focus:true,value:'draft search',selection:[1,4],active:'true'});}
 assert.match(await page.locator('#cache-confirm-text').innerText(),/Clear/);assert.equal(await page.locator('.cache-row strong').first().innerText(),'用户 Video.mp4');assert.match(await page.locator('.cache-row[data-cache-id="locale-mark-52"] .cache-row-content div > span').innerText(),/Frame mark/);await page.screenshot({path:artifact('admin-cache-en-confirm.png')});
 // Selected annotation, user text/author, image and an open delete confirmation survive too.
 await page.locator('[data-pane=annotations]').click();await page.locator('.admin-annotation-row').first().click();await page.locator('#admin-annotation-delete').click();
 await page.evaluate(()=>{window.__annotation=document.querySelector('#admin-annotation-detail');window.__preview=document.querySelector('#admin-annotation-image');window.__annotationConfirm=document.querySelector('#admin-annotation-confirm');window.__imageURL=window.__preview.src;});
 await locale('zh-CN');await locale('en');assert.equal(await page.evaluate(()=>window.__annotation===document.querySelector('#admin-annotation-detail')&&window.__preview===document.querySelector('#admin-annotation-image')&&window.__imageURL===window.__preview.src&&window.__annotationConfirm===document.querySelector('#admin-annotation-confirm')&&!window.__annotationConfirm.hidden),true);
 assert.match(await page.locator('#admin-annotation-author').innerText(),/用户作者 User.*Revision/);assert.equal(await page.locator('#admin-annotation-image').getAttribute('alt'),'Mark image');assert.equal(await page.locator('.admin-annotation-row strong').first().innerText(),'Frame mark');
 await page.screenshot({path:artifact('admin-annotation-en-confirm.png')});
 // Raw log JSON, textarea selection and pending delete retain the exact same nodes/data.
 await page.locator('[data-pane=logs]').click();await page.locator('#log-list button').first().click();await page.waitForFunction(()=>document.querySelector('#log-json').value.includes('用户日志 User <tag>'));await page.locator('#delete-log').click();
 await page.locator('#log-json').evaluate(e=>{window.__log=e;window.__logRaw=e.value;window.__logConfirm=document.querySelector('#delete-log-confirm');e.focus();e.setSelectionRange(4,12);});
 for(const value of ['zh-CN','en']){await locale(value);assert.deepEqual(await page.evaluate(()=>({node:window.__log===document.querySelector('#log-json'),raw:window.__logRaw===window.__log.value,confirm:window.__logConfirm===document.querySelector('#delete-log-confirm'),open:!window.__logConfirm.hidden,focus:document.activeElement===window.__log,selection:[window.__log.selectionStart,window.__log.selectionEnd]})),{node:true,raw:true,confirm:true,open:true,focus:true,selection:[4,12]});}
 assert.match(await page.locator('#delete-log-confirm').innerText(),/Delete/);await page.screenshot({path:artifact('admin-logs-en-confirm.png')});
 // Open radio menu retains its original options, keyboard focus and stable values.
 await page.locator('[data-pane=measurements]').click();await page.locator('#measure-kind').click();await page.locator('#measure-kind-menu [data-value=upload]').focus();
 await page.evaluate(()=>{window.__option=document.querySelector('#measure-kind-menu [data-value=upload]');window.__trigger=document.querySelector('#measure-kind');});
 await locale('zh-CN');assert.equal(await page.locator('#measure-kind-menu').evaluate(e=>e.matches(':popover-open')),true);assert.equal(await page.evaluate(()=>document.activeElement===window.__option),true);await locale('en');assert.match(await page.locator('#measure-kind-menu [data-value=upload]').innerText(),/Upload/);
 await page.keyboard.press('Escape');
 await page.locator('#measure-seconds').click();await page.locator('#measure-seconds-menu [data-value="5"]').click();
 // Hold actual transfer requests so the job is definitely running during switching.
 await page.route('**/api/admin/measurements/*/transfer',async route=>{await new Promise(resolve=>setTimeout(resolve,250));await route.continue().catch(()=>{});});
 await page.locator('#measure-start').click();await page.waitForFunction(()=>!document.querySelector('#measure-result').hidden&&document.querySelector('#measure-start').disabled);
 const before=(await (await page.request.get(url+'api/admin/measurements')).json()).job;assert.ok(['running','preparing'].includes(before.state));
 await page.evaluate(()=>{window.__result=document.querySelector('#measure-result');window.__start=document.querySelector('#measure-start')});
 await locale('zh-CN');assert.match(await page.locator('#measure-state').innerText(),/下载速度/);await locale('en');assert.match(await page.locator('#measure-state').innerText(),/Download/);
 const after=(await (await page.request.get(url+'api/admin/measurements')).json()).job;assert.equal(after.id,before.id);assert.equal(after.kind,before.kind);assert.equal(await page.evaluate(()=>window.__result===document.querySelector('#measure-result')&&window.__start===document.querySelector('#measure-start')),true);
 await page.screenshot({path:artifact('admin-measurement-en-running.png')});await page.locator('#measure-cancel').click();await page.waitForFunction(()=>!document.querySelector('#measure-start').disabled);
 await page.unroute('**/api/admin/measurements/*/transfer');
 await locale('zh-CN');await page.screenshot({path:artifact('admin-measurement-zh.png')});await locale('en');
 // All panels are included in the scoped source audit and English smoke pass.
 const checks=[];for(const pane of ['overview','library','caches','workspaces','annotations','logs','measurements']){await page.locator(`[data-pane=${pane}]`).click();await page.waitForTimeout(100);checks.push({pane,title:await page.locator(`#pane-${pane} h1`).innerText(),lang:await page.locator('html').getAttribute('lang')});}
 assert.deepEqual(errors,[]);await writeFile(artifact('report.json'),JSON.stringify({engine,checks,copyCases,rawDiagnostic:'preserved',state:['root draft','workspace rename','search','cache pagination/confirmation','selected annotation/preview','raw log/confirmation','radio menu','running measurement']},null,2));
 console.log(`PASS ${engine}: English initialization, live seven-panel copy, drafts/focus/selection, confirmation/search, open radio menu, raw conflict and running measurement preserved`);
});
