import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {loadConfig} from '../server/config.ts';
import {startService} from '../server/runtime.ts';
import {SSIM_VARIANT} from '../shared/analysis/quality/ssim.ts';
import {waitForAnnotationMedia} from './testing/agent-annotations-ready.mjs';
import {chooseTestGuest} from './test-identity.mjs';
import {recordBrowserEvidence,saveBrowserFailure} from './browser-failure-evidence.mjs';
import {installAdminObservationLifecycle,drainAdminObservations} from './testing/admin-observation-lifecycle.mjs';

const root=path.resolve(import.meta.dirname,'..'),engine=process.argv[2]??'chromium',depth=Number(process.argv[3]??8);
assert.ok(['chromium','webkit'].includes(engine)&&[8,10].includes(depth));
const directory=process.env.VOIDPLAYER_TEST_ARTIFACTS??path.join(root,'.run/quality-correspondence',`${engine}-${depth}`),temp=await mkdtemp(path.join(os.tmpdir(),'vp-clock-browser-'));
let service,browser,page,viewer,evidence,viewerEvidence,phase='setup';const gate=new Int32Array(new SharedArrayBuffer(8)),workers=new Set();
const pause=()=>new Promise(r=>setTimeout(r,25));
async function until(read,check,label){for(let n=0;n<600;n++){const value=await read();if(check(value))return value;await pause();}assert.fail(label);}
async function bounded(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`Timed out: ${label} (${phase})`)),15000);})]);}finally{clearTimeout(timer);}}
const progress=setInterval(()=>console.log(JSON.stringify({engine,depth,phase,liveWorkers:workers.size})),10000).unref();
try{
 await mkdir(directory,{recursive:true});const media=path.join(temp,'media');await mkdir(media);
 const sample=JSON.parse(await readFile(path.join(root,'test/helpers/quality-http-samples.json'),'utf8')).samples.find(s=>s.codec===(depth===10?'hevc':'h264')&&s.depth===depth&&s.tagged);
 const bytes=Buffer.from(sample.flv,'base64'),native=Buffer.from(sample.native,'base64');assert.equal(createHash('sha256').update(native).digest('hex'),sample.nativeSha256);
 for(const name of ['B.flv','C.flv'])await writeFile(path.join(media,name),bytes);
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-t','120','-c:v','libx264','-threads','1','-preset','ultrafast','-bf','0','-g','10','-pix_fmt','yuv420p','-movflags','+faststart',path.join(media,'A.mp4')]);
 const config=await loadConfig([],'production',temp,{staticDir:path.join(root,'dist'),dataDir:path.join(temp,'data'),logsDir:null,allowEmptyRoots:true});config.mediaRoots=[media];config.indexWatch=false;config.port=0;
 service=await startService(config);await service.library.refresh();const entries=await waitForAnnotationMedia(service.library,['A.mp4','B.flv','C.flv']),entry=name=>entries.find(e=>e.name===name);
 const base=`http://127.0.0.1:${service.server.address().port}`;
 const identity=await fetch(base+'/api/identity',{method:'POST',headers:{origin:base,'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'Range reviewer'})});assert.equal(identity.status,200);const cookie=identity.headers.get('set-cookie').split(';')[0],actor=(await identity.json()).actor;
 const headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'};
 const post=async(url,body,key='browser-range')=>{const r=await fetch(base+url,{method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json();};
 const get=async url=>{const r=await fetch(base+url,{headers});assert.equal(r.status,200,await r.clone().text());return r.json();};
 const factories=[];
 for(const name of ['B.flv','C.flv']){
  const e=entry(name),discovered=await get(`/api/library/discovery?search=${encodeURIComponent(name)}&includeUnknown=1&limit=32`),selected=discovered.entries.find(item=>item.source.id===e.id&&item.source.version===e.version);assert.ok(selected,'discovery supplies the explicit versioned source');
  const r=await fetch(`${base}/api/library/preparations`,{method:'POST',headers:{...headers,'x-voidplayer-action':'library-preparation','idempotency-key':`clock-prepare-${e.id}`},body:JSON.stringify({source:selected.source,operation:'quality-index',client:{id:'clock-browser-preparation',name:'Clock browser preparation'}})});assert.equal(r.status,202,await r.clone().text());const accepted=await r.json(),prepared=await until(()=>get(`/api/library/preparations/${accepted.job.id}`),j=>['completed','failed','interrupted','cancelled'].includes(j.state),'explicit preparation never finished');assert.equal(prepared.state,'completed',JSON.stringify(prepared));const proof=prepared.result,index=await get(`/api/media/${e.id}/frame-index?v=${e.version}`);
  factories.push(au=>({...proof.binding,sourcePtsUs:index.index.packets[au][2],picture:{sourceVersion:`${e.id}@${e.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}}));
 }
 const runner=service.library.quality,originalFactory=runner.createWorker;
 runner.createWorker=data=>{
  if(data.mode!=='correspondence-plan')return originalFactory(data);
  const worker=new Worker(new URL('../test/helpers/quality-workflow-worker.ts',import.meta.url),{workerData:{...data,gate:gate.buffer},resourceLimits:{maxOldGenerationSizeMb:256}});
  workers.add(worker);worker.once('exit',()=>workers.delete(worker));return worker;
 };
 browser=await ({chromium,webkit}[engine]).launch({headless:true});const context=await browser.newContext({locale:'en-US',viewport:{width:1400,height:1000},deviceScaleFactor:2});
 await context.addCookies([{name:'voidplayer-user',value:cookie.split('=')[1],url:base}]);
 await context.addInitScript(installAdminObservationLifecycle);
 await context.addInitScript(()=>{
  // Management also initializes on ordinary HTTP, where randomUUID is absent.
  if(location.pathname.startsWith('/admin'))Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});
  const NativeWorker=window.Worker;
  window.Worker=class extends NativeWorker{constructor(...args){super(...args);this.addEventListener('message',({data})=>{
   if(data?.ok&&data.result?.frames)window.__rangePairHashes=Promise.all(data.result.frames.map(async frame=>{
    const d=frame.description,unit=d.yuv.bitDepth>8?2:1,rows=[];
    for(const p of d.yuv.planes)for(let y=0;y<p.height;y++)rows.push(frame.pixels.subarray(p.offset+y*p.stride,p.offset+y*p.stride+p.width*unit));
    const packed=new Uint8Array(rows.reduce((n,row)=>n+row.length,0));let offset=0;for(const row of rows){packed.set(row,offset);offset+=row.length;}
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',packed)),b=>b.toString(16).padStart(2,'0')).join('');
   }));
  });}};
 });
 const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 phase='play-A';const player=await context.newPage();await player.goto(base);await chooseTestGuest(player);await player.waitForFunction(()=>!!window.voidPlayer);
 const a=entry('A.mp4');await player.evaluate(async url=>{const blob=await fetch(url).then(r=>r.blob());await window.voidPlayer.loadFile('A',new File([blob],'A.mp4'));},`${base}/api/media/${a.id}?v=${a.version}`);
 await player.waitForFunction(()=>!window.voidPlayer.getState().busy&&window.voidPlayer.getState().tracks[0]?.frame);await player.evaluate(()=>window.voidPlayer.play());await player.waitForFunction(()=>window.voidPlayer.getState().playing&&window.voidPlayer.getState().positionUs>200000);
 const before=await player.evaluate(()=>window.voidPlayer.getState());
 page=await context.newPage();evidence=recordBrowserEvidence(page);await page.goto(base+'/admin/#quality');await page.locator('#quality-clock').waitFor();
 const [reference,distorted]=factories,p0=reference(0).sourcePtsUs,p1=reference(1).sourcePtsUs;
 phase='declare-relation';
 for(const [side,name]of [['reference','B.flv'],['distorted','C.flv']]){const field=page.locator(`[data-clock-source="${side}"]`);await field.locator('[data-clock-search]').fill(name);await field.locator('[data-clock-search-button]').click();await field.locator(`[data-clock-media="${entry(name).id}"]`).click();}
 await page.locator('#quality-clock-declaration').fill('Explicit browser reference relation');
 const fillSegment=async(index,start,end,offset)=>{const row=page.locator('[data-clock-segment]').nth(index);for(const [field,value]of Object.entries({start,end,offset}))await row.locator(`[data-segment-field="${field}"]`).fill(String(value));};
 await fillSegment(0,p0,p0+1,p1-p0);await page.locator('#quality-clock-add-segment').click();await fillSegment(1,p1,p1+1,p0-p1);
 let lostRelation=false;const relationKeys=[];await page.route('**/api/quality/reference-relations',async route=>{if(route.request().method()==='POST'){relationKeys.push(route.request().headers()['idempotency-key']);if(!lostRelation){lostRelation=true;await route.fetch();await route.abort('failed');return;}}await route.continue();});
 await page.locator('#quality-clock-save-relation').click();await page.waitForFunction(()=>document.querySelector('#quality-clock-status').textContent.length>0);
 await drainAdminObservations(page);await page.reload();await page.locator('#quality-clock-retry-relation').waitFor({state:'visible'});assert.equal(await page.locator('#quality-clock-declaration').isDisabled(),true);await page.locator('#quality-clock-retry-relation').click();await page.waitForFunction(()=>document.querySelector('#quality-clock-relation').textContent.includes('Explicit browser reference relation'));
 assert.equal(lostRelation,true);assert.equal(relationKeys.length,2);assert.equal(relationKeys[0],relationKeys[1]);assert.equal((await get('/api/quality/reference-relations')).entries.length,1);
 await page.locator('#quality-clock-pin').click();await page.waitForFunction(()=>document.querySelector('#quality-clock-builds').textContent.includes('待测')||document.querySelector('#quality-clock-builds').textContent.includes('Distorted'));
 await page.locator('#quality-clock-ssim').check();await page.locator('#quality-clock-grid').check();
 phase='durable-planning-lost-response';let lostPlan=false,dropNextPlan=false;const planKeys=[];let request;
 await context.route('**/api/quality/correspondence-plans',async route=>{if(route.request().method()==='POST'){request=route.request().postDataJSON();planKeys.push(route.request().headers()['idempotency-key']);if(!lostPlan||dropNextPlan){lostPlan=true;dropNextPlan=false;await route.fetch();await route.abort('failed');return;}}await route.continue();});
 await page.locator('#quality-clock-plan-submit').click();await until(()=>Atomics.load(gate,1),Boolean,'real planner never reached metadata barrier');
 await until(()=>get('/api/quality/correspondence-plans'),d=>d.entries.length===1,'plan submission was not durable');
 await drainAdminObservations(page);await page.reload();await page.locator('#quality-clock-retry-plan').waitFor({state:'visible'});assert.equal(workers.size,1,'reload does not cancel durable planning');assert.equal(await page.locator('#quality-clock-end').isDisabled(),true);await page.locator('#quality-clock-retry-plan').click();await page.waitForFunction(()=>document.querySelector('#quality-clock-title').textContent.includes('running'));
 const planId=(await get('/api/quality/correspondence-plans')).entries[0].id;assert.equal(planKeys.length,2);assert.equal(planKeys[0],planKeys[1]);assert.equal(workers.size,1);await drainAdminObservations(page);await page.close();
 assert.equal((await get(`/api/quality/correspondence-plans/${planId}`)).plan.state,'running');assert.equal((await get('/api/quality/ranges')).entries.length,0,'planning never scores');
 Atomics.store(gate,0,1);Atomics.notify(gate,0);
 const planned=await until(()=>get(`/api/quality/correspondence-plans/${planId}`),d=>d.plan.state==='completed','background planning failed');assert.equal(workers.size,0);assert.equal(planned.summary.work.decodedFrames,0);assert.equal(planned.summary.work.indexPackets,4);
 page=await context.newPage();evidence=recordBrowserEvidence(page);await page.goto(base+'/admin/#quality');await page.locator(`[data-clock-plan="${planId}"]`).click();await page.waitForFunction(()=>document.querySelectorAll('#quality-clock-rows [data-clock-au]').length===2);const facts=await get(`/api/quality/correspondence-plans/${planId}/rows`);assert.deepEqual(facts.entries.map(r=>[r.au,r.distorted.au]),[[0,1],[1,0]]);
 phase='explicit-new-identical-plan';const originalInput=(await get(`/api/quality/correspondence-plans/${planId}`)).plan.input;
 Atomics.store(gate,0,0);Atomics.store(gate,1,0);await page.locator('#quality-clock-new-plan').click();await until(()=>Atomics.load(gate,1),Boolean,'new confirmed plan never reached metadata gate');
 const newId=(await get('/api/quality/correspondence-plans')).entries.at(-1).id;assert.notEqual(newId,planId);assert.equal(planKeys.length,3);assert.notEqual(planKeys[2],planKeys[0]);assert.deepEqual((await get(`/api/quality/correspondence-plans/${newId}`)).plan.input,originalInput);await page.waitForFunction(id=>document.querySelector('#quality-clock-title').textContent.includes(id),newId);
 await page.locator('#quality-clock-cancel').click();await until(()=>get(`/api/quality/correspondence-plans/${newId}`),d=>d.plan.state==='cancelled','new plan cancellation did not physically finish');await until(()=>workers.size,n=>n===0,'cancelled metadata Worker did not exit');await page.waitForFunction(()=>!document.querySelector('#quality-clock-new-plan').disabled);
 phase='unknown-new-plan-replays-only';Atomics.store(gate,0,0);Atomics.store(gate,1,0);dropNextPlan=true;await page.locator('#quality-clock-new-plan').click();await until(()=>Atomics.load(gate,1),Boolean,'unknown new plan did not enter metadata gate');await page.locator('#quality-clock-retry-plan').waitFor({state:'visible'});
 const unknownId=(await get('/api/quality/correspondence-plans')).entries.at(-1).id;assert.notEqual(unknownId,newId);assert.equal(planKeys.length,4);assert.notEqual(planKeys[3],planKeys[2]);assert.deepEqual((await get(`/api/quality/correspondence-plans/${unknownId}`)).plan.input,originalInput);assert.equal(await page.locator('#quality-clock-new-plan').isDisabled(),true);
 await page.locator('#quality-clock-new-plan').dispatchEvent('click');assert.equal(planKeys.length,4,'unknown submission cannot be assigned another new key');
 await page.locator('[data-pane="overview"]').click();await page.locator('[data-pane="quality"]').click();await page.locator(`[data-clock-plan="${newId}"]`).click();assert.equal(await page.locator('#quality-clock-new-plan').isDisabled(),true);assert.equal(workers.size,1);
 await drainAdminObservations(page);await page.reload();await page.locator('#quality-clock-retry-plan').waitFor({state:'visible'});await page.locator(`[data-clock-plan="${newId}"]`).click();await page.waitForFunction(id=>document.querySelector('#quality-clock-title').textContent.includes(id),newId);assert.equal(await page.locator('#quality-clock-new-plan').isDisabled(),true);assert.equal(planKeys.length,4);
 await page.locator('#quality-clock-retry-plan').click();await page.waitForFunction(id=>document.querySelector('#quality-clock-title').textContent.includes(id),unknownId);assert.equal(planKeys.length,5);assert.equal(planKeys[4],planKeys[3]);assert.equal(workers.size,1);Atomics.store(gate,0,1);Atomics.notify(gate,0);await until(()=>get(`/api/quality/correspondence-plans/${unknownId}`),d=>d.plan.state==='completed','retried explicit plan did not finish');assert.equal((await get(`/api/quality/correspondence-plans/${newId}`)).plan.state,'cancelled');assert.equal((await get('/api/quality/ranges')).entries.length,0,'new metadata attempts never automatically score');
 await page.locator('#quality-clock-refresh').click();await page.locator(`[data-clock-plan="${planId}"]`).click();await page.waitForFunction(id=>document.querySelector('#quality-clock-title').textContent.includes(id),planId);
 phase='explicit-score-retry';let lostExecute=false;await page.route(`**/api/quality/correspondence-plans/${planId}/execute`,async route=>{if(!lostExecute){lostExecute=true;await route.fetch();await route.abort('failed');}else await route.continue();});
 await page.locator('#quality-clock-execute').click();const submitted=await until(()=>get(`/api/quality/correspondence-plans/${planId}`),d=>!!d.execution?.rangeId,'range receipt never persisted'),id=submitted.execution.rangeId;
 const done=await until(()=>get(`/api/quality/ranges/${id}`),d=>d.job.state==='completed','planned range did not complete');assert.equal(done.job.summary.scoredPairs,2);assert.equal((await get(`/api/quality/ranges/${id}/candidates`)),null,'scoring never automatically publishes');
 await page.locator('#quality-clock-execute').click();assert.equal((await get('/api/quality/ranges')).entries.length,1);assert.equal(lostExecute,true);
 const unit=depth===8?1:2,frame=1536*unit;let sse=0;for(let i=0;i<1536;i++){const at=i*unit,a=unit===1?native[at]:native.readUInt16LE(at),b=unit===1?native[frame+at]:native.readUInt16LE(frame+at);sse+=(a-b)**2;}assert.equal(done.job.summary.groups[0].metric.sse,sse*2);
 phase='explicit-policy';await page.locator('#quality-clock-max-db').fill('120');await page.locator('#quality-clock-top-n').fill('1');await page.locator('#quality-clock-distance').fill('1');await page.locator('#quality-clock-candidate-text').fill('Explicit clock-plan candidate');await page.locator('#quality-clock-publish').click();await page.waitForFunction(()=>document.querySelector('#quality-clock-publication').textContent.includes('createdIds'));
 const publication=await get(`/api/quality/ranges/${id}/candidates`);assert.equal(publication.createdIds.length,1);const annotation=await get(`/api/annotations/spaces/default/${publication.createdIds[0]}`);assert.equal(annotation.revision,1);
 await page.locator('#quality-clock-show-range').click();await page.locator(`[data-candidate-id="${publication.createdIds[0]}"]`).waitFor();await page.screenshot({path:path.join(directory,'correspondence.png'),fullPage:true});
 phase='original-frame-review';[viewer]=await Promise.all([page.waitForEvent('popup'),page.locator(`[data-candidate-id="${publication.createdIds[0]}"]`).click()]);viewerEvidence=recordBrowserEvidence(viewer);await viewer.bringToFront();await viewer.waitForFunction(()=>['ready','failed','cancelled','closed'].includes(window.voidPlayerQualityPair?.getState().state),null,{polling:50});assert.equal((await viewer.evaluate(()=>window.voidPlayerQualityPair.getState())).state,'ready');const expected=[0,1].map(i=>createHash('sha256').update(native.subarray(i*frame,(i+1)*frame)).digest('hex')),hashes=await viewer.evaluate(()=>window.__rangePairHashes);assert.deepEqual(hashes,expected);await viewer.locator('#pair-block-selection').selectOption('3');assert.equal((await viewer.evaluate(()=>window.voidPlayerQualityPair.getState())).selectedBlock,3);await viewer.screenshot({path:path.join(directory,'original-pair.png')});await viewer.close();await page.bringToFront();
 phase='late-plan-row-view-fences';const other=(await post('/api/quality/correspondence-plans',{...request,sampling:{mode:'stride',every:2,offset:0}},'other-plan')).plan;await until(()=>get(`/api/quality/correspondence-plans/${other.id}`),d=>d.plan.state==='completed','other plan failed');await page.locator('#quality-clock-refresh').click();await page.locator(`[data-clock-plan="${other.id}"]`).waitFor();
 async function holdRows(id){let entered,release,finish;const seen=new Promise(r=>entered=r),gate=new Promise(r=>release=r),finished=new Promise(r=>finish=r),pattern=`**/api/quality/correspondence-plans/${id}/rows?*`;const handler=async route=>{const response=await route.fetch();entered();await gate;try{await route.fulfill({response});}catch{/* Closing observation or changing actor revokes the original request. */}finally{finish();}};await page.route(pattern,handler);return {seen,release,finished,async dispose(){release();await page.unroute(pattern,handler);}};}
 const held=await holdRows(planId),heldOther=await holdRows(other.id);try{await page.locator(`[data-clock-plan="${planId}"]`).click();await bounded(held.seen,'A rows consumed');await page.locator(`[data-clock-plan="${other.id}"]`).click();await bounded(heldOther.seen,'B rows consumed');held.release();await bounded(held.finished,'A rows released');await page.waitForTimeout(100);assert.ok((await page.locator('#quality-clock-title').textContent()).includes(other.id));assert.equal(await page.locator('#quality-clock-execution').textContent(),'');assert.equal(await page.locator('#quality-clock-publication').textContent(),'');heldOther.release();await bounded(heldOther.finished,'B rows released');}finally{await held.dispose();await heldOther.dispose();}
 const closing=await holdRows(planId);try{await page.locator(`[data-clock-plan="${planId}"]`).click();await bounded(closing.seen,'close rows consumed');await page.locator('[data-pane="overview"]').click();closing.release();await bounded(closing.finished,'close rows released');await page.waitForTimeout(100);assert.equal(await page.locator('#quality-clock-detail').evaluate(n=>n.hidden),true);assert.equal(await page.locator('#quality-clock-execution').textContent(),'');}finally{await closing.dispose();}
 await page.locator('[data-pane="quality"]').click();await page.locator(`[data-clock-plan="${planId}"]`).waitFor();const identityRows=await holdRows(planId);try{await page.locator(`[data-clock-plan="${planId}"]`).click();await bounded(identityRows.seen,'identity rows consumed');const peer=await player.evaluate(async()=>{const r=await fetch('/api/identity',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify({name:'Clock peer',mode:'create'})});const v=await r.json();localStorage.setItem('voidplayer.identity',JSON.stringify(v.actor));return v.actor;});await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/correspondence-plans'&&r.request().headers()['x-voidplayer-actor']===peer.id);identityRows.release();await bounded(identityRows.finished,'identity rows released');await page.waitForTimeout(100);assert.equal(await page.locator('#quality-clock-detail').evaluate(n=>n.hidden),true);assert.equal(await page.locator('#quality-clock-history').textContent(),'');assert.equal(await page.locator('#quality-clock-relation').textContent(),'');assert.equal(await page.locator('#quality-clock-new-plan').isDisabled(),true);}finally{await identityRows.dispose();}
 const after=await player.evaluate(()=>window.voidPlayer.getState());assert.ok(after.playing&&after.positionUs>before.positionUs);assert.deepEqual(after.tracks.map(t=>t.id),before.tracks.map(t=>t.id));assert.deepEqual(errors,[]);

 // This observer lifecycle barrier must not hide a real cross-origin failure.
 // Keep this expected negative control in its own context; the workflow's
 // page-error collection and identity/view assertions above stay untouched.
 if(engine==='webkit'){
  const control=await browser.newContext(),failures=[];await control.addInitScript(installAdminObservationLifecycle);
  const probe=await control.newPage();probe.on('pageerror',error=>failures.push(error.message));
  try{
   await probe.goto(base+'/admin/#overview');await probe.locator('[data-pane=overview]').waitFor();await drainAdminObservations(probe);assert.deepEqual(failures,[]);
   const crossOrigin=base.replace('127.0.0.1','localhost')+'/api/health?cors-negative-control=1',real=await fetch(crossOrigin);assert.equal(real.status,200);assert.equal(real.headers.get('access-control-allow-origin'),null);await real.arrayBuffer();
   const rejected=probe.waitForEvent('pageerror',{predicate:error=>error.message.includes('localhost')&&error.message.includes('access control checks'),timeout:15000}).then(error=>({ok:true,error:error.message}),error=>({ok:false,error}));
   const outcome=await probe.evaluate(async url=>{try{await fetch(url);return {rejected:false};}catch(error){return {rejected:true,name:error.name};}},crossOrigin);
   assert.equal(outcome.rejected,true);assert.equal(outcome.name,'TypeError');const observed=await rejected;if(!observed.ok)throw observed.error;assert.ok(failures.includes(observed.error),'real access-control page errors remain visible after draining');
  }finally{await control.close();}
 }
 await writeFile(path.join(directory,'evidence.json'),JSON.stringify({engine,depth,planId,rangeId:id,assessment:planned.summary.assessment,counts:planned.summary.counts,work:planned.summary.work,sse:done.job.summary.groups[0].metric.sse,hashes,candidateIds:publication.createdIds,newAttempts:{cancelledId:newId,replayedId:unknownId},relationKeys,planKeys,viewFences:['selection','observation-close','actor-change'],before:before.positionUs,after:after.positionUs,sameTracks:true,pageErrors:errors,realAccessControlNegativeControl:engine==='webkit'},null,2));console.log(`PASS ${engine}/${depth}: explicit clock relation, durable plan, exact AU facts, stable retries, scores/candidate/original pixels, view fences and independent playback`);
}catch(error){const target=viewer&&!viewer.isClosed()?viewer:page;if(target&&!target.isClosed())await saveBrowserFailure({page:target,directory,name:'correspondence',context:{engine,depth,phase},error,evidence:target===viewer?viewerEvidence:evidence}).catch(()=>{});throw error;}
finally{clearInterval(progress);Atomics.store(gate,0,1);Atomics.notify(gate,0);await browser?.close();await service?.close();await rm(temp,{recursive:true,force:true});}
