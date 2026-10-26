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

const root=path.resolve(import.meta.dirname,'..'),engine=process.argv[2]??'chromium',depth=Number(process.argv[3]??8);
assert.ok(['chromium','webkit'].includes(engine)&&[8,10].includes(depth));
const directory=process.env.VOIDPLAYER_TEST_ARTIFACTS??path.join(root,'.run/quality-ranges',`${engine}-${depth}`),temp=await mkdtemp(path.join(os.tmpdir(),'vp-ranges-browser-'));
let service,browser,page,evidence,phase='setup';const gate=new Int32Array(new SharedArrayBuffer(8)),workers=new Set();
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
  const e=entry(name),r=await fetch(`${base}/api/media/${e.id}/psnr-index`,{method:'POST',headers:{...headers,'x-voidplayer-action':'quality-source-build'},body:JSON.stringify({version:e.version})});assert.equal(r.status,200,await r.clone().text());const proof=await r.json(),index=await get(`/api/media/${e.id}/frame-index?v=${e.version}`);
  factories.push(au=>({...proof.binding,sourcePtsUs:index.index.packets[au][2],picture:{sourceVersion:`${e.id}@${e.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}}));
 }
 const runner=service.library.quality,originalFactory=runner.createWorker;
 runner.createWorker=data=>{
  if(data.mode!=='measure')return originalFactory(data);
  const worker=new Worker(new URL('../test/helpers/quality-workflow-worker.ts',import.meta.url),{workerData:{...data,gate:gate.buffer},resourceLimits:{maxOldGenerationSizeMb:256}});
  workers.add(worker);worker.once('exit',()=>workers.delete(worker));return worker;
 };
 browser=await ({chromium,webkit}[engine]).launch({headless:true});const context=await browser.newContext({locale:'en-US',viewport:{width:1400,height:1000},deviceScaleFactor:2});
 await context.addCookies([{name:'voidplayer-user',value:cookie.split('=')[1],url:base}]);
 await context.addInitScript(()=>{
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
 page=await context.newPage();evidence=recordBrowserEvidence(page);await page.goto(base+'/admin/#quality');await page.locator('#quality-ranges').waitFor();
 const [reference,distorted]=factories,input={schema:'voidplayer-quality-range',version:1,client:{id:'browser-range-agent',kind:'agent'},interval:{startAu:0,endAu:1},correspondence:{mode:'explicit-au-table'},sampling:{mode:'all'},
  pairs:[0,1].map(au=>({pairing:'caller-specified',reference:reference(au),distorted:distorted(1-au),roi:{x:0,y:0,width:32,height:32},spatial:{blockWidth:16,blockHeight:16},ssim:{variant:SSIM_VARIANT},budget:{maxReadBytes:1024*1024,maxInputBytes:1024*1024}})),
  budget:{maxReadBytes:2*1024*1024,maxInputBytes:2*1024*1024,maxPackets:4,maxOutputFrames:4,maxElapsedMs:30000}};
 phase='background-decode-gate';const planned=await post('/api/quality/ranges/plan',input);assert.equal(planned.preRollAndDrain.outputFrames,4);
 const accepted=await post('/api/quality/ranges',input),id=accepted.job.id;
 await until(()=>Atomics.load(gate,1),Boolean,'actual Worker never reached decode barrier');await page.locator(`[data-range-id="${id}"]`).waitFor();await page.close();
 assert.equal((await get(`/api/quality/ranges/${id}`)).job.state,'running');assert.equal(workers.size,1);
 Atomics.store(gate,0,1);Atomics.notify(gate,0);
 const done=await until(()=>get(`/api/quality/ranges/${id}`),d=>!['queued','running','cancelling'].includes(d.job.state),'background range never finished');assert.equal(done.job.state,'completed',JSON.stringify(done));assert.equal(done.coverage.complete,true);assert.equal(done.job.summary.scoredPairs,2);assert.equal(workers.size,0);
 const unit=depth===8?1:2,frame=1536*unit;let sse=0;for(let i=0;i<1536;i++){const at=i*unit,aa=unit===1?native[at]:native.readUInt16LE(at),bb=unit===1?native[frame+at]:native.readUInt16LE(frame+at);sse+=(aa-bb)**2;}assert.equal(done.job.summary.groups[0].metric.sse,sse*2);
 phase='passive-reopen';page=await context.newPage();evidence=recordBrowserEvidence(page);await page.goto(base+'/admin/#quality');const row=page.locator(`[data-range-id="${id}"]`);await row.waitFor();await row.focus();
 await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/ranges');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
 assert.equal(await row.evaluate(node=>document.activeElement===node),true,'passive list polling preserves focused row');
 let lostResult=false;await page.route(`**/api/quality/ranges/${id}/results?*`,async route=>{if(!lostResult){lostResult=true;await route.abort('failed');}else await route.continue();});
 await row.click();await page.locator('#quality-range-title').filter({hasText:'completed'}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('#quality-range-results > section').length===2);assert.equal(await page.locator('#quality-range-results > section').count(),2);assert.equal(lostResult,true,'lost result-page response was retried at unchanged job revision');
 const policy={space:'default',side:'reference',metric:'psnr',maxDb:120,limit:1,minAuDistance:1,text:'Explicit range candidate',severity:3},publication=await post(`/api/quality/ranges/${id}/candidates`,policy);assert.equal(publication.createdIds.length,1);
 const annotation=await get(`/api/annotations/spaces/default/${publication.createdIds[0]}`);assert.equal(annotation.revision,1);assert.equal(annotation.document.mark.qualityEvidence.length,1);
 await page.locator(`[data-candidate-id="${publication.createdIds[0]}"]`).waitFor();await page.screenshot({path:path.join(directory,'ranges.png'),fullPage:true});
 phase='late-result-view-fences';
 await page.unroute(`**/api/quality/ranges/${id}/results?*`);
 const other=await post('/api/quality/ranges',{...input,sampling:{mode:'stride',every:2,offset:0}},'unpublished-range'),otherId=other.job.id;
 await until(()=>get(`/api/quality/ranges/${otherId}`),d=>d.job.state==='completed','unpublished comparison range did not finish');
 await page.locator('#quality-range-refresh').click();await page.locator(`[data-range-id="${otherId}"]`).waitFor();
 async function holdResults(target){
  let enter,release,finish;const seen=new Promise(r=>enter=r),gate=new Promise(r=>release=r),finished=new Promise(r=>finish=r),pattern=`**/api/quality/ranges/${target}/results?*`;
  const handler=async route=>{enter();await gate;try{await route.continue();}catch{/* Switching actor/closing observation aborts the actual request. */}finally{finish();}};
  await page.route(pattern,handler);return {seen,finished,release,async dispose(){release();await page.unroute(pattern,handler);}};
 }
 // This assertion observes DOM facts, independent of background-tab rAF.
 const frames=()=>page.waitForTimeout(100);
 const assertUnpublished=async()=>{const state=await page.evaluate(()=>({title:document.querySelector('#quality-range-title').textContent,candidates:document.querySelector('#quality-range-candidates').textContent,visible:!document.querySelector('#quality-range-detail').hidden}));assert.equal(state.visible,true);assert.ok(state.title.includes(otherId));assert.ok(!state.candidates.includes(publication.createdIds[0]));assert.ok(!state.candidates.includes(policy.text));};
 await page.locator(`[data-range-id="${otherId}"]`).click();await page.waitForFunction(id=>document.querySelector('#quality-range-title').textContent.includes(id),otherId);
 phase='late-selection-results';const heldA=await holdResults(id),heldB=await holdResults(otherId);
 try{
  await page.locator(`[data-range-id="${id}"]`).click();await bounded(heldA.seen,'heldA seen');
  await page.locator(`[data-range-id="${otherId}"]`).click();const responseA=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/quality/ranges/${id}/results`);heldA.release();
  await bounded(heldB.seen,'heldB seen');assert.equal((await bounded(responseA,'released A response headers')).status(),200);phase='late-selection-assert';await frames();await assertUnpublished();
  heldB.release();await bounded(heldB.finished,'heldB finished');await page.waitForFunction(()=>document.querySelector('#quality-range-candidates').textContent==='');
 }finally{await heldA.dispose();await heldB.dispose();}
 phase='late-close-results';const closing=await holdResults(id);
 try{
  await page.locator(`[data-range-id="${id}"]`).click();await bounded(closing.seen,'closing seen');await page.locator('[data-pane="overview"]').click();
  closing.release();await bounded(closing.finished,'closing finished');await frames();assert.equal(await page.locator('#quality-range-detail').evaluate(node=>node.hidden),true);assert.equal(await page.locator('#quality-range-candidates').textContent(),'');
  await page.locator('[data-pane="quality"]').click();await page.locator(`[data-range-id="${otherId}"]`).click();await page.waitForFunction(id=>document.querySelector('#quality-range-title').textContent.includes(id),otherId);await assertUnpublished();
 }finally{await closing.dispose();}
 phase='late-identity-results';const identityGate=await holdResults(id);
 async function peerIdentity(input){return player.evaluate(async input=>{const r=await fetch('/api/identity',{method:'POST',headers:{'content-type':'application/json','x-voidplayer-action':'identity'},body:JSON.stringify(input)});if(!r.ok)throw Error(await r.text());const value=await r.json(),health=await fetch('/api/health',{cache:'no-store'}).then(r=>r.json());if(health.actor?.id!==value.actor.id)throw Error('Peer cookie did not adopt actor');localStorage.setItem('voidplayer.identity',JSON.stringify(value.actor));return value.actor;},input);}
 try{
  await page.locator(`[data-range-id="${id}"]`).click();await bounded(identityGate.seen,'identityGate seen');const different=await peerIdentity({name:'Range race peer',mode:'create'});
  await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/ranges'&&r.request().headers()['x-voidplayer-actor']===different.id&&r.status()===200);identityGate.release();await bounded(identityGate.finished,'identityGate finished');await frames();
  assert.equal(await page.locator('#quality-range-detail').evaluate(node=>node.hidden),true);assert.equal(await page.locator('#quality-range-candidates').textContent(),'');assert.equal(await page.locator('[data-range-id]').count(),0);
  await peerIdentity({id:actor.id});await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/quality/ranges'&&r.request().headers()['x-voidplayer-actor']===actor.id&&r.status()===200);await page.locator(`[data-range-id="${otherId}"]`).click();await page.waitForFunction(id=>document.querySelector('#quality-range-title').textContent.includes(id),otherId);await assertUnpublished();
 }finally{await identityGate.dispose();}
 assert.equal(await get(`/api/quality/ranges/${otherId}/candidates`),null,'late replies never publish into another range');
 await page.locator(`[data-range-id="${id}"]`).click();await page.locator(`[data-candidate-id="${publication.createdIds[0]}"]`).waitFor();
 phase='original-frame-review';const requests=[],observe=r=>{try{requests.push({owner:r.frame().page(),url:r.url(),method:r.method()});}catch{/* Worker requests have no frame. */}};context.on('request',observe);
 const [viewer]=await Promise.all([page.waitForEvent('popup'),page.locator(`[data-candidate-id="${publication.createdIds[0]}"]`).click()]);
 await viewer.waitForFunction(()=>['ready','failed'].includes(window.voidPlayerQualityPair?.getState().state));const state=await viewer.evaluate(()=>window.voidPlayerQualityPair.getState());assert.equal(state.state,'ready',JSON.stringify(state));
 const expected=[0,1].map(i=>createHash('sha256').update(native.subarray(i*frame,(i+1)*frame)).digest('hex')),hashes=await viewer.evaluate(()=>window.__rangePairHashes);assert.deepEqual(hashes,expected);
 await viewer.locator('#pair-block-selection').selectOption('3');assert.equal((await viewer.evaluate(()=>window.voidPlayerQualityPair.getState())).selectedBlock,3);assert.equal(await viewer.locator('.quality-selected-block').count(),2);await viewer.screenshot({path:path.join(directory,'original-pair.png')});
 context.off('request',observe);const viewerRequests=requests.filter(r=>r.owner===viewer);assert.deepEqual(viewerRequests.filter(r=>r.method!=='GET'&&new URL(r.url).pathname.startsWith('/api/')),[],'read-only viewer does not mutate');
 assert.deepEqual(viewerRequests.filter(r=>new URL(r.url).pathname.startsWith('/api/quality/')),[],'viewer does not read private results or rescore');
 assert.deepEqual(viewerRequests.filter(r=>new URL(r.url).searchParams.has('build')),[],'viewer never builds indexes');
 const after=await player.evaluate(()=>window.voidPlayer.getState());assert.equal(after.playing,true);assert.ok(after.positionUs>before.positionUs);assert.deepEqual(after.tracks.map(t=>t.id),before.tracks.map(t=>t.id));assert.equal(after.marks.length,before.marks.length);
 assert.deepEqual(errors,[]);await writeFile(path.join(directory,'evidence.json'),JSON.stringify({engine,depth,id,coverage:done.coverage,summary:done.job.summary,candidateId:publication.createdIds[0],nativeHashes:hashes,selectedBlock:3,viewFences:['selection','observation-close','actor-change'],player:{beforePosition:before.positionUs,afterPosition:after.positionUs,sameTracks:true},pageErrors:errors},null,2)+'\n');
 console.log(`PASS ${engine}/${depth}: service-owned range survives closed observer; AU coverage/native SSE, policy candidate, original-plane hashes/block3 independent A playback and late selection/close/actor fences`);
}catch(error){if(page&&!page.isClosed())await saveBrowserFailure({page,directory,name:'quality-ranges',context:{engine,depth,phase},error,evidence}).catch(()=>{});throw error;}
finally{clearInterval(progress);Atomics.store(gate,0,1);Atomics.notify(gate,0);await browser?.close();await service?.close();await rm(temp,{recursive:true,force:true});}
