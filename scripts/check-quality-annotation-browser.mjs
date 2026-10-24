import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {loadConfig} from '../server/config.ts';
import {startService} from '../server/runtime.ts';
import {waitForAnnotationMedia,annotationWorkspacePlayable} from './testing/agent-annotations-ready.mjs';
import {chooseTestGuest} from './test-identity.mjs';
import {recordBrowserEvidence,saveBrowserFailure} from './browser-failure-evidence.mjs';

const root=path.resolve(import.meta.dirname,'..'),temp=await mkdtemp(path.join(os.tmpdir(),'vp-quality-annotation-ui-'));
const engine=process.argv[2]??'chromium',directory=process.env.VOIDPLAYER_TEST_ARTIFACTS??path.join(root,'.run/quality-annotation',engine);
let service,browser,page,evidence,phase='setup';
try {
 await mkdir(directory,{recursive:true});const mediaDir=path.join(temp,'media');await mkdir(mediaDir);
 const sample=JSON.parse(await readFile(path.join(root,'test/helpers/quality-http-samples.json'),'utf8')).samples.find(s=>s.codec==='h264'&&s.depth===8&&s.tagged);
 await writeFile(path.join(mediaDir,'B.flv'),Buffer.from(sample.flv,'base64'));
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','30','-c:v','libx264','-preset','ultrafast','-bf','0','-g','10','-pix_fmt','yuv420p','-movflags','+faststart',path.join(mediaDir,'A.mp4')]);
 await writeFile(path.join(temp,'voidplayer.config.json'),JSON.stringify({mediaRoots:[mediaDir],dataDir:'data',staticDir:path.join(root,'dist'),logsDir:null,indexWatch:false}));
 const config=await loadConfig([],'production',temp);config.port=0;service=await startService(config);await service.library.refresh();
 const entries=await waitForAnnotationMedia(service.library,['A.mp4','B.flv']);
 const base=`http://127.0.0.1:${service.server.address().port}`;
 const identity=await fetch(base+'/api/identity',{method:'POST',headers:{origin:base,'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'PSNR reviewer'})});assert.equal(identity.status,200);
 const cookie=identity.headers.get('set-cookie').split(';')[0],headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'annotation'};
 const entry=entries[1],built=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`).then(r=>r.json());
 const proof=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}}).then(r=>r.json());
 const target=au=>({...proof.binding,sourcePtsUs:built.index.packets[au][2],picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
 const submit=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'x-voidplayer-action':'quality-job','idempotency-key':'browser-evidence'},body:JSON.stringify({schema:'voidplayer-psnr-frame-job',version:1,client:{id:'browser-acceptance',kind:'agent'},request:{pairing:'caller-specified',reference:target(0),distorted:target(1),roi:{x:2,y:4,width:24,height:20}}})});assert.equal(submit.status,202);let job=(await submit.json()).job;
 for(let n=0;n<200&&!['completed','failed','interrupted','cancelled'].includes(job.state);n++){await new Promise(r=>setTimeout(r,25));job=await fetch(`${base}/api/quality/jobs/${job.id}`,{headers:{cookie}}).then(r=>r.json());}assert.equal(job.state,'completed',JSON.stringify(job));
 const source={id:'snapshot-B',name:'B.flv',size:entry.size,lastModified:entry.lastModified,codec:'avc1',decoder:'ffmpeg-wasm',width:32,height:32,durationUs:2000000,firstPtsUs:target(0).sourcePtsUs,source:{kind:'library',id:entry.id,url:`${base}/api/media/${entry.id}?v=${entry.version}`}};
 const document={schema:'voidplayer-workspace',version:1,name:'PSNR evidence',generatedAt:new Date().toISOString(),serverUrl:base,positionUs:0,tracks:[{slot:'A',mediaId:source.id,offsetUs:0}],media:[source],marks:[],viewport:{},layout:{panels:{inspector:false,subtracks:true,sources:false},selected:'A',dockHeight:300,marksExpanded:true}};
 const response=await fetch(base+'/api/workspaces/share',{method:'POST',headers:{...headers,'x-voidplayer-action':'workspace'},body:JSON.stringify({name:'PSNR evidence',document})});assert.equal(response.status,201);const workspace=await response.json(),space=workspace.space;
 const annotation={mark:{id:'mark-B',text:'Existing B observation',severity:3,origin:'agent',createdAt:new Date().toISOString(),slot:'H',mediaId:source.id,frame:{ptsUs:0,sourcePtsUs:target(0).sourcePtsUs,durationUs:1000000},comparison:[],region:null},media:[source]};
 const post=async op=>{const r=await fetch(`${base}/api/annotations/spaces/${space}`,{method:'POST',headers,body:JSON.stringify(op)});assert.equal(r.status,200,await r.clone().text());return r.json();};
 await post({operationId:'create-B',id:'mark-B',revision:0,action:'put',document:annotation});
 browser=await ({chromium,webkit}[engine]).launch({headless:true});const owner=await browser.newContext({locale:'en-US',viewport:{width:1280,height:900}});
 await owner.addCookies([{name:'voidplayer-user',value:cookie.split('=')[1],url:base}]);
 await owner.addInitScript(()=>window.addEventListener('voidplayer-annotation-status',event=>{window.__annotationStatus=event.detail;}));
 page=await owner.newPage();evidence=recordBrowserEvidence(page);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`${base}/?workspace=${workspace.id}`);await chooseTestGuest(page);await page.waitForFunction(annotationWorkspacePlayable);await page.waitForFunction(()=>window.voidPlayer.getState().marks.some(m=>m.id==='mark-B'));
 const observerContext=await browser.newContext({locale:'en-US',viewport:{width:1280,height:900}}),observer=await observerContext.newPage();
 await observer.goto(`${base}/?workspace=${workspace.id}`);await chooseTestGuest(observer);await observer.waitForFunction(annotationWorkspacePlayable);
 const a=entries[0];await observer.evaluate(async url=>{const blob=await fetch(url).then(r=>r.blob());await window.voidPlayer.loadFile('A',new File([blob],'A.mp4'));},`${base}/api/media/${a.id}?v=${a.version}`);
 await observer.waitForFunction(()=>!window.voidPlayer.getState().busy&&window.voidPlayer.getState().tracks[0]?.frame&&window.voidPlayer.getState().marks.length===0);
 await observer.locator('#play').focus();await observer.evaluate(()=>window.voidPlayer.play());await observer.waitForFunction(()=>window.voidPlayer.getState().playing&&window.voidPlayer.getState().positionUs>200000);
 const beforeObserver=await observer.evaluate(()=>window.voidPlayer.getState());await observer.route('**/api/annotations/events/*',r=>r.abort());

 phase='gui-attach-while-other-window-plays';
 const before=await page.evaluate(()=>window.voidPlayer.getState());
 await page.locator('[data-mark-id="mark-B"] .annotation-attach-psnr').click();
 const dialog=page.getByRole('dialog',{name:'Attach completed PSNR result'});await dialog.locator('input[name=jobId]').fill(job.id);await dialog.getByRole('button',{name:'Preview result',exact:true}).click();
 await dialog.getByRole('button',{name:'Share on annotation',exact:true}).waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('.quality-evidence-dialog button:last-of-type').disabled);
 const attachmentBodies=[];
 await page.route(`**/api/annotations/spaces/${space}`,async route=>{
  if(route.request().method()!=='POST'||JSON.parse(route.request().postData()).action!=='attach-quality-result')return route.continue();
  attachmentBodies.push(route.request().postData());
  if(attachmentBodies.length===1){const committed=await route.fetch();assert.equal(committed.status(),200);return route.abort('failed');}
  return route.continue();
 });
 await dialog.getByRole('button',{name:'Share on annotation',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.quality-evidence-dialog [role=status]')?.textContent.includes('Retry uses operation'));
 await dialog.getByRole('button',{name:'Share on annotation',exact:true}).click();await dialog.waitFor({state:'detached'});
 await page.unroute(`**/api/annotations/spaces/${space}`);assert.equal(attachmentBodies.length,2);assert.equal(attachmentBodies[0],attachmentBodies[1],'GUI lost-response retry preserves the exact operation ID/body');
 await page.waitForFunction(()=>window.voidPlayer.getState().marks[0]?.qualityEvidence?.length===1);
 const after=await page.evaluate(()=>window.voidPlayer.getState());assert.equal(after.positionUs,before.positionUs);assert.equal(after.playing,before.playing);assert.deepEqual(after.tracks.map(t=>[t.slot,t.id]),before.tracks.map(t=>[t.slot,t.id]));
 await observer.unroute('**/api/annotations/events/*');await observer.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await observer.waitForFunction(()=>document.querySelector('#annotation-activity')?.textContent.includes('PSNR'));
 const observed=await observer.evaluate(()=>window.voidPlayer.getState());assert.equal(observed.playing,true);assert.ok(observed.positionUs>beforeObserver.positionUs);assert.deepEqual(observed.tracks.map(t=>[t.slot,t.id]),beforeObserver.tracks.map(t=>[t.slot,t.id]));assert.equal(observed.marks.length,0);assert.equal(await observer.evaluate(()=>document.activeElement.id),'play');
 assert.equal(owner.pages().length,1);assert.equal(observerContext.pages().length,1);
 const privateAccess=await observer.evaluate(async id=>(await fetch(`/api/quality/jobs/${id}/result`)).status,job.id);assert.equal(privateAccess,404);
 await page.locator('[data-mark-id="mark-B"] .annotation-psnr-evidence').click();const facts=page.getByRole('dialog',{name:'PSNR evidence',exact:true});await facts.waitFor();assert.match(await facts.textContent(),/Verified by the originating service/);assert.match(await facts.textContent(),/cpu-number-sse-v1/);await page.screenshot({path:path.join(directory,'verified-evidence.png')});await facts.getByRole('button',{name:'Close',exact:true}).click();

 phase='agent-same-command-and-lost-response';
 const attach={space,id:'mark-B',revision:2,operationId:'agent-attach',evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:'reference'}};
 const agentReceipt=await page.evaluate(async input=>window.voidPlayer.tools.find(t=>t.name==='attach_annotation_psnr').execute(input),attach);assert.equal(agentReceipt.revision,3);
 const replay=await page.evaluate(async input=>window.voidPlayer.tools.find(t=>t.name==='attach_annotation_psnr').execute(input),attach);assert.deepEqual(replay,agentReceipt);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(()=>window.voidPlayer.getState().marks[0]?.qualityEvidence?.length===2);
 await page.evaluate(()=>window.voidPlayer.tools.find(t=>t.name==='update_review_mark').execute({id:'mark-B',reply:'Reply preserves both attachments'}));
 await page.waitForFunction(async space=>{const record=await fetch(`/api/annotations/spaces/${space}/mark-B`).then(r=>r.json());return record.revision===4&&record.document.mark.replies?.length===1&&record.document.mark.qualityEvidence?.length===2;},space);
 await page.waitForFunction(space=>window.__annotationStatus?.space===space&&window.__annotationStatus.state==='saved',space);
 const backup=await page.evaluate(()=>window.voidPlayer.exportWorkspace());assert.equal(backup.version,2);assert.equal(backup.marks[0].qualityEvidence.length,2);
 await page.evaluate(document=>window.voidPlayer.importWorkspace(document),backup);await page.waitForFunction(()=>window.voidPlayer.getState().marks[0]?.qualityEvidence?.[0]?.verification==='historical');
 assert.equal((await page.evaluate(()=>window.voidPlayer.exportReview())).version,2);
 await page.locator('[data-mark-id="mark-B"] .annotation-psnr-evidence').click();assert.match(await page.getByRole('dialog',{name:'PSNR evidence',exact:true}).textContent(),/Historical copy/);await page.getByRole('dialog',{name:'PSNR evidence',exact:true}).getByRole('button',{name:'Close',exact:true}).click();

 phase='late-reply-after-space-and-track-change';
 // Reload the shared scope, capture a confirmed write's reply, then change the
 // local scene/scope before delivering it. The server target must stay pinned.
 await page.goto(`${base}/?workspace=${workspace.id}`);await page.waitForFunction(annotationWorkspacePlayable);await page.waitForFunction(()=>window.voidPlayer.getState().marks[0]?.qualityEvidence?.length===2);await page.waitForFunction(space=>window.__annotationStatus?.space===space&&window.__annotationStatus.state==='saved',space);
 await page.locator('[data-mark-id="mark-B"] .annotation-attach-psnr').click();const lateDialog=page.getByRole('dialog',{name:'Attach completed PSNR result'});
 await lateDialog.locator('input[name=jobId]').fill(job.id);await lateDialog.getByRole('button',{name:'Preview result',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.quality-evidence-dialog button:last-of-type').disabled);
 let release,held;const heldReply=new Promise(resolve=>held=resolve),released=new Promise(resolve=>release=resolve);
 await page.route(`**/api/annotations/spaces/${space}`,async route=>{if(route.request().method()!=='POST'||JSON.parse(route.request().postData()).action!=='attach-quality-result')return route.continue();const result=await route.fetch();assert.equal(result.status(),200);held();await released;await route.fulfill({response:result});});
 await lateDialog.getByRole('button',{name:'Share on annotation',exact:true}).click();await heldReply;
 const empty={...backup,marks:[],tracks:[],media:[]};await page.evaluate(document=>window.voidPlayer.importWorkspace(document),empty);release();await lateDialog.waitFor({state:'detached'});
 assert.equal((await page.evaluate(()=>window.voidPlayer.getState())).marks.length,0);assert.equal((await page.evaluate(()=>window.voidPlayer.getState())).tracks.length,0);
 const stored=await fetch(`${base}/api/annotations/spaces/${space}/mark-B`).then(r=>r.json());assert.equal(stored.document.mark.qualityEvidence.length,3);
 assert.deepEqual(errors,[]);console.log(`PASS ${engine}: real job → HTTP/GUI/Agent evidence, two windows/reconnect/playback isolation, export downgrade, late scope/track reply`);
} catch(error){if(page)await saveBrowserFailure({page:page.isClosed()?undefined:page,directory,name:'quality-annotation',context:{caseName:'quality-annotation',engine,phase},error,evidence,extra:{annotationStatus:await page.evaluate(()=>window.__annotationStatus).catch(()=>null),drafts:await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('voidplayer-annotations');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const r=db.transaction('drafts').objectStore('drafts').getAll();r.onsuccess=()=>resolve(r.result.map(d=>({key:d.key,space:d.space,id:d.id,base:d.base,conflict:d.conflict})));r.onerror=()=>reject(r.error);});}finally{db.close();}}).catch(()=>null)}}).catch(()=>{});throw error;}
finally{await browser?.close();await service?.close();await rm(temp,{recursive:true,force:true});}
