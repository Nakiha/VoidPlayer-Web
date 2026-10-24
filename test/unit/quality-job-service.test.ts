import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { MediaLibraryIndex } from '../../server/library.ts';
import { QualityAdmission } from '../../server/quality-admission.ts';
import { LibraryPairRunner } from '../../server/analysis/quality/runner.ts';
import { QualityJobService } from '../../server/analysis/quality/job-service.ts';
import { QualityJobStore } from '../../server/analysis/quality/job-store.ts';
import { QUALITY_JOB_LIMITS } from '../../shared/analysis/quality/jobs.ts';
import { jobInput } from '../helpers/quality-job-fixture.ts';
const actor={id:'test-actor',name:'Test actor'},other={id:'other-actor',name:'Other'};
const value={schema:'voidplayer-library-frame-pair-psnr',version:1};
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Expected asynchronous job transition did not occur');}
async function fixture(t:TestContext,now=Date.now){
 const dir=await mkdtemp(join(tmpdir(),'vp-job-service-')),file=join(dir,'jobs.sqlite'),gate=new QualityAdmission();
 const workers:{worker:Worker;events:EventEmitter;release():void;stopping:Promise<void>}[]=[];
 const library={qualityAdmission:gate,indexDatabase:'/unused'}as MediaLibraryIndex;
 const runner=new LibraryPairRunner(library,'/unused',()=>{
  let release!:()=>void,stopping!:()=>void;const stopped=new Promise<number>(resolve=>release=()=>resolve(0));
  const stoppingPromise=new Promise<void>(resolve=>stopping=resolve),events=new EventEmitter();
  const worker=Object.assign(events,{postMessage(){},terminate(){stopping();return stopped;}})as unknown as Worker;
  workers.push({worker,events,release,stopping:stoppingPromise});return worker;
 });
 const jobs=new QualityJobService(file,runner,now);
 t.after(async()=>{for(const worker of workers)worker.release();await jobs.close();await runner.close();await rm(dir,{recursive:true,force:true});});
 return {jobs,runner,gate,workers,file};
}
test('explicit cancel keeps the physical-stop permit; next queued attempt cannot start early',async t=>{
 const f=await fixture(t),first=f.jobs.submit(jobInput(),actor,'request-one','one').job;
 assert.equal(first.state,'preparing');assert.equal(first.attempt?.number,1);assert.equal(f.workers.length,1);
 f.workers[0].events.emit('message',{type:'phase',phase:'decode'});assert.equal(f.jobs.get(first.id).state,'running');
 const next=f.jobs.submit(jobInput(),other,'request-two','two').job;assert.equal(next.state,'queued');assert.equal(next.attempt,null);
 f.jobs.cancel(first.id,actor.id,'cancel-one');await f.workers[0].stopping;
 assert.equal(f.jobs.get(first.id).state,'cancelling');assert.equal(f.workers.length,1);
 assert.throws(()=>f.gate.acquire(),{code:'quality-busy'});assert.equal(f.jobs.get(next.id).attempt,null);
 f.workers[0].release();await until(()=>f.jobs.get(first.id).state==='cancelled');await until(()=>f.workers.length===2);
 assert.equal(f.jobs.get(next.id).attempt?.number,1);assert.equal(f.jobs.get(first.id).result.available,false);
 f.workers[1].events.emit('message',{ok:true,value});f.workers[1].release();await until(()=>f.jobs.get(next.id).state==='completed');
});
test('a success message held at terminate cannot defeat an earlier cancellation commit',async t=>{
 const f=await fixture(t),job=f.jobs.submit(jobInput(),actor,'request','key').job;
 f.workers[0].events.emit('message',{ok:true,value});await f.workers[0].stopping;
 assert.equal(f.jobs.get(job.id).result.available,false);f.jobs.cancel(job.id,actor.id,'cancel');f.workers[0].release();
 await until(()=>f.jobs.get(job.id).state==='cancelled');assert.throws(()=>f.jobs.result(job.id),{code:'result-unavailable'});
});
test('close is shared and waits for real stop before committing interrupted and releasing ownership',async t=>{
 const f=await fixture(t),first=f.jobs.submit(jobInput(),actor,'one','one').job,next=f.jobs.submit(jobInput(),other,'two','two').job;
 let closed=false;const closing=f.jobs.close();assert.equal(f.jobs.close(),closing);void closing.then(()=>closed=true);
 await f.workers[0].stopping;assert.equal(closed,false);assert.throws(()=>f.gate.acquire(),{code:'quality-busy'});
 assert.throws(()=>new QualityJobStore(f.file),/另一个实例/);f.workers[0].release();await closing;
 assert.equal(closed,true);const read=new QualityJobStore(f.file);try{
  assert.equal(read.get(first.id).state,'interrupted');assert.equal(read.get(next.id).state,'interrupted');assert.equal(read.get(next.id).attempt,null);
 }finally{read.close();}
 assert.throws(()=>f.jobs.submit(jobInput(),actor,'three','three'),{code:'quality-service-unavailable'});
});
test('busy shared admission creates no attempt and a later admission starts exactly once',async t=>{
 const f=await fixture(t),release=f.gate.acquire();t.after(release);
 const job=f.jobs.submit(jobInput(),actor,'original','key').job;assert.equal(job.attempt,null);
 await until(()=>f.jobs.get(job.id).reason?.code==='compute-busy');assert.equal(f.workers.length,0);
 release();await until(()=>f.workers.length===1);f.workers[0].events.emit('message',{ok:true,value});f.workers[0].release();
 await until(()=>f.jobs.get(job.id).state==='completed');const replay=f.jobs.submit(jobInput(),{...actor,name:'Renamed'},'new-request','key');
 assert.equal(replay.replayed,true);assert.equal(replay.job.submitted.requestId,'original');assert.equal(f.workers.length,1);
 assert.equal(f.jobs.result(job.id).submitted.actorName,actor.name);assert.throws(()=>f.jobs.get(job.id,other.id),{code:'job-not-found'});
});
test('an attempt commit failure never starts a Worker and returns compute admission',async t=>{
 const f=await fixture(t),original=QualityJobStore.prototype.start;
 QualityJobStore.prototype.start=()=>{throw new Error('injected commit failure');};
 try{const job=f.jobs.submit(jobInput(),actor,'request','key').job;await until(()=>f.jobs.get(job.id).state==='failed');
  assert.equal(f.workers.length,0);assert.equal(f.jobs.get(job.id).attempt,null);const release=f.gate.acquire();release();
 }finally{QualityJobStore.prototype.start=original;}
});
test('queue expiry is separate from execution deadline and never starts stale work',async t=>{
 let now=1000;const f=await fixture(t,()=>now),release=f.gate.acquire();t.after(release);
 const job=f.jobs.submit(jobInput(),actor,'request','key').job;now+=QUALITY_JOB_LIMITS.queueWaitMs;
 await until(()=>f.jobs.get(job.id).state==='failed');assert.equal(f.jobs.get(job.id).reason?.code,'queue-expired');assert.equal(f.workers.length,0);
});
