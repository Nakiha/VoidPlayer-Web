import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
// @ts-ignore shared fixed-public-media/native fixture
import {nativeFixture,until} from '../helpers/native-vmaf.mjs';
import {SSIM_VARIANT} from '../../shared/analysis/quality/ssim.ts';

for(const kind of ['single','range','vmaf'] as const)test(`real ${kind}: stopped failure → explicit full reexecution → new result and candidate, immutable original`,{timeout:180000},async t=>{
  const f=await nativeFixture({distorted:true,containers:kind==='single'?['flv','mp4']:kind==='range'?['mp4','flv']:['mp4','mp4']});t.after(()=>f.close());
  const library=f.service.library,runner=library.quality as any,create=runner.createWorker;let measureCount=0,gateAt=kind==='single'?1:2,gate:Int32Array|undefined;
  runner.createWorker=(data:any)=>{
    if(data.mode==='measure'&&++measureCount===gateAt){gate=new Int32Array(new SharedArrayBuffer(20));return new Worker(new URL('../helpers/quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:'decode',phaseState:gate.buffer}});}
    return create(data);
  };
  const frozen=library.qualityCorrespondence.result(f.input.plan.id,f.actor).rangePlan!;
  const pair={...frozen.input.pairs[0],ssim:{variant:SSIM_VARIANT},spatial:{blockWidth:64,blockHeight:48}};
  const input=kind==='single'?{schema:'voidplayer-psnr-frame-job',version:1,client:{id:'explicit-reexecution-test',kind:'agent'},request:pair}:kind==='range'?{...frozen.input,client:{id:'explicit-reexecution-test',kind:'agent'},pairs:frozen.input.pairs.map((p:any)=>({...p,ssim:{variant:SSIM_VARIANT},spatial:{blockWidth:64,blockHeight:48}}))}:f.input;
  let nativeKilled=false;
  if(kind==='vmaf'){
    const nativeRunner=(library.qualityVmaf as any).runner,run=nativeRunner.run.bind(nativeRunner);
    nativeRunner.run=(input:any,snapshot:any,signal:any,hooks:any)=>run(input,snapshot,signal,{...hooks,process:(p:any)=>{hooks.process(p);if(p&&!nativeKilled){nativeKilled=true;process.kill(p.pid,'SIGKILL');}}});
  }
  const collection=kind==='single'?'/api/quality/jobs':kind==='range'?'/api/quality/ranges':'/api/quality/vmaf/jobs';
  const first=(await f.json(collection,input,'initial-execution')).job,url=collection+'/'+first.id;
  const read=async(id=first.id)=>{const v=await f.json(collection+'/'+id);return kind==='range'?v.job:v;};
  if(kind!=='vmaf'){
    await until(()=>gate&&Atomics.load(gate,0),Boolean,'Actual decode gate did not start');
    const current=await read();if(kind==='single')assert.ok(current.executionContract);else assert.ok(library.qualityJobs.get(current.samples.at(-1)!.jobId,f.actor).executionContract);
    const blocked=await f.json(url+'/reexecution-plan',{reason:'Must not compute while running'});assert.equal(blocked.eligible,false);assert.ok(blocked.blocks.some((b:any)=>b.code==='original-not-stopped'));
    await f.json(url+'/cancel',{});await until(()=>read(),(j:any)=>['cancelled','interrupted','failed','partial'].includes(j.state),'Physical cancellation');gateAt=Infinity;
  }
  const original=await until(()=>read(),(j:any)=>['cancelled','interrupted','failed','partial'].includes(j.state),'Original failure');
  assert.ok(original.endedAt);if(kind==='vmaf'){assert.equal(nativeKilled,true);assert.equal(original.state,'partial');assert.equal(original.metrics.psnr.state,'completed');assert.ok(original.executionContract?.native);}
  if(kind==='range')assert.equal(original.summary.scoredPairs,1);
  const oldResult=kind==='vmaf'?await f.json(url+'/result'):kind==='range'?await f.json(url+'/results'):null;
  let oldCandidate:any;
  const rangePolicy={space:'default',side:'reference',metric:'psnr',maxDb:120,limit:1,minAuDistance:1,text:'Original partial score stays immutable',severity:2};
  if(kind==='range'){const p=await f.json(url+'/candidates',rangePolicy);assert.equal(p.createdIds.length,1);oldCandidate=await f.json('/api/annotations/spaces/default/'+p.createdIds[0]);}
  const oldJson=JSON.stringify(await read()),count=measureCount;
  const reason='Explicitly recompute all frozen input after a stopped failure';
  const plan=await f.json(url+'/reexecution-plan',{reason});assert.equal(plan.eligible,true,JSON.stringify(plan));assert.equal(plan.cost.reusesPreviousScores,false);assert.equal(plan.cost.scope,'entire-frozen-input-from-start');assert.equal(measureCount,count,'Planning never invokes scoring');assert.equal((await f.json(url+'/reexecutions')).successor,null);
  const request={schema:'voidplayer-quality-reexecution',version:1,reason,planDigest:plan.digest,confirm:plan.cost};
  const wrong=structuredClone(request);wrong.confirm.selectedPairs++;assert.equal((await f.request(url+'/reexecutions',wrong,'changed-cost')).status,409);
  const other='guest-'+randomUUID();assert.equal((await f.request(url+'/reexecution-plan',{reason},'cross-actor',{cookie:'voidplayer-user='+other,'x-voidplayer-actor':other})).status,404);
  assert.equal((await f.request(url+'/reexecution-plan',{reason},'changed-actor',{cookie:'voidplayer-user='+other})).status,409);
  const response=await f.request(url+'/reexecutions',request,'frozen-reexecution-key');assert.equal(response.status,202,await response.clone().text());const accepted=await response.json();assert.notEqual(accepted.job.id,first.id);assert.equal(accepted.job.retryOf.retryOf,first.id);assert.equal(accepted.job.retryOf.generation,2);assert.equal(accepted.job.retryOf.rootJobId,first.id);
  const replay=await f.json(url+'/reexecutions',request,'frozen-reexecution-key');assert.equal(replay.replayed,true);assert.equal(replay.job.id,accepted.job.id);
  assert.equal((await f.request(url+'/reexecutions',request,'second-window-key')).status,409,'another window cannot fork the original with a fresh key');
  const done=await until(()=>read(accepted.job.id),(j:any)=>!['queued','preparing','running','cancelling'].includes(j.state),'New full execution');assert.equal(done.state,'completed',JSON.stringify(done));
  if(kind==='single'){assert.equal(done.attempt.number,1);const result=await f.json(collection+'/'+done.id+'/result');assert.ok(result.value.result.ssim);assert.equal(result.value.result.metric.spatial.blocks.length,4);}
  if(kind==='range'){assert.equal(done.summary.scoredPairs,8);assert.equal(measureCount-count,8,'old completed scores are recomputed too');}
  if(kind==='vmaf'){const result=await f.json(collection+'/'+done.id+'/result');assert.ok(result.vmaf);assert.equal(result.vmaf.frames.length,8);assert.equal(result.metrics.ssim.state,'completed');}
  assert.equal(JSON.stringify(await read()),oldJson,'Original terminal job/attempt/reason stays byte-identical');
  if(oldResult)assert.deepEqual(await f.json(url+(kind==='vmaf'?'/result':'/results')),oldResult);
  if(oldCandidate)assert.deepEqual(await f.json('/api/annotations/spaces/default/'+oldCandidate.id),oldCandidate);
  const chain=await f.json(url+'/reexecutions');assert.equal(chain.successor.id,done.id);assert.equal((await f.json(collection+'/'+done.id+'/reexecutions')).retryOf.retryOf,first.id);
  if(kind==='single'){
    const candidate=await f.json('/api/annotations/spaces/default',{action:'create-quality-candidate',operationId:randomUUID(),id:randomUUID(),revision:0,candidate:{text:'Explicit reexecuted PSNR/SSIM/grid candidate',severity:2},evidence:{jobId:done.id,attemptId:done.attempt.id,digest:done.result.digest,side:'reference'},client:{kind:'agent',id:'explicit-reexecution-test'}},'single-candidate',{'x-voidplayer-action':'annotation'});
    assert.equal(candidate.document.mark.qualityEvidence[0].ref.jobId,done.id);
  }
  if(kind!=='single'){
    assert.equal(await f.json(collection+'/'+done.id+'/candidates'),null,'new success never automatically publishes');
    const policy=kind==='range'?{...rangePolicy,text:'Explicit new full-range candidate'}:{space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'Explicit reexecuted VMAF candidate',severity:2};
    const published=await f.json(collection+'/'+done.id+'/candidates',policy);assert.equal(published.createdIds.length,1);
    const candidate=await f.json('/api/annotations/spaces/default/'+published.createdIds[0]);const evidence=candidate.document.mark.qualityEvidence[0];if(kind==='vmaf')assert.ok(evidence.ref.jobId.startsWith(done.id+'-f'));else assert.ok(done.samples.some((s:any)=>s.jobId===evidence.ref.jobId),'new range candidate cites a newly computed child, not an old sample');
  }
  // Receipt-first replay is independent of now-invalid source eligibility.
  const file=path.join(f.media,'reference.'+f.containers[0]),bytes=await readFile(file);await writeFile(file,Buffer.concat([bytes,Buffer.from([0])]));
  assert.equal((await f.json(url+'/reexecutions',request,'frozen-reexecution-key')).job.id,done.id);
  assert.equal((await f.json(collection+'/'+done.id+'/reexecution-plan',{reason})).eligible,false,'completed successors cannot be recomputed');
});
