import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QualityJobStore } from '../../server/analysis/quality/job-store.ts';
import { qualityJobRequest } from '../../server/analysis/quality/job-request.ts';
import { QUALITY_JOB_LIMITS } from '../../shared/analysis/quality/jobs.ts';
import type { LibraryPairResult } from '../../shared/analysis/quality/library-pair.ts';
import { openIndexDatabase } from '../../server/sqlite.ts';
import { jobInput } from '../helpers/quality-job-fixture.ts';
const actor={id:'actor-one',name:'Original actor'};
// This unit value tests atomic envelope storage, not decoding; real planes are
// verified through HTTP and compiled packages in the media suite.
const value={schema:'voidplayer-library-frame-pair-psnr',version:1} as LibraryPairResult;
async function fixture(t:TestContext){
 const dir=await mkdtemp(join(tmpdir(),'vp-job-store-')),file=join(dir,'jobs.sqlite');let store:QualityJobStore|null=null;
 t.after(async()=>{store?.close();await rm(dir,{recursive:true,force:true});});
 store=new QualityJobStore(file,1000);
 return {file,get store(){return store!;},reopen(){store!.close();store=null;store=new QualityJobStore(file,5000);return store;}};
}
test('transactional idempotency normalizes field order/default budgets and preserves original attribution',async t=>{
 const f=await fixture(t),input=jobInput(),first=f.store.submit(qualityJobRequest(input),actor,'original-request','same-key',1000);
 const reordered={request:{...input.request,roi:{height:input.request.roi.height,width:input.request.roi.width,y:input.request.roi.y,x:input.request.roi.x}},client:input.client,version:1,schema:input.schema};
 const replay=f.store.submit(qualityJobRequest(reordered),{...actor,name:'Renamed actor'},'later-request','same-key',2000);
 assert.equal(replay.replayed,true);assert.deepEqual(replay.job,first.job);assert.equal(replay.job.submitted.requestId,'original-request');
 const conflict=jobInput();conflict.request.roi.width-=2;
 assert.throws(()=>f.store.submit(qualityJobRequest(conflict),actor,'conflict','same-key',2000),{code:'idempotency-conflict'});
 const attempt=f.store.start(first.job.id,1100);f.store.finish(first.job.id,attempt,'completed',null,1200,value);
 assert.equal(f.store.submit(qualityJobRequest(input),actor,'retry','same-key',3000).job.state,'completed');
 assert.equal(f.store.result(first.job.id).submitted.actorName,'Original actor');
 assert.equal(f.store.submit(qualityJobRequest(input),{id:'actor-two',name:'Other'},'other','same-key',3000).replayed,false);
});
test('cancellation wins before terminal commit; completed result wins before later cancellation',async t=>{
 const f=await fixture(t),request=qualityJobRequest(jobInput());
 const a=f.store.submit(request,actor,'request-a','a',1000).job,attempt=f.store.start(a.id,1100);
 f.store.phase(a.id,attempt,'decode');f.store.cancel(a.id,actor.id,'cancel-request',1200);
 f.store.phase(a.id,attempt,'publish');assert.equal(f.store.get(a.id).phase,'stopping');
 assert.equal(f.store.finish(a.id,'stale-attempt','completed',null,1300,value),false);
 f.store.finish(a.id,attempt,'completed',null,1300,value);
 assert.equal(f.store.get(a.id).state,'cancelled');assert.equal(f.store.get(a.id).cancelRequestId,'cancel-request');
 assert.throws(()=>f.store.result(a.id),{code:'result-unavailable'});
 const b=f.store.submit(request,actor,'request-b','b',1400).job,other=f.store.start(b.id,1500);
 f.store.finish(b.id,other,'completed',null,1600,value);const committed=f.store.get(b.id);
 assert.deepEqual(f.store.cancel(b.id,actor.id,'too-late',1700),committed);
 assert.equal(f.store.finish(b.id,other,'failed',{code:'late-error',message:'late'},1800),false);
 assert.deepEqual(f.store.result(b.id).value,value);
});
test('restart interrupts every unfinished state without another attempt and retains committed results',async t=>{
 const f=await fixture(t),request=qualityJobRequest(jobInput()),ids:string[]=[];
 for(const [i,state]of ['queued','preparing','running','cancelling','completed'].entries()){
  const job=f.store.submit(request,{id:`actor-${i}`,name:'A'},`req-${i}`,`key-${i}`,1000).job;ids.push(job.id);
  if(state==='queued')continue;const attempt=f.store.start(job.id,1100);
  if(state==='running'||state==='completed')f.store.phase(job.id,attempt,'decode');
  if(state==='cancelling')f.store.cancel(job.id,`actor-${i}`,'cancel-request',1200);
  if(state==='completed')f.store.finish(job.id,attempt,'completed',null,1300,value);
 }
 const before=f.store.get(ids[4]);f.reopen();
 for(const id of ids.slice(0,4)){const job=f.store.get(id);assert.equal(job.state,'interrupted');assert.equal(job.reason?.code,'service-restarted');assert.equal(job.attempt?.number??0,id===ids[0]?0:1);assert.equal(job.result.available,false);}
 assert.deepEqual(f.store.get(ids[4]),before);assert.deepEqual(f.store.result(ids[4]).value,value);assert.equal(f.store.queued(),null);
});
test('queue/actor quotas, expiry and bounded polling preserve idempotency during overload',async t=>{
 const f=await fixture(t),request=qualityJobRequest(jobInput());
 const first=f.store.submit(request,actor,'req','key',1000).job;
 f.store.submit(request,actor,'req2','key2',1000);
 assert.throws(()=>f.store.submit(request,actor,'req3','key3',1000),{code:'quality-actor-limit'});
 for(let i=0;i<2;i++)f.store.submit(request,{id:`other-${i}`,name:'A'},'req','key',1000);
 assert.throws(()=>f.store.submit(request,{id:'overflow',name:'A'},'req','key',1000),{code:'quality-queue-full'});
 assert.equal(f.store.submit(request,actor,'retry','key',1000).replayed,true);
 const page=f.store.changes(null,0,2);assert.equal(page.more,true);assert.equal(page.entries.length,2);assert.equal('input'in page.entries[0],false);
 assert.equal(f.store.changes(null,page.cursor,2).entries.length,2);assert.equal(f.store.changes('none').entries.length,0);
 assert.throws(()=>f.store.changes(null,99999),{code:'cursor-ahead'});assert.throws(()=>f.store.changes(null,0,51),{code:'invalid-cursor'});
 f.store.expire(1000+QUALITY_JOB_LIMITS.queueWaitMs);assert.equal(f.store.queued(),null);
 assert.equal(f.store.get(first.id).reason?.code,'queue-expired');assert.equal(f.store.get(first.id).attempt,null);
});
test('live owner prevents a second store from recovering its active attempt',async t=>{
 const f=await fixture(t),job=f.store.submit(qualityJobRequest(jobInput()),actor,'request','key',1000).job;
 f.store.start(job.id,1100);assert.throws(()=>new QualityJobStore(f.file,9999),/另一个实例/);
 assert.equal(f.store.get(job.id).state,'preparing');
});
test('oversized result rolls back and a future schema is rejected without erasing history',async t=>{
 const f=await fixture(t),job=f.store.submit(qualityJobRequest(jobInput()),actor,'request','key',1000).job,attempt=f.store.start(job.id,1100);
 const oversized={...value,padding:'x'.repeat(QUALITY_JOB_LIMITS.resultBytes)};
 assert.throws(()=>f.store.finish(job.id,attempt,'completed',null,1200,oversized),{code:'budget-exceeded'});
 assert.equal(f.store.get(job.id).state,'preparing');assert.equal(f.store.get(job.id).result.available,false);
 const db=openIndexDatabase(f.file);db.exec('PRAGMA user_version=99');db.close();
 assert.throws(()=>f.reopen(),/newer application/);
 const read=openIndexDatabase(f.file);try{assert.equal(Number(read.prepare('SELECT count(*) AS n FROM quality_jobs').get()!.n),1);}finally{read.close();}
});
test('job admission rejects missing ROI, nested values and unknown fields before persistence',()=>{
 for(const mutate of [(x:any)=>delete x.request.roi.width,(x:any)=>x.request.roi.x={},(x:any)=>x.request.unknown=true,(x:any)=>x.client.id=123,(x:any)=>x.request.budget={maxSamples:0}]){
  const input=jobInput();mutate(input);assert.throws(()=>qualityJobRequest(input));
 }
});

test('spatial parameters participate in canonical idempotency; old scalar receipts keep their fingerprints',async t=>{
 const f=await fixture(t),input=jobInput(),plain=qualityJobRequest(input);input.request.spatial={blockWidth:16,blockHeight:8};const grid=qualityJobRequest(input);
 const reordered=structuredClone(input);reordered.request.spatial={blockHeight:8,blockWidth:16};assert.equal(qualityJobRequest(reordered).fingerprint,grid.fingerprint);assert.notEqual(plain.fingerprint,grid.fingerprint);
 const first=f.store.submit(grid,actor,'grid','grid',1000);assert.equal(f.store.submit(qualityJobRequest(reordered),actor,'replay','grid',1000).job.id,first.job.id);
 input.request.spatial.blockWidth=8;assert.throws(()=>f.store.submit(qualityJobRequest(input),actor,'conflict','grid',1000),{code:'idempotency-conflict'});
 delete input.request.spatial;assert.equal(qualityJobRequest(input).json,plain.json);assert.throws(()=>f.store.submit(plain,actor,'strip-grid','grid',1000),{code:'idempotency-conflict'});
});
test('completed reservations settle to actual payloads beyond old lifetime caps; release preserves receipts and digests',async t=>{
 const f=await fixture(t),request=qualityJobRequest(jobInput());let first='';
 for(let i=0;i<=QUALITY_JOB_LIMITS.historyRows;i++){
  const job=f.store.submit(request,actor,'request',`history-${i}`,1000).job;first||=job.id;f.store.cancel(job.id,actor.id,'cancel',1001);
 }
 assert.equal(f.store.submit(request,actor,'replay','history-0',2000).job.id,first);
 let completed='',count=0;
 for(let i=0;i<2000;i++){
  let job;
  try{job=f.store.submit(request,actor,'request',`payload-${i}`,2000).job;}
  catch(error){assert.equal((error as {code:string}).code,'quality-history-full');break;}
  const attempt=f.store.start(job.id,2001);f.store.finish(job.id,attempt,'completed',null,2002,Object.assign({},value,{padding:'测'.repeat(30000)}));
  completed||=job.id;count++;
 }
 assert.ok(count>500&&count<2000);const before=f.store.get(completed);
 assert.throws(()=>f.store.submit(request,actor,'overflow','new-after-full',2000),{code:'quality-history-full'});
 const released=f.store.releaseResult(completed);assert.equal(released.result.available,false);assert.equal(released.result.digest,before.result.digest);
 assert.equal(released.state,'completed');assert.deepEqual(released.input,before.input);assert.deepEqual(released.attempt,before.attempt);
 assert.throws(()=>f.store.result(completed),{code:'result-unavailable'});
 assert.equal(f.store.submit(request,actor,'replay','payload-0',3000).job.id,completed);
 const next=f.store.submit(request,actor,'new','after-release',3000).job;assert.equal(next.state,'queued');
 assert.throws(()=>f.store.releaseResult(next.id),{code:'result-release-blocked'});
 f.reopen();assert.equal(f.store.get(completed).result.available,false);assert.equal(f.store.get(completed).result.digest,before.result.digest);
 assert.equal(f.store.submit(request,actor,'restart-replay','history-0',4000).job.id,first);
});

test('SSIM selection is canonical immutable request identity; legacy PSNR hash stays byte-identical',async t=>{
 const f=await fixture(t),input=jobInput();assert.equal(qualityJobRequest(input).fingerprint,'e52c739d7220263b57cceefff735ed30b344fec4dbff305d43b1d3cfe455607a');
 input.request.roi={x:0,y:0,width:32,height:32};input.request.spatial={blockWidth:16,blockHeight:16};
 const plain=qualityJobRequest(input);input.request.ssim={variant:'ffmpeg-uniform-8x8-step4-v1'};const ss=qualityJobRequest(input);assert.notEqual(plain.fingerprint,ss.fingerprint);
 const job=f.store.submit(ss,actor,'ssim','ssim',1000).job;
 assert.equal(f.store.submit(qualityJobRequest(structuredClone(input)),actor,'again','ssim',1001).job.id,job.id);
 delete input.request.ssim;assert.equal(qualityJobRequest(input).json,plain.json);assert.throws(()=>f.store.submit(plain,actor,'strip','ssim',1001),{code:'idempotency-conflict'});
});
