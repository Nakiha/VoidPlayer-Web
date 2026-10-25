import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { MediaLibraryIndex } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import { encodedPair } from '../helpers/library-pair-fixture.ts';
import type { QualityJob,QualityJobInput,QualityJobResult } from '../../shared/analysis/quality/jobs.ts';
import type { PairTarget } from '../../shared/analysis/quality/frame-pair.ts';
import { validatePsnrSpatial } from '../../shared/analysis/quality/psnr-spatial.ts';

async function terminal(base:string,id:string,headers:Record<string,string>){
 for(let i=0;i<300;i++){
  const response=await fetch(`${base}/api/quality/jobs/${id}`,{headers});assert.equal(response.status,200);const job=await response.json()as QualityJob;
  if(['completed','failed','cancelled','interrupted'].includes(job.state))return job;
  await new Promise(resolve=>setTimeout(resolve,20));
 }assert.fail('HTTP quality job did not reach a terminal commit');
}
export function assertNativeJob(result:QualityJobResult,raw:Uint8Array,depth:8|10){
 const value=result.value,bytes=depth===8?1:2,frame=1536*bytes,view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);let aggregate=0;
 for(const [i,name]of ['y','u','v'].entries()){
  const width=i?16:32,offset=[0,1024,1280][i],scale=i?2:1;let sse=0,samples=0;
  for(let y=4/scale;y<24/scale;y++)for(let x=2/scale;x<26/scale;x++){
   const at=(offset+y*width+x)*bytes,a=bytes===1?raw[at]:view.getUint16(at,true),b=bytes===1?raw[frame+at]:view.getUint16(frame+at,true);sse+=(a-b)**2;samples++;
  }
  assert.equal(value.result.metric.planes[name as 'y'|'u'|'v'].sse,sse);assert.equal(value.result.metric.planes[name as 'y'|'u'|'v'].samples,samples);aggregate+=sse;
 }
 assert.equal(value.result.metric.aggregate.sse,aggregate);assert.ok(aggregate>0);assert.equal(value.result.metric.bitDepth,depth);
 if(value.result.metric.spatial){validatePsnrSpatial(value.result.metric);for(const block of value.result.metric.spatial.blocks){let sum=0;const r=block.roi;
  for(const [i,name]of ['y','u','v'].entries()){const width=i?16:32,offset=[0,1024,1280][i],scale=i?2:1;let sse=0,samples=0;
   for(let y=r.y/scale;y<(r.y+r.height)/scale;y++)for(let x=r.x/scale;x<(r.x+r.width)/scale;x++){const at=(offset+y*width+x)*bytes,a=bytes===1?raw[at]:view.getUint16(at,true),b=bytes===1?raw[frame+at]:view.getUint16(frame+at,true);sse+=(a-b)**2;samples++;}
   assert.equal(block.planes[name as 'y'].sse,sse);assert.equal(block.planes[name as 'y'].samples,samples);sum+=sse;
  }assert.equal(block.aggregate.sse,sum);
 }}
}
for(const [codec,depth]of [['h264',8],['hevc',8],['hevc',10]]as const)test(`durable HTTP ${codec} ${depth}-bit: native SSE, idempotency and restart history`,{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-quality-jobs-http-')),media=join(dir,'media'),database=join(dir,'library.sqlite');
 let library:MediaLibraryIndex|undefined,server:ReturnType<typeof createMediaServer>|undefined;
 const stop=async()=>{if(server){const prior=server;server=undefined;await new Promise<void>(resolve=>prior.close(()=>resolve()));}if(library){const prior=library;library=undefined;await prior.close();}};
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 await mkdir(media);const fixture=await encodedPair(dir,codec,depth);
 for(const role of ['reference','distorted'])await writeFile(join(media,role+'.flv'),fixture.bytes);
 const start=async()=>{library=new MediaLibraryIndex([media],{database,watch:false});library.qualityJobs;await library.refresh();server=createMediaServer({library,roots:[media],onLog(){}});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address()as AddressInfo).port}`;};
 let base=await start();const cookie=`voidplayer-user=guest-${randomUUID()}`,headers={cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'};
 const discovery=await fetch(base+'/api/agent',{headers:{cookie}}).then(r=>r.json());
 assert.equal(discovery.capabilities.find((c:any)=>c.id==='quality.jobs').readiness,'per-source');
 assert.deepEqual(discovery.qualityJobs.metrics,['psnr']);assert.equal(discovery.qualityJobs.scope,'single-explicit-frame-pair');
 const entries=(await fetch(base+'/api/library').then(r=>r.json())).entries,targets:PairTarget[]=[],proofs=[];
 for(const [au,role]of ['reference','distorted'].entries()){
  const entry=entries.find((e:any)=>e.name===role+'.flv');assert.ok(entry);
  const built=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`);assert.equal(built.status,200);const cache=await built.json();
  const lookup=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});assert.equal(lookup.status,200);const proof=await lookup.json();proofs.push(proof);
  targets.push({...proof.binding,sourcePtsUs:cache.index.packets[au][2],picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
 }
 const input:QualityJobInput={schema:'voidplayer-psnr-frame-job',version:1,client:{id:'http-native-test',kind:'agent'},request:{pairing:'caller-specified',reference:targets[0],distorted:targets[1],roi:{x:2,y:4,width:24,height:20},spatial:{blockWidth:10,blockHeight:8}}};
 for(const [grid,status,code]of [[{blockWidth:3,blockHeight:8},400,'invalid-input'],[{blockWidth:2,blockHeight:2},413,'budget-exceeded'],[{blockWidth:10,blockHeight:8,extra:true},400,'invalid-input']]as const){
  const rejected=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'bad-grid'},body:JSON.stringify({...input,request:{...input.request,spatial:grid}})});assert.equal(rejected.status,status);assert.equal((await rejected.json()).code,code);
 }
 assert.deepEqual((await fetch(base+'/api/quality/jobs',{headers:{cookie}}).then(r=>r.json())).entries,[],'bad grids cannot allocate a durable job');
 const actor=cookie.slice(16),otherCookie=`voidplayer-user=guest-${randomUUID()}`;
 const stale=await fetch(base+discovery.qualityJobs.submit,{method:'POST',headers:{...headers,cookie:otherCookie,'x-voidplayer-actor':actor,'idempotency-key':'native-job'},body:JSON.stringify(input)});
 assert.equal(stale.status,409);assert.equal((await stale.json()).code,'actor-changed');
 for(const observedCookie of [cookie,otherCookie]){const history=await fetch(base+'/api/quality/jobs',{headers:{cookie:observedCookie}}).then(r=>r.json());assert.deepEqual(history.entries,[]);assert.equal(history.resources.activeAttempts,0);assert.equal(history.resources.queued,0);}
 const staleRead=await fetch(base+'/api/quality/jobs',{headers:{cookie:otherCookie,'x-voidplayer-actor':actor}});assert.equal(staleRead.status,409);assert.equal((await staleRead.json()).code,'actor-changed');
 const submit=()=>fetch(base+discovery.qualityJobs.submit,{method:'POST',headers:{...headers,origin:base,'x-voidplayer-actor':actor,'idempotency-key':'native-job'},body:JSON.stringify(input)});
 const response=await submit();assert.equal(response.status,202);const accepted=await response.json();assert.equal(accepted.replayed,false);const id=accepted.job.id;
 assert.deepEqual(accepted.job.input.request.spatial,input.request.spatial);
 assert.equal(accepted.job.submitted.requestId,response.headers.get('x-request-id'));assert.equal(response.headers.get('location'),`/api/quality/jobs/${id}`);
 const job=await terminal(base,id,{cookie});assert.equal(job.state,'completed',JSON.stringify(job));assert.equal(job.attempt?.number,1);assert.equal(job.progress.scoredPairs,1);
 const storedResponse=await fetch(`${base}/api/quality/jobs/${id}/result`,{headers:{cookie}});assert.equal(storedResponse.status,200);const result=await storedResponse.json()as QualityJobResult;
 assertNativeJob(result,fixture.native,depth);assert.deepEqual(result.value.sources,{reference:proofs[0],distorted:proofs[1]});
 assert.equal(result.value.execution.runtime,process.versions.bun?'bun':'node');assert.match(result.value.result.decoder.buildId,/^[a-f0-9]{40}$/);
 assert.equal(result.jobId,id);assert.equal(result.attemptId,job.attempt!.id);assert.equal(result.submitted.actorId,cookie.slice(16));
 const replay=await submit();assert.equal(replay.status,200);const replayed=await replay.json();assert.equal(replayed.replayed,true);assert.deepEqual(replayed.job,job);
 assert.notEqual(replay.headers.get('x-request-id'),replayed.job.submitted.requestId,'observing the receipt never replaces original attribution');
 const staleRetry=await fetch(base+discovery.qualityJobs.submit,{method:'POST',headers:{...headers,cookie:otherCookie,'x-voidplayer-actor':actor,'idempotency-key':'native-job'},body:JSON.stringify(input)});assert.equal(staleRetry.status,409);assert.equal((await staleRetry.json()).code,'actor-changed');
 const staleCancel=await fetch(`${base}/api/quality/jobs/${id}/cancel`,{method:'POST',headers:{...headers,cookie:otherCookie,'x-voidplayer-actor':actor},body:'{}'});assert.equal(staleCancel.status,409);assert.equal((await staleCancel.json()).code,'actor-changed');
 const headerless=await fetch(base+discovery.qualityJobs.submit,{method:'POST',headers:{...headers,'idempotency-key':'native-job'},body:JSON.stringify(input)});assert.equal(headerless.status,200);assert.equal((await headerless.json()).job.id,id,'legacy cookie-only Agent replay remains valid');
 assert.deepEqual((await fetch(base+'/api/quality/jobs',{headers:{cookie:otherCookie}}).then(r=>r.json())).entries,[],'a mismatched captured actor never creates work for the new cookie actor');
 const conflict=structuredClone(input);conflict.request.roi.width-=2;
 const collision=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'native-job'},body:JSON.stringify(conflict)});assert.equal(collision.status,409);assert.equal((await collision.json()).code,'idempotency-conflict');
 const gridConflict=structuredClone(input);gridConflict.request.spatial!.blockWidth=12;
 const gridCollision=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,'idempotency-key':'native-job'},body:JSON.stringify(gridConflict)});assert.equal(gridCollision.status,409);assert.equal((await gridCollision.json()).code,'idempotency-conflict');
 assert.equal((await fetch(`${base}/api/quality/jobs/${id}`,{headers:{cookie:`voidplayer-user=guest-${randomUUID()}`}})).status,404);
 assert.equal((await fetch(base+'/api/quality/jobs')).status,401);
 const foreign=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,origin:'http://foreign.invalid','idempotency-key':'other'},body:JSON.stringify(input)});assert.equal(foreign.status,403);
 const page=await fetch(base+'/api/quality/jobs?after=0&limit=1',{headers:{cookie}}).then(r=>r.json());assert.equal(page.entries[0].id,id);assert.equal(page.entries[0].input,undefined);
 assert.equal((await fetch(base+'/api/quality/jobs?after=999999',{headers:{cookie}})).status,409);
 await stop();base=await start();const persisted=await terminal(base,id,{cookie});assert.deepEqual(persisted,job);
 const persistedResult=await fetch(`${base}/api/quality/jobs/${id}/result`,{headers:{cookie}}).then(r=>r.json());assert.deepEqual(persistedResult,result);
 assert.equal((await submit()).status,200,'restart retains the idempotency receipt without another attempt');
 if(codec==='h264'){
  library!.frameIndexes.remove();
  const absent=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,origin:base,'idempotency-key':'missing-cache'},body:JSON.stringify(input)});assert.equal(absent.status,202);
  const missing=await terminal(base,(await absent.json()).job.id,{cookie});assert.equal(missing.state,'failed');assert.equal(missing.reason?.code,'cache-miss');
  const cache=await fetch(`${base}/api/media/${targets[0].mediaId}/frame-index?v=${targets[0].mediaVersion}`).then(r=>r.json());assert.equal(cache.index,null,'durable scoring does not rebuild missing indexes');
  assert.deepEqual(await fetch(`${base}/api/quality/jobs/${id}/result`,{headers:{cookie}}).then(r=>r.json()),result,'cache cleanup does not erase quality history');
 }
 const changed=Buffer.from(fixture.bytes);changed[changed.length-5]^=1;await writeFile(join(media,'reference.flv'),changed);
 const next=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers,origin:base,'idempotency-key':'changed-source'},body:JSON.stringify(input)});assert.equal(next.status,202);
 const failed=await terminal(base,(await next.json()).job.id,{cookie});assert.equal(failed.state,'failed');assert.equal(failed.reason?.code,'source-changed');assert.equal(failed.result.available,false);
 assert.deepEqual(await fetch(`${base}/api/quality/jobs/${id}/result`,{headers:{cookie}}).then(r=>r.json()),result,'source mutation cannot rewrite historical results');
 t.diagnostic(JSON.stringify({codec,depth,sse:result.value.result.metric.aggregate.sse,attempt:job.attempt!.id,host:result.value.execution}));
});
