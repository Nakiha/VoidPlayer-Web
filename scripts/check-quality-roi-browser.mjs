import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import {ssimOracle} from '../test/helpers/ssim-oracle.mjs';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {loadConfig} from '../server/config.ts';
import {startService} from '../server/runtime.ts';
import {waitForAnnotationMedia} from './testing/agent-annotations-ready.mjs';
import {recordBrowserEvidence,saveBrowserFailure} from './browser-failure-evidence.mjs';
const root=path.resolve(import.meta.dirname,'..'),engine=process.argv[2]??'chromium',depth=Number(process.argv[3]??8),temp=await mkdtemp(path.join(tmpdir(),'vp-quality-roi-'));
const directory=process.env.VOIDPLAYER_TEST_ARTIFACTS??path.join(root,'.run/quality-roi',`${engine}-${depth}`);
let service,browser,page,evidence,phase='setup',heldGate;const gates=[],liveWorkers=new Set();
const openRoi=async()=>{if(!await page.locator('#quality-roi-open').isVisible())await page.locator('#toggle-sources').click();await page.locator('#quality-roi-open').click();};
const progress=setInterval(()=>console.log(JSON.stringify({qualityRoi:true,engine,depth,phase})),10000).unref();
try{
 await mkdir(directory,{recursive:true});const media=path.join(temp,'media');await mkdir(media);
 const sample=JSON.parse(await readFile(path.join(root,'test/helpers/quality-http-samples.json'),'utf8')).samples.find(s=>s.depth===depth&&s.codec===(depth===8?'h264':'hevc')&&s.tagged);
 for(const name of ['B.flv','C.flv'])await writeFile(path.join(media,name),Buffer.from(sample.flv,'base64'));
 if(engine==='chromium'&&depth===8)execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','120','-c:v','libx264','-threads','1','-preset','ultrafast','-bf','0','-g','10','-pix_fmt','yuv420p','-movflags','+faststart',path.join(media,'A.mp4')]);
 await writeFile(path.join(temp,'voidplayer.config.json'),JSON.stringify({mediaRoots:[media],dataDir:'data',staticDir:path.join(root,'dist'),logsDir:null,indexWatch:false}));
 const config=await loadConfig([],'production',temp);config.port=0;service=await startService(config);await service.library.refresh();
 const entries=await waitForAnnotationMedia(service.library,['B.flv','C.flv']),base=`http://127.0.0.1:${service.server.address().port}`;
 const response=await fetch(base+'/api/identity',{method:'POST',headers:{origin:base,'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'ROI owner'})});assert.equal(response.status,200);
 const cookie=response.headers.get('set-cookie').split(';')[0],actor=(await response.json()).actor,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'workspace'};
 for(const e of entries)assert.equal((await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}&build=1`)).status,200);
 const sources=entries.map((e,i)=>({id:`source-${i}`,name:e.name,size:e.size,lastModified:e.lastModified,codec:sample.codec,decoder:'ffmpeg-wasm',width:32,height:32,durationUs:2000000,firstPtsUs:2000000,source:{kind:'library',id:e.id,url:`${base}/api/media/${e.id}?v=${e.version}`}}));
 const document={schema:'voidplayer-workspace',version:1,name:'ROI shared',generatedAt:new Date().toISOString(),serverUrl:base,positionUs:0,tracks:sources.map((s,i)=>({slot:i?'B':'A',mediaId:s.id,offsetUs:0})),media:sources,marks:[],viewport:{},layout:{panels:{inspector:false,subtracks:true,sources:false},selected:'A',dockHeight:250,marksExpanded:true}};
 const shared=await fetch(base+'/api/workspaces/share',{method:'POST',headers,body:JSON.stringify({name:'ROI shared',document})});assert.equal(shared.status,201);const workspace=await shared.json();
 browser=await({chromium,webkit}[engine]).launch({headless:true});const context=await browser.newContext({locale:'en-US',viewport:{width:1400,height:1000},deviceScaleFactor:2});context.setDefaultTimeout(30000);
 await context.addCookies([{name:'voidplayer-user',value:actor.id,url:base}]);
 // Observe actual Worker output, not a mock decoder or DOM screenshot oracle.
 await context.addInitScript(()=>{const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);this.addEventListener('message',event=>{const r=event.data?.result;if(r?.frames&&r?.provenance)window.__roiRaw=r.frames.map(f=>Array.from(f.pixels));});}};});
 page=await context.newPage();evidence=recordBrowserEvidence(page);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const ready=p=>p.waitForFunction(()=>{const s=window.voidPlayer?.getState();if(s?.tracks.some(t=>t.failure))throw new Error(JSON.stringify(s.tracks));return s&&!s.busy&&s.tracks.length===2&&s.tracks.every(t=>t.frame&&!t.pendingRelink);});
 phase='player-load';await page.goto(`${base}/?workspace=${workspace.id}`);await ready(page);await page.waitForFunction(id=>JSON.parse(localStorage.getItem('voidplayer.identity')??'null')?.id===id,actor.id);
 const observerContext=await browser.newContext({locale:'en-US',viewport:{width:1280,height:900}}),observer=await observerContext.newPage();let privateReads=0;observer.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/quality/jobs'))privateReads++;});
 const guest=await observerContext.request.post(base+'/api/identity',{headers:{origin:base,'x-voidplayer-action':'identity'},data:{guest:true}});assert.equal(guest.status(),200);
 await observer.goto(`${base}/?workspace=${workspace.id}`);await ready(observer);
 await page.evaluate(()=>window.voidPlayer.setViewport({mode:'split',zoom:2,offsetX:40,offsetY:-20,splitPos:0.37}));const beforeView=await page.evaluate(()=>window.voidPlayer.getViewport());
 const before=await page.evaluate(()=>window.voidPlayer.getState()),beforePeer=await observer.evaluate(()=>window.voidPlayer.getState());
 phase='explicit-au-and-independent-snapshots';await openRoi();
 await page.locator('[data-roi-au="0"] option[value="0"]').waitFor({state:'attached'});await page.locator('[data-roi-au="1"] option[value="1"]').waitFor({state:'attached'});
 await page.locator('[data-roi-au="0"]').selectOption('0');await page.locator('[data-roi-au="1"]').selectOption('1');
 await page.addStyleTag({content:'.quality-roi-stage[data-roi-stage="0"]{height:283px;aspect-ratio:auto!important}'});await page.locator('#quality-roi-verify').click();await page.locator('#quality-roi-form').waitFor({state:'visible'});
 const raw=Buffer.from(sample.native,'base64'),frame=raw.length/2;assert.deepEqual(await page.evaluate(()=>window.__roiRaw),[Array.from(raw.subarray(0,frame)),Array.from(raw.subarray(frame))]);
 assert.ok((await page.locator('[data-roi-stage]').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.presentedCommit)))).every(n=>n>0));
 await page.locator('[data-roi-stage="0"]').scrollIntoViewIfNeeded();const bounds=await page.locator('[data-roi-stage="0"]').boundingBox(),edge=Math.min(bounds.width,bounds.height),box={x:bounds.x+(bounds.width-edge)/2,y:bounds.y+(bounds.height-edge)/2,width:edge,height:edge};assert.ok(bounds.width>edge+20,'letterboxing is real, so stage bounds cannot stand in for source pixels');
 await page.mouse.move(box.x+box.width*2/32,box.y+box.height*4/32);await page.mouse.down();await page.mouse.move(box.x+box.width*26/32,box.y+box.height*24/32);await page.mouse.up();
 const roi={};for(const key of ['x','y','width','height'])roi[key]=Number(await page.locator(`#quality-roi-form [name=${key}]`).inputValue());assert.deepEqual(roi,{x:2,y:4,width:24,height:20});
 for(const svg of await page.locator('.quality-roi-overlay rect').evaluateAll(nodes=>nodes.map(n=>Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(n.getAttribute(k))])))))assert.deepEqual(svg,roi);
 await page.locator('#quality-roi-grid').check();await page.getByLabel('block width',{exact:true}).fill('24');await page.getByLabel('block height',{exact:true}).fill('20');
 await page.locator('#quality-roi-ssim').check(); // SSIM valid ROI, no grid edge smaller than 16.
 const posts=[];let lost=false;await page.route('**/api/quality/jobs',async route=>{if(route.request().method()!=='POST')return route.continue();const r=await route.fetch(),value=await r.json();posts.push({body:JSON.parse(route.request().postData()),key:route.request().headers()['idempotency-key'],status:r.status(),value});if(!lost){lost=true;await route.abort('failed');}else await route.fulfill({response:r});});
 await page.screenshot({path:path.join(directory,'quality-roi-selection.png')});
 phase='gui-durable-lost-response';await page.locator('#quality-roi-submit').click({clickCount:2});await page.locator('#quality-roi-retry').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#quality-roi-retry').disabled);await page.locator('#quality-roi-retry').click();
 await page.locator('[data-candidate-create]').waitFor({state:'visible'});assert.equal(posts.length,2);assert.deepEqual(posts.map(p=>p.status),[202,200]);assert.deepEqual(posts[0].body,posts[1].body);assert.equal(posts[0].key,posts[1].key);assert.equal(posts[1].value.replayed,true);
 const job=await fetch(base+`/api/quality/jobs/${posts[0].value.job.id}`,{headers}).then(r=>r.json());assert.equal(job.state,'completed');assert.equal(job.submitted.actorId,actor.id);assert.deepEqual(job.input.request.roi,roi);assert.equal(job.input.request.reference.picture.au,0);assert.equal(job.input.request.distorted.picture.au,1);
 const result=await fetch(base+job.result.url,{headers}).then(r=>r.json());assert.equal(result.value.result.ssim.variant,'ffmpeg-uniform-8x8-step4-v1');assert.ok(result.value.annotationContext.reference);assert.equal(result.value.result.metric.spatial.blocks.length,1);
 let expected=0;const bytesPerSample=depth===8?1:2;for(let plane=0;plane<3;plane++){const width=plane?16:32,offset=[0,1024,1280][plane],scale=plane?2:1;for(let y=roi.y/scale;y<(roi.y+roi.height)/scale;y++)for(let x=roi.x/scale;x<(roi.x+roi.width)/scale;x++){const at=(offset+y*width+x)*bytesPerSample,a=depth===8?raw[at]:raw.readUInt16LE(at),b=depth===8?raw[frame+at]:raw.readUInt16LE(frame+at);expected+=(a-b)**2;}}assert.equal(result.value.result.metric.aggregate.sse,expected);const oracle=ssimOracle(raw.subarray(0,frame),raw.subarray(frame),depth,32,32,roi);assert.ok(Math.abs(result.value.result.ssim.aggregate.score-oracle.all)<=1e-12);
 phase='atomic-create-shared-candidate';await page.locator('[data-candidate-space]').selectOption(workspace.space);await page.locator('[data-candidate-text]').fill('Measured ROI candidate, requires human assessment');
 const candidateKey=`voidplayer-quality-candidate:${actor.id}:${job.submitted.client.id}:${job.id}`;
 const candidatePosts=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===`/api/annotations/spaces/${workspace.space}`)candidatePosts.push(JSON.parse(request.postData()));});
 // Actual number-input validity blocks empty/non-numeric/range/fraction values;
 // bypassing native form checks still exercises the complete shared validator.
 const severity=page.locator('[data-candidate-severity]');
 for(const value of ['', '0','-1','6','1.5']){
  await severity.fill(value);await page.locator('[data-candidate-create]').click();
  assert.equal(await page.locator('[data-candidate-text]').isEnabled(),true);assert.equal(await severity.isEnabled(),true);
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),candidateKey),null);assert.equal(candidatePosts.length,0);
  await page.locator('[data-candidate-create]').evaluate(button=>button.form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await page.locator('[data-candidate-status]').filter({hasText:/no request was sent/i}).waitFor();
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),candidateKey),null);assert.equal(candidatePosts.length,0);assert.equal(await severity.isEnabled(),true);
 }
 await severity.fill('');await severity.pressSequentially('abc');assert.equal(await severity.inputValue(),'');await page.locator('[data-candidate-create]').click();assert.equal(candidatePosts.length,0);assert.equal(await severity.isEnabled(),true);await severity.fill('2');
 const mutations=[];let lostCandidate=false;await page.route(`**/api/annotations/spaces/${workspace.space}`,async route=>{if(route.request().method()!=='POST')return route.continue();const body=JSON.parse(route.request().postData());if(body.action!=='create-quality-candidate')return route.continue();const r=await route.fetch(),value=await r.json();mutations.push({body,value,status:r.status()});if(!lostCandidate){lostCandidate=true;await route.abort('failed');}else await route.fulfill({response:r});});
 await page.locator('[data-candidate-create]').click({clickCount:2});await page.locator('[data-candidate-status]').filter({hasText:/fetch|Failed|Load|Network/i}).waitFor();
 const unknown=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),candidateKey);assert.equal(await severity.isDisabled(),true);
 // A genuine lost HTTP response survives widget reconstruction. Recover in a
 // real task-history tab, retain the immutable request, and replay its receipt.
 const pendingPage=await context.newPage(),replayed=[];
 await pendingPage.addInitScript(({key,command,client})=>{sessionStorage.setItem('voidplayer-quality-client',client);sessionStorage.setItem(key,JSON.stringify(command));},{key:candidateKey,command:unknown,client:job.submitted.client.id});
 pendingPage.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname===`/api/annotations/spaces/${workspace.space}`)replayed.push(JSON.parse(r.postData()));});
 await pendingPage.goto(base+'/admin/#quality');await pendingPage.locator(`[data-job-id="${job.id}"]`).click();await pendingPage.locator('[data-candidate-status]').filter({hasText:/original submission is unconfirmed/i}).waitFor();
 for(const selector of ['[data-candidate-text]','[data-candidate-severity]','[data-candidate-space]','[data-candidate-side]'])assert.equal(await pendingPage.locator(selector).isDisabled(),true);
 assert.deepEqual(await pendingPage.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),candidateKey),unknown);
 await pendingPage.locator('[data-candidate-create]').click();await pendingPage.locator('#quality-job-result .quality-pair-open').waitFor();assert.equal(replayed.length,1);assert.deepEqual(replayed[0],mutations[0].body);await pendingPage.waitForLoadState('networkidle');await pendingPage.close();
 await page.locator('[data-candidate-create]').click();await page.locator('#quality-roi-dialog .quality-pair-open').waitFor();
 assert.equal(mutations.length,2);assert.deepEqual(mutations[0],mutations[1]);const candidate=mutations[0].value;assert.equal(candidate.revision,1);assert.equal(candidate.document.mark.qualityCandidate.assessment,'not-subjectively-assessed');assert.equal(candidate.document.mark.qualityEvidence[0].verification,'server-verified');assert.deepEqual(candidate.document.mark.qualityEvidence[0].value,result.value);
 // Restore a legacy invalid session draft in a separate real GUI tab. The
 // editable recovery must not unlock a valid request with an unknown outcome.
 phase='legacy-invalid-candidate-recovery';const recovery=await context.newPage();
 const invalidDraft={space:workspace.space,id:crypto.randomUUID(),operationId:crypto.randomUUID(),evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:'reference'},candidate:{text:'Legacy draft must remain editable',severity:0}};
 await recovery.addInitScript(({key,draft,client})=>{sessionStorage.setItem('voidplayer-quality-client',client);sessionStorage.setItem(key,JSON.stringify(draft));},{key:candidateKey,draft:invalidDraft,client:job.submitted.client.id});
 const recoveryPosts=[];recovery.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname===`/api/annotations/spaces/${workspace.space}`)recoveryPosts.push(JSON.parse(r.postData()));});
 await recovery.goto(base+'/admin/#quality');await recovery.locator(`[data-job-id="${job.id}"]`).click();await recovery.locator('[data-candidate-status]').filter({hasText:/restored.*edit|editable/i}).waitFor();
 assert.equal(await recovery.locator('[data-candidate-text]').inputValue(),invalidDraft.candidate.text);assert.equal(await recovery.locator('[data-candidate-severity]').inputValue(),'0');assert.equal(await recovery.locator('[data-candidate-text]').isEnabled(),true);assert.equal(await recovery.locator('[data-candidate-space]').isEnabled(),true);assert.equal(recoveryPosts.length,0);
 assert.deepEqual(await recovery.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),candidateKey),invalidDraft);
 await recovery.locator('[data-candidate-space]').selectOption(workspace.space);await recovery.locator('[data-candidate-severity]').fill('3');await recovery.locator('[data-candidate-text]').fill('Corrected legacy candidate');await recovery.locator('[data-candidate-create]').click();await recovery.locator('#quality-job-result .quality-pair-open').waitFor();
 assert.equal(recoveryPosts.length,1);assert.notEqual(recoveryPosts[0].operationId,invalidDraft.operationId);assert.equal(recoveryPosts[0].candidate.severity,3);assert.equal(await recovery.evaluate(key=>sessionStorage.getItem(key),candidateKey),null);await recovery.waitForLoadState('networkidle');await recovery.close();
 await observer.waitForFunction(id=>window.voidPlayer.getState().marks.some(m=>m.id===id&&m.qualityCandidate?.assessment==='not-subjectively-assessed'),candidate.id);assert.equal(privateReads,0);assert.equal((await observer.evaluate(async id=>(await fetch(`/api/quality/jobs/${id}`)).status,job.id)),404);
 await page.screenshot({path:path.join(directory,'quality-roi-created.png')});
 phase='original-frame-viewer';const[snapshot]=await Promise.all([context.waitForEvent('page'),page.locator('#quality-roi-dialog .quality-pair-open').click()]);await snapshot.waitForFunction(()=>['ready','failed'].includes(window.voidPlayerQualityPair?.getState().state));assert.equal((await snapshot.evaluate(()=>window.voidPlayerQualityPair.getState())).state,'ready');assert.deepEqual(await snapshot.evaluate(()=>window.__roiRaw),[Array.from(raw.subarray(0,frame)),Array.from(raw.subarray(frame))]);await snapshot.close();
 assert.deepEqual(await page.evaluate(()=>window.voidPlayer.getViewport()),beforeView);assert.deepEqual((await page.evaluate(()=>window.voidPlayer.getState())).tracks.map(t=>t.frame),before.tracks.map(t=>t.frame));assert.equal((await page.evaluate(()=>window.voidPlayer.getState())).positionUs,before.positionUs);
 assert.deepEqual((await observer.evaluate(()=>window.voidPlayer.getState())).tracks.map(t=>t.frame),beforePeer.tracks.map(t=>t.frame));assert.equal((await observer.evaluate(()=>window.voidPlayer.getState())).positionUs,beforePeer.positionUs);
 async function selectVerifiedPair(){await openRoi();for(const i of [0,1]){await page.locator(`[data-roi-au="${i}"] option[value="${i}"]`).waitFor({state:'attached'});await page.locator(`[data-roi-au="${i}"]`).selectOption(String(i));}await page.locator('#quality-roi-verify').click();await page.locator('#quality-roi-form').waitFor({state:'visible'});}
 if(engine==='chromium'&&depth===8){
  const[a]=await waitForAnnotationMedia(service.library,['A.mp4']);await observer.evaluate(async url=>{const blob=await fetch(url).then(r=>r.blob());await window.voidPlayer.loadFile('A',new File([blob],'A.mp4'));},`${base}/api/media/${a.id}?v=${a.version}`);await observer.waitForFunction(()=>!window.voidPlayer.getState().busy&&window.voidPlayer.getState().tracks[0]?.frame);await observer.evaluate(()=>window.voidPlayer.play());await observer.waitForFunction(()=>window.voidPlayer.getState().playing&&window.voidPlayer.getState().positionUs>200000);const playingBefore=await observer.evaluate(()=>window.voidPlayer.getState().positionUs);
  phase='gui-cancel-and-detached-observation';await page.locator('#quality-roi-dialog').evaluate(e=>e.close());
  const runner=service.library.quality,create=runner.createWorker;runner.createWorker=data=>{if(!heldGate||data.mode!=='measure')return create(data);const w=new Worker(new URL('../test/helpers/quality-workflow-worker.ts',import.meta.url),{workerData:{...data,gate:heldGate.buffer},resourceLimits:{maxOldGenerationSizeMb:256}});liveWorkers.add(w);w.once('exit',()=>liveWorkers.delete(w));return w;};
  const getJob=id=>fetch(`${base}/api/quality/jobs/${id}`,{headers}).then(r=>r.json());
  async function waitJob(id,predicate){for(let i=0;i<600;i++){const j=await getJob(id);if(predicate(j))return j;await new Promise(r=>setTimeout(r,25));}assert.fail('Durable gate state not reached');}
  for(const closeOnly of [false,true]){
   await selectVerifiedPair();heldGate=new Int32Array(new SharedArrayBuffer(8));gates.push(heldGate);const count=posts.length;await page.locator('#quality-roi-submit').click();await page.waitForFunction(()=>document.querySelector('#quality-roi-job-status').textContent.includes('decode'));assert.equal(posts.length,count+1);const id=posts.at(-1).value.job.id;await waitJob(id,j=>j.phase==='decode');assert.equal(Atomics.load(heldGate,1),1);assert.equal(liveWorkers.size,1);
   if(closeOnly){await page.locator('#quality-roi-dialog').evaluate(e=>e.close());const still=await getJob(id);assert.equal(still.state,'running');assert.equal(still.cancelRequestedAt,null);const cancel=await fetch(`${base}/api/quality/jobs/${id}/cancel`,{method:'POST',headers:{...headers,'x-voidplayer-action':'quality-job'},body:'{}'});assert.equal(cancel.status,200);}else await page.locator('#quality-roi-cancel').click();
   const stopped=await waitJob(id,j=>j.state==='cancelled');assert.equal(stopped.result.available,false);assert.equal(liveWorkers.size,0);assert.equal(service.library.qualityJobs.resources().activeAttempts,0);service.library.qualityAdmission.ordinary();heldGate=undefined;if(!closeOnly)await page.locator('#quality-roi-dialog').evaluate(e=>e.close());
  }
  assert.equal((await observer.evaluate(()=>window.voidPlayer.getState())).playing,true);assert.ok((await observer.evaluate(()=>window.voidPlayer.getState())).positionUs>playingBefore);
  phase='preflight-cache-loss';await openRoi();for(const i of [0,1]){await page.locator(`[data-roi-au="${i}"] option[value="${i}"]`).waitFor({state:'attached'});await page.locator(`[data-roi-au="${i}"]`).selectOption(String(i));}
  const zero=await page.addStyleTag({content:'.quality-roi-stage{width:0!important}'});await page.locator('#quality-roi-verify').click();await page.locator('#quality-roi-status').filter({hasText:'Snapshot view has no drawable geometry'}).waitFor();assert.equal(await page.locator('#quality-roi-form').isHidden(),true);await zero.evaluate(e=>e.remove());
  const noBuild=[];page.on('request',r=>{if(new URL(r.url()).searchParams.get('build')==='1')noBuild.push(r.url());});service.library.frameIndexes.remove();await page.locator('#quality-roi-verify').click();await page.locator('#quality-roi-status').filter({hasText:/^Original source\/cache is unavailable \(HTTP 409\)/}).waitFor();assert.equal(await page.locator('#quality-roi-form').isHidden(),true);assert.equal(await page.locator('#quality-roi-submit').isVisible(),false);assert.deepEqual(noBuild,[]);await page.locator('#quality-roi-dialog').evaluate(e=>e.close());
  for(const e of entries)assert.equal((await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}&build=1`)).status,200);
 }
 const beforeLatePosts=posts.length;
 for(const reason of ['identity','source-generation']){
 phase=reason+'-late-preflight';if(await page.locator('#quality-roi-dialog').count())await page.locator('#quality-roi-dialog').evaluate(e=>e.close());await openRoi();await page.locator('[data-roi-au="0"] option[value="0"]').waitFor({state:'attached'});await page.locator('[data-roi-au="1"] option[value="1"]').waitFor({state:'attached'});await page.locator('[data-roi-au="0"]').selectOption('0');await page.locator('[data-roi-au="1"]').selectOption('1');
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);await page.route('**/psnr-source?*',async route=>{const r=await route.fetch();enter();await gate;await route.fulfill({response:r}).catch(()=>{});});
 await page.locator('#quality-roi-verify').click();await entered;if(reason==='identity')await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'voidplayer.identity',newValue:null})));else await page.evaluate(()=>window.voidPlayer.removeTrack('B'));release();await page.locator('#quality-roi-dialog').waitFor({state:'detached'});await page.unroute('**/psnr-source?*');
 }
 assert.equal(posts.length,beforeLatePosts,'late verification cannot create a job');assert.equal(service.library.qualityJobs.resources().activeAttempts,0);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(directory,'quality-roi-candidate.png')});
 console.log(`PASS ROI ${engine}/${depth}: explicit AU raw snapshots equal native oracle, DPR2 drag exact ROI, real GUI PSNR+SSIM durable submission and lost-response replay, invalid candidate preflight/edit recovery, frozen unknown receipt replay, atomic candidate retry, peer sync/private job404, viewer raw bytes, original cursors unchanged and stale identity fenced`);
}catch(error){if(page&&!page.isClosed())await saveBrowserFailure({page,directory,name:'quality-roi',context:{engine,depth,phase},error,evidence}).catch(()=>{});throw error;}
finally{clearInterval(progress);for(const gate of gates){Atomics.store(gate,0,1);Atomics.notify(gate,0);}if(browser)await browser.close();if(service)await service.close();await rm(temp,{recursive:true,force:true});}
