import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadConfig} from '../../server/config.ts';
import {startService} from '../../server/runtime.ts';
import {AnnotationStore} from '../../server/annotations.ts';
import {QualityJobService} from '../../server/analysis/quality/job-service.ts';
import {openIndexDatabase} from '../../server/sqlite.ts';
import {SSIM_VARIANT} from '../../shared/analysis/quality/ssim.ts';
// @ts-ignore shared test readiness helper
import {waitForAnnotationMedia} from '../../scripts/testing/agent-annotations-ready.mjs';

const fixtures=JSON.parse(await readFile(new URL('../helpers/quality-http-samples.json',import.meta.url),'utf8')).samples;
const pause=()=>new Promise(r=>setTimeout(r,20));
for(const [codec,depth] of [['h264',8],['hevc',10]] as const)test(`bounded ranges real HTTP ${codec}/${depth}: native SSE, coverage, frozen publication, restart and receipt-first replay`,{timeout:90000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vp-range-http-')),media=join(dir,'media');let service:Awaited<ReturnType<typeof startService>>|undefined;
  t.after(async()=>{await service?.close();await rm(dir,{recursive:true,force:true});});await mkdir(media);
  const sample=fixtures.find((s:any)=>s.codec===codec&&s.depth===depth&&s.tagged),bytes=Buffer.from(sample.flv,'base64'),native=Buffer.from(sample.native,'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),sample.flvSha256);assert.equal(createHash('sha256').update(native).digest('hex'),sample.nativeSha256);
  for(const name of ['B.flv','C.flv'])await writeFile(join(media,name),bytes);
  const untagged=fixtures.find((s:any)=>s.codec==='h264'&&s.depth===8&&!s.tagged);await writeFile(join(media,'U.flv'),Buffer.from(untagged.flv,'base64'));
  const config=await loadConfig([],'production',dir,{staticDir:resolve('public'),dataDir:join(dir,'data'),allowEmptyRoots:true});config.logsDir=null;config.mediaRoots=[media];config.indexWatch=false;config.port=0;
  service=await startService(config,false);await service.library.refresh();const entries=await waitForAnnotationMedia(service.library,['B.flv','C.flv','U.flv']);
  const base=`http://127.0.0.1:${(service.server.address() as any).port}`;config.port=(service.server.address() as any).port;
  const actor=`guest-${randomUUID()}`,cookie=`voidplayer-user=${actor}`,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'};
  const get=async(url:string,extra:Record<string,string>={})=>fetch(base+url,{headers:{...headers,...extra}});
  const post=async(url:string,body:unknown,key='key')=>fetch(base+url,{method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body)});
  const targetFactories=[];
  for(const entry of entries){
    const build=await post(`/api/media/${entry.id}/psnr-index`,{version:entry.version});
    // Explicit source-build has its own action header.
    assert.equal(build.status,403);
    const built=await fetch(`${base}/api/media/${entry.id}/psnr-index`,{method:'POST',headers:{...headers,'x-voidplayer-action':'quality-source-build'},body:JSON.stringify({version:entry.version})});assert.equal(built.status,200,await built.clone().text());const proof=await built.json();
    const cache=await get(`/api/media/${entry.id}/frame-index?v=${entry.version}`).then(r=>r.json());
    targetFactories.push((au:number)=>({...proof.binding,sourcePtsUs:cache.index.packets[au][2],picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}}));
  }
  const [reference,distorted,unsupported]=targetFactories;
  const input={schema:'voidplayer-quality-range',version:1,client:{id:'range-http',kind:'agent'},interval:{startAu:0,endAu:1},correspondence:{mode:'explicit-au-table'},sampling:{mode:'all'},
    pairs:[0,1].map(au=>({pairing:'caller-specified',reference:reference(au),distorted:distorted(1-au),roi:{x:0,y:0,width:32,height:32},spatial:{blockWidth:16,blockHeight:16},ssim:{variant:SSIM_VARIANT},budget:{maxReadBytes:1024*1024,maxInputBytes:1024*1024}})),
    budget:{maxReadBytes:2*1024*1024,maxInputBytes:2*1024*1024,maxPackets:4,maxOutputFrames:4,maxElapsedMs:30000}};
  const wait=async(id:string)=>{for(let n=0;n<500;n++){const response=await get(`/api/quality/ranges/${id}`);assert.equal(response.status,200);const d=await response.json();if(!['queued','running','cancelling'].includes(d.job.state))return d;await pause();}assert.fail('Range did not terminate');};
  assert.equal((await post('/api/quality/ranges/plan',input)).status,200);
  assert.equal((await get('/api/quality/ranges')).status,200);assert.equal((await get('/api/quality/ranges').then(r=>r.json())).entries.length,0,'planning does not submit');
  const submitted=await post('/api/quality/ranges',input);assert.equal(submitted.status,202,await submitted.clone().text());const first=(await submitted.json()).job;
  const done=await wait(first.id);assert.equal(done.job.state,'completed',JSON.stringify(done));assert.equal(done.coverage.complete,true);assert.deepEqual(done.coverage.scored,[0,1]);assert.deepEqual(done.coverage.holes,[]);
  assert.equal(done.job.samples.length,2);assert.equal(done.job.summary.groups.length,1);
  const perPlane=[0,0,0],unit=depth===8?1:2,frame=1536*unit;
  for(let plane=0,offset=0;plane<3;plane++){const count=plane===0?1024:256;for(let i=0;i<count;i++){const at=(offset+i)*unit,a=unit===1?native[at]:native.readUInt16LE(at),b=unit===1?native[frame+at]:native.readUInt16LE(frame+at);perPlane[plane]+=(a-b)**2;}offset+=count;}
  const firstPage=await get(`/api/quality/ranges/${first.id}/results?limit=1`).then(r=>r.json());assert.equal(firstPage.entries.length,1);assert.equal(firstPage.nextAu,1);
  const secondPage=await get(`/api/quality/ranges/${first.id}/results?after=1&limit=1`).then(r=>r.json());assert.equal(secondPage.entries[0].au,1);assert.equal(secondPage.nextAu,null);
  for(const page of [firstPage,secondPage]){const r=page.entries[0].result.value.result;assert.deepEqual(['y','u','v'].map(p=>r.metric.planes[p].sse),perPlane);assert.equal(r.metric.spatial.blocks.length,4);assert.ok(r.ssim.planes.y.windows>0);assert.equal(r.work.outputFrames,2);}
  assert.equal(done.job.summary.groups[0].metric.sse,2*perPlane.reduce((a,b)=>a+b,0));assert.equal(done.job.summary.groups[0].metric.samples,3072);
  assert.equal((await get(`/api/quality/ranges/${first.id}`,{cookie:`voidplayer-user=guest-${randomUUID()}`})).status,404);
  assert.equal((await get(`/api/quality/ranges/${first.id}`,{'x-voidplayer-actor':`guest-${randomUUID()}`})).status,409);
  assert.equal((await post('/api/quality/ranges',input)).status,200);
  const reordered={budget:Object.fromEntries(Object.entries(input.budget).reverse()),pairs:[...input.pairs].reverse(),sampling:input.sampling,correspondence:input.correspondence,interval:{endAu:1,startAu:0},client:{kind:'agent',id:input.client.id},version:1,schema:input.schema};
  const orderReplay=await post('/api/quality/ranges',reordered);assert.equal(orderReplay.status,200);assert.equal((await orderReplay.json()).job.id,first.id);
  assert.equal((await post('/api/quality/ranges',{...input,client:{...input.client,kind:'browser'}})).status,409);
  const changed=structuredClone(input);changed.pairs[0].roi.width=30;assert.equal((await post('/api/quality/ranges',changed)).status,400,'invalid SSIM edge is rejected before idempotency conflict');
  const policy={space:'default',side:'reference',metric:'psnr',maxDb:120,limit:1,minAuDistance:1,text:'Range measurement candidate',severity:3};
  const mutate=AnnotationStore.prototype.mutate;let injected=false;
  AnnotationStore.prototype.mutate=function(...args:Parameters<AnnotationStore['mutate']>){if(!injected&&(args[1] as {action?:string}).action==='create-quality-candidate'){injected=true;if(codec==='h264')throw new Error('test: failed before annotation commit');const value=mutate.apply(this,args);throw new Error('test: response lost after annotation commit');}return mutate.apply(this,args);};
  try{assert.equal((await post(`/api/quality/ranges/${first.id}/candidates`,policy)).status,500);}finally{AnnotationStore.prototype.mutate=mutate;}
  assert.equal(injected,true);const frozen=await get(`/api/quality/ranges/${first.id}/candidates`).then(r=>r.json());assert.equal(frozen.selected.length,1);assert.deepEqual(frozen.createdIds,[]);
  const pendingRelease=await post(`/api/tasks/range/${first.id}/release-result`,{});assert.equal(pendingRelease.status,200);
  const pinned=(await pendingRelease.json()).retainedChildren;assert.equal(pinned.length,1);assert.equal(service.quality.qualityRanges.referencesResult(pinned[0]),true,'frozen publication pins even before an annotation transaction exists');
  const published=await post(`/api/quality/ranges/${first.id}/candidates`,policy).then(r=>r.json());assert.deepEqual(published.createdIds,frozen.selected.map((x:any)=>x.id));
  const annotation=await get(`/api/annotations/spaces/default/${published.createdIds[0]}`).then(r=>r.json());assert.equal(annotation.revision,1);assert.equal(annotation.document.mark.text,policy.text);assert.equal(annotation.document.mark.qualityEvidence.length,1);
  assert.equal((await post(`/api/quality/ranges/${first.id}/candidates`,{...policy,severity:4})).status,409);
  const partial=structuredClone(input);partial.pairs[1].reference.sourcePtsUs++;const acceptedPartial=await post('/api/quality/ranges',partial,'partial').then(r=>r.json()),p=await wait(acceptedPartial.job.id);assert.equal(p.job.state,'partial');assert.deepEqual(p.coverage.holes,[1]);assert.deepEqual(p.coverage.unsupported,[]);
  const stride={...input,sampling:{mode:'stride',every:2,offset:0}},acceptedStride=await post('/api/quality/ranges',stride,'stride').then(r=>r.json()),s=await wait(acceptedStride.job.id);assert.equal(s.job.state,'completed');assert.equal(s.coverage.complete,false);assert.deepEqual(s.coverage.unsampled,[1]);assert.deepEqual(s.coverage.holes,[]);
  const holes={...input,interval:{startAu:0,endAu:2}},acceptedHoles=await post('/api/quality/ranges',holes,'holes').then(r=>r.json()),h=await wait(acceptedHoles.job.id);assert.equal(h.job.state,'partial');assert.deepEqual(h.coverage.unmapped,[2]);assert.deepEqual(h.coverage.holes,[2]);
  const missing=structuredClone(input);missing.pairs=missing.pairs.map((p,au)=>({...p,reference:unsupported(au),distorted:unsupported(1-au)}));const acceptedMissing=await post('/api/quality/ranges',missing,'unsupported').then(r=>r.json()),u=await wait(acceptedMissing.job.id);assert.equal(u.job.state,'failed');assert.deepEqual(u.coverage.unsupported.map((x:any)=>x.au),[0,1]);assert.deepEqual(u.coverage.holes,[0,1]);
  const parentRelease=await post(`/api/tasks/range/${first.id}/release-result`,{});assert.equal(parentRelease.status,200);
  const releaseReceipt=await parentRelease.json();assert.equal(releaseReceipt.retainedChildren.length,1,'published evidence remains pinned');assert.equal(releaseReceipt.releasedChildren.length,1);
  const archived=await get(`/api/quality/ranges/${first.id}`).then(r=>r.json());assert.deepEqual(archived.job.summary,done.job.summary);assert.deepEqual(archived.coverage,done.coverage);
  assert.equal((await get(`/api/quality/ranges/${first.id}/results`)).status,409);
  assert.equal((await post(`/api/tasks/single/${releaseReceipt.retainedChildren[0]}/release-result`,{})).status,409);
  const snapshot=await get('/api/tasks?kind=range').then(r=>r.json()),projection=snapshot.entries.find((j:any)=>j.id===first.id);
  assert.equal(projection.result.available,false);assert.equal(projection.result.released,true);assert.equal(projection.result.retained,0);assert.equal(projection.result.scored,2);
  await post(`/api/tasks/range/${first.id}/release-result`,{});
  assert.equal((await get(`/api/quality/ranges/${first.id}`).then(r=>r.json())).job.revision,archived.job.revision,'release replay does not churn revisions');
  const unpublished=await post(`/api/tasks/range/${s.job.id}/release-result`,{});assert.equal(unpublished.status,200);assert.equal((await unpublished.json()).retainedChildren.length,0);
  assert.equal((await post(`/api/quality/ranges/${s.job.id}/candidates`,policy)).status,409,'archived input cannot generate new evidence');
  assert.equal((await post('/api/quality/ranges',stride,'stride').then(r=>r.json())).job.id,s.job.id,'original submission remains the same archived receipt');
  // Inject loss after one real child transaction. Parent intent already committed;
  // restart/replay must settle the remainder without restoring scores or running work.
  const releaseChild=QualityJobService.prototype.releaseResult;let lost=false;
  QualityJobService.prototype.releaseResult=function(id:string,owner:string){const value=releaseChild.call(this,id,owner);if(!lost&&id===h.job.samples[0].jobId){lost=true;throw Error('response lost after child release');}return value;};
  try{assert.equal((await post(`/api/tasks/range/${h.job.id}/release-result`,{})).status,500);}finally{QualityJobService.prototype.releaseResult=releaseChild;}
  assert.equal(lost,true);const pending=await get(`/api/tasks/range/${h.job.id}`).then(r=>r.json());assert.equal(pending.task.result.releasePending,true);assert.ok(pending.links.some((l:any)=>l.rel==='release-result'));
  const saved=archived.job;await service.close();service=undefined;
  const db=openIndexDatabase(join(config.dataDir,'library.sqlite.quality.sqlite'));try{for(const sample of saved.samples)db.prepare('UPDATE quality_jobs SET result_json=NULL,result_sha=NULL WHERE id=?').run(sample.jobId);}finally{db.close();}
  service=await startService(config,false);
  const settled=await post(`/api/tasks/range/${h.job.id}/release-result`,{});assert.equal(settled.status,200);assert.equal((await settled.json()).retainedChildren.length,0);
  for(const sample of h.job.samples){assert.equal(service.quality.qualityRanges.referencesResult(sample.jobId),false);assert.equal((await get(`/api/quality/jobs/${sample.jobId}/result`)).status,409);}
  const finalDetail=await get(`/api/tasks/range/${h.job.id}`).then(r=>r.json());assert.equal(finalDetail.task.result.releasePending,false);assert.equal(finalDetail.links.some((l:any)=>l.rel==='release-result'),false);
  const restored=await get(`/api/quality/ranges/${first.id}`).then(r=>r.json());assert.deepEqual(restored.job,saved);
  const replayed=await post(`/api/quality/ranges/${first.id}/candidates`,policy).then(r=>r.json());assert.deepEqual(replayed.createdIds,published.createdIds,'annotation receipt precedes unavailable private result lookup');
  const record=await get(`/api/annotations/spaces/default/${published.createdIds[0]}`).then(r=>r.json());assert.equal(record.revision,1);
});
