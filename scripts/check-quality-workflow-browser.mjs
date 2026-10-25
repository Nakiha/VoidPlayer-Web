import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {loadConfig} from '../server/config.ts';
import {MediaLibraryIndex} from '../server/library.ts';
import {createMediaServer} from '../server/app.ts';
import {startService} from '../server/runtime.ts';
import {encodedPair} from '../test/helpers/library-pair-fixture.ts';
import {waitForAnnotationMedia} from './testing/agent-annotations-ready.mjs';
import {chooseTestGuest} from './test-identity.mjs';
import {recordBrowserEvidence,saveBrowserFailure} from './browser-failure-evidence.mjs';

const root=path.resolve(import.meta.dirname,'..'),engine=process.argv[2]??'chromium',depth=Number(process.argv[3]??8);
const directory=process.env.VOIDPLAYER_TEST_ARTIFACTS??path.join(root,'.run/quality-workflow',`${engine}-${depth}`),temp=await mkdtemp(path.join(os.tmpdir(),'vp-quality-workflow-'));
let service,browser,page,evidence,temporaryLibrary,temporaryServer,phase='setup',heldGate;
const gates=[],workers=new Set(),errors=[];
const progress=setInterval(()=>console.log(JSON.stringify({qualityWorkflow:true,engine,depth,phase,workers:workers.size})),10000).unref();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,check,label){for(let i=0;i<300;i++){const value=await read();if(check(value))return value;await pause(25);}assert.fail(`Timed out: ${label}`);}
function sse(sample,roi){const raw=Buffer.from(sample.native,'base64'),bytes=depth===10?2:1,frame=raw.length/2;let sum=0;
 for(const [plane,offset,width]of [['y',0,32],['u',1024,16],['v',1280,16]]){const scale=plane==='y'?1:2;
  for(let y=roi.y/scale;y<(roi.y+roi.height)/scale;y++)for(let x=roi.x/scale;x<(roi.x+roi.width)/scale;x++){
   const at=(offset+y*width+x)*bytes,a=bytes===1?raw[at]:raw.readUInt16LE(at),b=bytes===1?raw[frame+at]:raw.readUInt16LE(frame+at);sum+=(a-b)**2;}}
 return sum;
}
try{
 await mkdir(directory,{recursive:true});const media=path.join(temp,'media');await mkdir(media);
 const samples=JSON.parse(await readFile(path.join(root,'test/helpers/quality-http-samples.json'),'utf8')).samples;
 const sample=samples.find(s=>s.codec===(depth===10?'hevc':'h264')&&s.depth===depth&&s.tagged),bytes=Buffer.from(sample.flv,'base64');
 const sar=await encodedPair(temp,sample.codec,depth,true,{num:1000,den:1001});await writeFile(path.join(media,'SAR.flv'),sar.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),sample.flvSha256);assert.equal(createHash('sha256').update(Buffer.from(sample.native,'base64')).digest('hex'),sample.nativeSha256);
 for(const name of ['B.flv','C.flv','UNCACHED.flv'])await writeFile(path.join(media,name),bytes);
 await writeFile(path.join(media,'MISSING-COLOR.flv'),Buffer.from(samples.find(s=>s.codec==='h264'&&s.depth===8&&!s.tagged).flv,'base64'));
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','120','-c:v','libx264','-threads','1','-preset','ultrafast','-bf','0','-g','10','-pix_fmt','yuv420p','-movflags','+faststart',path.join(media,'A.mp4')]);
 await writeFile(path.join(temp,'voidplayer.config.json'),JSON.stringify({mediaRoots:[media],dataDir:'data',staticDir:path.join(root,'dist'),logsDir:null,indexWatch:false}));
 const config=await loadConfig([],'production',temp);config.port=0;service=await startService(config);await service.library.refresh();
 const entries=await waitForAnnotationMedia(service.library,['A.mp4','B.flv','C.flv','UNCACHED.flv','MISSING-COLOR.flv','SAR.flv']),entry=name=>entries.find(e=>e.name===name);
 const base=`http://127.0.0.1:${service.server.address().port}`;
 const identity=await fetch(base+'/api/identity',{method:'POST',headers:{origin:base,'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'Quality workflow owner'})});assert.equal(identity.status,200);
 const cookie=identity.headers.get('set-cookie').split(';')[0],actor=(await identity.json()).actor,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'};
 const get=async url=>{const response=await fetch(base+url,{headers,signal:AbortSignal.timeout(10000)});assert.equal(response.status,200,await response.clone().text());return response.json();};
 for(const name of ['B.flv','C.flv','MISSING-COLOR.flv','SAR.flv']){const e=entry(name),r=await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}&build=1`);assert.equal(r.status,200,await r.clone().text());}
 // Direct fetch is setup/independent Agent observation only. The first actual
 // measurement submission below must originate in a real GUI click.
 const b=entry('B.flv'),source={id:'mark-media-B',name:b.name,size:b.size,lastModified:b.lastModified,codec:sample.codec,decoder:'ffmpeg-wasm',width:32,height:32,durationUs:2000000,firstPtsUs:2000000,source:{kind:'library',id:b.id,url:`${base}/api/media/${b.id}?v=${b.version}`}};
 const annotation={mark:{id:'workflow-mark',text:'Existing B observation',severity:3,origin:'agent',createdAt:new Date().toISOString(),slot:'H',mediaId:source.id,frame:{ptsUs:0,sourcePtsUs:2000000,durationUs:1000000},comparison:[],region:null},media:[source]};
 const annotationHeaders={...headers,'x-voidplayer-action':'annotation'};
 const created=await fetch(`${base}/api/annotations/spaces/default`,{method:'POST',headers:annotationHeaders,body:JSON.stringify({operationId:'workflow-existing',id:annotation.mark.id,revision:0,action:'put',document:annotation})});assert.equal(created.status,200,await created.clone().text());
 // Gate only the actual Node Worker at its existing before-decode test seam.
 // All DB/file checks, decode, SSE, task persistence and termination stay real.
 const runner=service.library.quality,nativeFactory=runner.createWorker;
 runner.createWorker=data=>{
  if(!heldGate||data.mode!=='measure')return nativeFactory(data);
  const worker=new Worker(new URL('../test/helpers/quality-workflow-worker.ts',import.meta.url),{workerData:{...data,gate:heldGate.buffer},resourceLimits:{maxOldGenerationSizeMb:256}});
  workers.add(worker);worker.once('exit',()=>workers.delete(worker));return worker;
 };
 browser=await ({chromium,webkit}[engine]).launch({headless:true});const context=await browser.newContext({locale:'en-US',viewport:{width:1400,height:1000},deviceScaleFactor:2});context.setDefaultTimeout(30000);
 await context.addCookies([{name:'voidplayer-user',value:cookie.split('=')[1],url:base}]);context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 const player=await context.newPage();await player.goto(base);await chooseTestGuest(player);await player.waitForFunction(()=>!!window.voidPlayer);
 const a=entry('A.mp4');await player.evaluate(async url=>{const blob=await fetch(url).then(r=>r.blob());await window.voidPlayer.loadFile('A',new File([blob],'A.mp4'));},`${base}/api/media/${a.id}?v=${a.version}`);
 await player.waitForFunction(()=>!window.voidPlayer.getState().busy&&window.voidPlayer.getState().tracks[0]?.frame);await player.evaluate(()=>window.voidPlayer.play());await player.waitForFunction(()=>window.voidPlayer.getState().playing&&window.voidPlayer.getState().positionUs>200000);
 const playback=await player.evaluate(()=>({state:window.voidPlayer.getState(),log:window.voidPlayer.getLogs({limit:1})}));
 [page]=await Promise.all([context.waitForEvent('page'),player.locator('#quality-tasks-open').click()]);evidence=recordBrowserEvidence(page);await page.waitForURL('**/admin/#quality');await page.locator('#quality-availability').getByText('Durable single-frame PSNR is available',{exact:false}).waitFor();
 async function select(side,name,au){const field=page.locator(`[data-quality-source=${side}]`);await field.locator('[data-search]').fill(name);await field.locator('[data-search-button]').click();await field.locator(`[data-media-id="${entry(name).id}"]`).click();await field.locator('[data-frame] option').filter({hasText:`AU ${au} ·`}).waitFor({state:'attached'});await field.locator('[data-frame]').selectOption({label:`AU ${au} · source PTS ${au===0?2000000:3000000} µs`});}
 async function choose(){await select('reference','B.flv',0);await select('distorted','C.flv',1);for(const [name,value]of Object.entries({x:2,y:4,width:24,height:20}))await page.locator(`#quality-form [name=${name}]`).fill(String(value));}
 async function submitGui(){const previous=await page.locator('#quality-job-title').textContent();await page.locator('#quality-submit').click();await page.waitForFunction(previous=>document.querySelector('#quality-job-title').textContent&&document.querySelector('#quality-job-title').textContent!==previous,previous);return page.locator('#quality-job-title').textContent();}
 await choose();
 phase='gui-submit-lost-reply-double-click';heldGate=new Int32Array(new SharedArrayBuffer(8));gates.push(heldGate);const posts=[];let first=true;
 await page.route('**/api/quality/jobs',async route=>{if(route.request().method()!=='POST')return route.continue();posts.push({key:route.request().headers()['idempotency-key'],body:JSON.parse(route.request().postData())});
  if(first){first=false;const reply=await route.fetch();assert.equal(reply.status(),202);await route.abort('failed');}else await route.continue();});
 await page.locator('#quality-submit').click({clickCount:2});await page.locator('#quality-retry').waitFor({state:'visible'});assert.equal(posts.length,1);
 await page.locator('#quality-retry').click();await page.waitForFunction(()=>document.querySelector('#quality-retry').hidden&&document.querySelector('#quality-job-title').textContent);
 assert.equal(posts.length,2);assert.deepEqual(posts[0],posts[1]);const input=posts[0].body,id=await page.locator('#quality-job-title').textContent();
 assert.equal(input.client.kind,'browser');assert.equal(input.request.reference.mediaId,b.id);assert.equal(input.request.distorted.mediaId,entry('C.flv').id);assert.notEqual(input.request.reference.sourcePtsUs,input.request.distorted.sourcePtsUs);
 await until(()=>get(`/api/quality/jobs/${id}`),j=>j.phase==='decode','actual Worker decode gate');assert.equal(Atomics.load(heldGate,1),1);
 phase='agent-same-history-budget-and-observation';
 const agent=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'independent-http-agent'},body:JSON.stringify({...input,client:{kind:'agent',id:'independent-http-agent'}})});assert.equal(agent.status,202);const agentJob=(await agent.json()).job;
 await page.locator(`[data-job-id="${agentJob.id}"]`).waitFor();assert.match(await page.locator(`[data-job-id="${agentJob.id}"]`).textContent(),/agent\/independent-http-agent/);
 await page.locator('#quality-submit').click();await page.locator('#quality-retry').waitFor({state:'visible'});await page.waitForFunction(()=>/Actor quality admission is full/.test(document.querySelector('#quality-observer-status').textContent));await page.locator('#quality-forget').click();
 phase='close-window-does-not-cancel';await page.close();page=await context.newPage();evidence=recordBrowserEvidence(page);await page.goto(base+'/admin/#quality');await page.locator(`[data-job-id="${id}"]`).waitFor();
 const still=await get(`/api/quality/jobs/${id}`);assert.equal(still.state,'running');assert.equal(still.cancelRequestedAt,null);assert.equal(workers.size,1);
 await page.locator(`[data-job-id="${agentJob.id}"]`).click();await page.locator('#quality-cancel').click();await until(()=>get(`/api/quality/jobs/${agentJob.id}`),j=>j.state==='cancelled','GUI queued cancellation');assert.equal(workers.size,1);
 Atomics.store(heldGate,0,1);Atomics.notify(heldGate,0);heldGate=null;
 const completed=await until(()=>get(`/api/quality/jobs/${id}`),j=>['completed','failed'].includes(j.state),'GUI job completed');assert.equal(completed.state,'completed',JSON.stringify(completed));assert.equal(workers.size,0);
 const result=await get(`/api/quality/jobs/${id}/result`),expected=sse(sample,input.request.roi);assert.equal(result.value.result.metric.aggregate.sse,expected);assert.equal(result.value.result.metric.bitDepth,depth);assert.equal(result.attemptId,completed.attempt.id);
 // Force one real history poll between pointerdown/up: polling must preserve
 // the exact button node and the user's selection, not retry a lost click.
 phase='poll-pointer-hover';await page.bringToFront();const completedRow=page.locator(`[data-job-id="${id}"]`);await completedRow.hover();phase='poll-pointer-down';await page.mouse.down();phase='poll-pointer-watch';
 await page.evaluate(()=>{window.__qualityRenderTick=false;const observer=new MutationObserver(()=>{observer.disconnect();window.__qualityRenderTick=true;});observer.observe(document.querySelector('#quality-resources'),{childList:true,characterData:true,subtree:true});});
 phase='poll-pointer-http';await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/jobs'&&r.request().method()==='GET');phase='poll-pointer-dom';await page.waitForFunction(()=>window.__qualityRenderTick===true);phase='poll-pointer-up';await page.mouse.up();phase='poll-pointer-result';
 await page.locator('#quality-job-result .quality-evidence-score').waitFor();assert.match(await page.locator('#quality-job-json').textContent(),new RegExp(completed.attempt.id));assert.deepEqual(JSON.parse(await page.locator('#quality-job-result pre').textContent()),result.value);
 phase='attachment-space-late-read';
 const otherSpaceResponse=await fetch(base+'/api/annotations/spaces',{method:'POST',headers:annotationHeaders,body:JSON.stringify({name:'Other review space'})});assert.equal(otherSpaceResponse.status,201);const otherSpace=await otherSpaceResponse.json();
 // A fresh completed selection reloads spaces, then a held old-space list must
 // not repopulate the new space or re-enable the previous attachment command.
 await page.locator(`[data-job-id="${agentJob.id}"]`).click();await page.locator(`[data-job-id="${id}"]`).click();await page.locator('#quality-space option').filter({hasText:'Other review space'}).waitFor({state:'attached'});
 let releaseSpace,enteredSpace;const spaceGate=new Promise(r=>releaseSpace=r),spaceEntered=new Promise(r=>enteredSpace=r);
 const spacePattern='**/api/annotations/spaces/default?list=*';
 await page.route(spacePattern,async route=>{const response=await route.fetch();enteredSpace();await spaceGate;await route.fulfill({response}).catch(()=>{});});
 await page.locator('#quality-space').selectOption('default');await spaceEntered;await page.locator('#quality-space').selectOption(otherSpace.id);await page.waitForFunction(()=>document.querySelector('#quality-mark-list').children.length===0);releaseSpace();await page.unroute(spacePattern);await page.waitForTimeout(50);
 assert.equal(await page.locator('#quality-space').inputValue(),otherSpace.id);assert.equal(await page.locator('[data-mark-id="workflow-mark"]').count(),0);assert.equal(await page.locator('#quality-attach').isDisabled(),true);
 phase='explicit-existing-annotation-attach-lost-response';await page.locator('#quality-space').selectOption('default');await page.locator('[data-mark-id="workflow-mark"]').click();
 const attachmentPosts=[];let lostAttach=true;
 await page.route('**/api/annotations/spaces/default',async route=>{if(route.request().method()!=='POST')return route.continue();attachmentPosts.push(JSON.parse(route.request().postData()));if(lostAttach){lostAttach=false;const reply=await route.fetch();assert.equal(reply.status(),200);await route.abort('failed');}else await route.continue();});
 await page.locator('#quality-attach').click();await page.waitForFunction(()=>/retry/i.test(document.querySelector('#quality-attach-status').textContent));await page.locator('#quality-attach').click();await page.locator('#quality-shared-links .quality-pair-open').waitFor();assert.deepEqual(attachmentPosts[0],attachmentPosts[1]);
 const shared=await get('/api/annotations/spaces/default/workflow-mark');assert.equal(shared.revision,2);assert.equal(shared.document.mark.qualityEvidence.length,1);assert.equal(shared.document.mark.qualityEvidence[0].value.result.metric.aggregate.sse,expected);
 phase='explicit-original-viewer';const beforeView=await player.evaluate(()=>window.voidPlayer.getState());
 const viewerRequests=[];const track=r=>viewerRequests.push({url:r.url(),method:r.method()});const trackViewer=p=>{if(p!==page&&p!==player)p.on('request',track);};context.on('page',trackViewer);
 [page.viewer]=await Promise.all([context.waitForEvent('page'),page.locator('#quality-shared-links .quality-pair-open').click()]);const viewer=page.viewer;
 await viewer.waitForFunction(()=>['ready','failed'].includes(window.voidPlayerQualityPair?.getState().state));const viewed=await viewer.evaluate(()=>window.voidPlayerQualityPair.getState());assert.equal(viewed.state,'ready',JSON.stringify(viewed));assert.deepEqual(viewed.evidence,shared.document.mark.qualityEvidence[0]);
 for(const side of ['reference','distorted']){assert.deepEqual(viewed.presented[side].picture,input.request[side].picture);assert.equal(viewed.presented[side].sourcePtsUs,input.request[side].sourcePtsUs);assert.equal(viewed.presented[side].sourceBinding.indexBuildId,input.request[side].indexBuildId);}
 assert.equal(await viewer.locator('.quality-pair-roi rect').count(),2);assert.deepEqual(viewerRequests.filter(r=>new URL(r.url).pathname.startsWith('/api/quality/')),[]);await viewer.screenshot({path:path.join(directory,'measured-pair-roi.png')});await viewer.close();context.off('page',trackViewer);
 const after=await player.evaluate(()=>window.voidPlayer.getState());assert.equal(after.playing,true);assert.ok(after.positionUs>beforeView.positionUs);assert.deepEqual(after.tracks.map(t=>[t.id,t.slot,t.offsetUs]),playback.state.tracks.map(t=>[t.id,t.slot,t.offsetUs]));assert.equal(after.marks.length,0);
 const log=await player.evaluate(({sessionId,lastSeq})=>window.voidPlayer.getLogs({sessionId,sinceSeq:lastSeq,limit:2000}),playback.log);assert.equal(log.gap,false);assert.equal(log.hasMore,false);assert.deepEqual(log.events.filter(e=>['seek','restoreWorkspace'].includes(e.data?.action)),[]);
 phase='same-source-independent-au';await choose();await select('distorted','B.flv',1);const sameId=await submitGui();const same=await until(()=>get(`/api/quality/jobs/${sameId}`),j=>['completed','failed'].includes(j.state),'GUI same source independent AUs');assert.equal(same.state,'completed');const sameResult=await get(`/api/quality/jobs/${sameId}/result`);assert.equal(sameResult.value.result.metric.aggregate.sse,expected);assert.equal(sameResult.value.result.provenance.reference.mediaId,sameResult.value.result.provenance.distorted.mediaId);assert.notEqual(sameResult.value.result.provenance.reference.picture.au,sameResult.value.result.provenance.distorted.picture.au);
 phase='client-and-actor-late-private-detail';
 async function holdPrivate(){let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r),pattern=`**/api/quality/jobs/${id}`;
  await page.route(pattern,async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response}).catch(()=>{});});
  await page.locator(`[data-job-id="${id}"]`).click();await start;return async()=>{await release();await page.unroute(pattern);};}
 let release=await holdPrivate();await page.locator('#quality-client').fill('second-client');await page.locator('#quality-client-apply').click();await release();await page.waitForFunction(()=>document.querySelector('#quality-job-detail').hidden);assert.equal(await page.locator('#quality-client').inputValue(),'second-client');
 const otherIdentity=await fetch(base+'/api/identity',{method:'POST',headers:{...headers,'x-voidplayer-action':'identity'},body:JSON.stringify({name:'Other quality reviewer',mode:'create'})});assert.equal(otherIdentity.status,200);const foreignActor=(await otherIdentity.json()).actor;
 release=await holdPrivate();await player.locator('#settings-open').click();await player.locator('#settings-tab-identity').click();await player.waitForFunction(()=>!document.querySelector('#identity-users').disabled);
 async function switchActor(actor){await player.locator('#identity-users').click();await player.locator(`#identity-users-menu [data-value="${actor.id}"]`).click();await player.locator('#identity-save').click();await player.waitForFunction(name=>document.querySelector('#identity-current').textContent===name,actor.name);await page.waitForFunction(name=>document.querySelector('#quality-owner').textContent.includes(name),actor.name);}
 let releaseHealth,healthEntered;const healthGate=new Promise(r=>releaseHealth=r),healthStarted=new Promise(r=>healthEntered=r);let firstHealth=true;
 await page.route('**/api/health',async route=>{if(!firstHealth)return route.continue();firstHealth=false;const response=await route.fetch();healthEntered();await healthGate;await route.fulfill({response}).catch(()=>{});});
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await healthStarted;
 await player.locator('#identity-users').click();await player.locator(`#identity-users-menu [data-value="${foreignActor.id}"]`).click();await player.locator('#identity-save').click();await player.waitForFunction(name=>document.querySelector('#identity-current').textContent===name,foreignActor.name);
 releaseHealth();await page.waitForFunction(name=>document.querySelector('#quality-owner').textContent.includes(name),foreignActor.name);await page.unroute('**/api/health');await release();await page.waitForFunction(()=>document.querySelector('#quality-job-detail').hidden&&document.querySelectorAll('#quality-job-list [data-job-id]').length===0);
 assert.equal(await page.evaluate(async id=>(await fetch(`/api/quality/jobs/${id}`)).status,id),404);assert.equal(await page.evaluate(async()=> (await fetch('/api/annotations/spaces/default/workflow-mark')).status),200);
 await switchActor(actor);await player.locator('#settings-close').click();await page.locator(`[data-job-id="${id}"]`).waitFor();
 phase='actual-worker-cancel-exit';await choose();heldGate=new Int32Array(new SharedArrayBuffer(8));gates.push(heldGate);
 const cancelId=await submitGui();await until(()=>get(`/api/quality/jobs/${cancelId}`),j=>j.phase==='decode','cancellable actual Worker');assert.equal(workers.size,1);
 await page.locator('#quality-cancel').click();const cancelled=await until(()=>get(`/api/quality/jobs/${cancelId}`),j=>j.state==='cancelled','physical Worker termination');assert.equal(cancelled.result.available,false);assert.equal(workers.size,0);assert.equal(service.library.qualityJobs.resources().activeAttempts,0);service.library.qualityAdmission.ordinary();heldGate=null;
 phase='bad-roi-and-color';await page.locator('#quality-form [name=x]').fill('1');await page.locator('#quality-submit').click();assert.equal(await page.locator('#quality-form [name=x]').evaluate(e=>e.validity.stepMismatch),true);
 await select('reference','MISSING-COLOR.flv',0);await select('distorted','MISSING-COLOR.flv',1);for(const [name,value]of Object.entries({x:2,y:4,width:24,height:20}))await page.locator(`#quality-form [name=${name}]`).fill(String(value));
 const colorId=await submitGui();const color=await until(()=>get(`/api/quality/jobs/${colorId}`),j=>['failed','completed'].includes(j.state),'explicit missing color rejection');assert.equal(color.state,'failed');assert.equal(color.result.available,false);assert.match(color.reason.message,/color|chroma/i);
 phase='measurement-viewer-geometry-distinction';await select('reference','SAR.flv',0);await select('distorted','SAR.flv',1);
 const sarProof=JSON.parse(await page.locator('[data-quality-source=reference] [data-source-proof]').textContent());assert.equal(sarProof.geometry.sarNum,1000);assert.equal(sarProof.geometry.sarDen,1001);assert.match(await page.locator('[data-quality-source=reference] [data-source-status]').textContent(),/viewer rejects this geometry/);
 const sarId=await submitGui(),sarJob=await until(()=>get(`/api/quality/jobs/${sarId}`),j=>['completed','failed'].includes(j.state),'real SAR measurement keeps original viewer gate');assert.equal(sarJob.state,'completed');const sarResult=await get(`/api/quality/jobs/${sarId}/result`);assert.equal(sarResult.value.result.metric.aggregate.sse,sse({...sample,native:sar.native.toString('base64')},input.request.roi));
 phase='missing-and-rebuilt-cache';await select('reference','B.flv',0);await select('distorted','C.flv',1);
 const oldBuild=await page.locator('[data-quality-source=reference] [data-source-proof]').textContent();
 const cleared=await fetch(base+'/api/admin/frame-indexes',{method:'DELETE',headers:{...headers,'x-voidplayer-action':'admin'}});assert.equal(cleared.status,200);
 const missingId=await submitGui();const missing=await until(()=>get(`/api/quality/jobs/${missingId}`),j=>j.state==='failed','missing cache job failure');assert.equal(missing.reason.code,'cache-miss');
 const e=entry('UNCACHED.flv');await page.locator('[data-quality-source=reference] [data-search]').fill(e.name);await page.locator('[data-quality-source=reference] [data-search-button]').click();const [absent]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===`/api/media/${e.id}/psnr-frames`),page.locator(`[data-quality-source=reference] [data-media-id="${e.id}"]`).click()]);assert.equal(absent.status(),409);
 // Chromium can discard DevTools response bodies after intercepted requests.
 // Verify the real GUI-consumed error, then the independent Agent HTTP fact;
 // neither check relies on Response.body()/finished() transport bookkeeping.
 await page.waitForFunction(()=>document.querySelector('[data-quality-source=reference] [data-source-status]').textContent==='An existing complete FLV cache is required.'&&document.querySelector('[data-quality-source=reference] [data-frame]').disabled);
 const absentAgent=await fetch(`${base}/api/media/${e.id}/psnr-frames?v=${e.version}`,{headers,signal:AbortSignal.timeout(10000)});assert.equal(absentAgent.status,409);assert.equal((await absentAgent.json()).code,'cache-miss');
 assert.equal((await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}`).then(r=>r.json())).index,null,'GUI never builds absent cache');
 for(const name of ['B.flv','C.flv']){const e=entry(name);assert.equal((await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}&build=1`)).status,200);}
 const stale=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'stale-agent'},body:JSON.stringify({...input,client:{kind:'agent',id:'stale-agent'}})});assert.equal(stale.status,202);const staleJob=(await stale.json()).job;const staleDone=await until(()=>get(`/api/quality/jobs/${staleJob.id}`),j=>j.state==='failed','rebuilt cache rejects stale Agent identity');assert.equal(staleDone.reason.code,'identity-mismatch');assert.ok(oldBuild.includes(input.request.reference.indexBuildId));
 phase='gui-rebuilt-cache-and-source-version';await select('reference','B.flv',0);
 const rebuiltId=await submitGui();const rebuilt=await until(()=>get(`/api/quality/jobs/${rebuiltId}`),j=>j.state==='failed','GUI retains and rejects stale distorted build');assert.equal(rebuilt.reason.code,'identity-mismatch');
 await select('distorted','C.flv',1);await writeFile(path.join(media,'C.flv'),Buffer.concat([bytes,Buffer.from([0])]));
 const versionId=await submitGui();const version=await until(()=>get(`/api/quality/jobs/${versionId}`),j=>j.state==='failed','source version/stat changed after GUI selection');assert.equal(version.reason.code,'source-changed');assert.equal(version.result.available,false);
 phase='temporary-database-capability';
 temporaryLibrary=new MediaLibraryIndex([],{database:':memory:',watch:false});temporaryServer=createMediaServer({roots:[],library:temporaryLibrary,staticDir:path.join(root,'dist'),onLog(){}});await new Promise(r=>temporaryServer.listen(0,'127.0.0.1',r));
 const temporaryBase=`http://127.0.0.1:${temporaryServer.address().port}`,temporaryContext=await browser.newContext({locale:'en-US'});await temporaryContext.addCookies([{name:'voidplayer-user',value:`guest-${randomUUID()}`,url:temporaryBase}]);const temporaryPage=await temporaryContext.newPage();await temporaryPage.goto(temporaryBase+'/admin/#quality');await temporaryPage.locator('#quality-availability').filter({hasText:'does not offer durable quality jobs'}).waitFor();assert.equal(await temporaryPage.locator('#quality-submit').isDisabled(),true);await temporaryContext.close();
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(directory,'quality-tasks.png')});
 console.log(`PASS ${engine} ${depth}-bit: real GUI submit → durable job/Agent same attempt/SSE ${expected} → explicit existing annotation → original pair/ROI; idempotency, window close, queue budget, actual Worker cancel exit, color/ROI/cache rejection and playback A isolation`);
}catch(error){if(page&&!page.isClosed())await saveBrowserFailure({page,directory,name:'quality-workflow',context:{engine,depth,phase},error,evidence}).catch(()=>{});throw error;}
finally{clearInterval(progress);for(const gate of gates){Atomics.store(gate,0,1);Atomics.notify(gate,0);}if(browser)await browser.close();if(service)await service.close();if(temporaryServer)await new Promise(r=>temporaryServer.close(r));if(temporaryLibrary)await temporaryLibrary.close();await rm(temp,{recursive:true,force:true});}
