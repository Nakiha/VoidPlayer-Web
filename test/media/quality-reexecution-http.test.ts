import {replaceRunnerAnalysisDirectory} from '../helpers/analysis-component-fixture.ts';
import {assertForcedProcessExit} from '../helpers/forced-process-exit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
// @ts-ignore ordinary public-HTTP-only example
import {runHttpQuality} from '../../examples/http-quality.mjs';
// @ts-ignore shared fixed-public-media/native fixture
import {nativeFixture,until} from '../helpers/native-vmaf.mjs';
// @ts-ignore fixed public XPSNR fixture; no VMAF substitution
import {xpsnrFixture} from '../helpers/native-xpsnr.mjs';
import {SSIM_VARIANT} from '../../shared/analysis/quality/ssim.ts';

async function measuredWitnesses(library:any,kind:'single'|'range'|'vmaf'|'xpsnr',plan:any,requests:any[],nativeInput:any,snapshot:any){
  const run=async(data:any)=>{
    const state=new Int32Array(new SharedArrayBuffer(12)),release=library.qualityAdmission.acquire();
    const worker=new Worker(new URL('../helpers/quality-witness-worker.ts',import.meta.url),{workerData:{...data,database:library.indexDatabase,coreDir:(library.quality as any).coreDir,control:new SharedArrayBuffer(8),witnessState:state.buffer},trackUnmanagedFds:true,resourceLimits:{maxOldGenerationSizeMb:256}});
    try{await new Promise<void>((resolve,reject)=>{let reply:any;worker.on('message',v=>reply=v);worker.once('error',reject);worker.once('exit',code=>code===0&&reply?.ok?resolve():reject(Error(JSON.stringify(reply??{code}))));});return Array.from(state);}finally{await worker.terminate();release();}
  };
  const native={domain:'vmaf',input:nativeInput,snapshot,analysisContract:plan.contract.analysis,expectedExecutionContract:plan.contract};
  const preflight=await run((kind==='vmaf'||kind==='xpsnr')?{...native,mode:'preflight'}:{domain:'single',mode:'reexecution-preflight',requests,expected:plan.contract});
  assert.equal(preflight[0],1,'read-only metadata validation is one separate witness pass');
  const values:number[][]=[];
  if((kind==='vmaf'||kind==='xpsnr')){values.push(await run({...native,mode:'decode'}));values.push(await run({...native,mode:'verify'}));assert.equal(values[0][0],2);assert.equal(values[1][0],1,'final verify Worker reads the witness too');}
  else for(const request of requests)values.push(await run({domain:'single',mode:'measure',request,expectedExecutionContract:plan.contract}));
  const actual=values.reduce((a,v)=>a.map((n,i)=>n+v[i]),[0,0,0]),witness=plan.cost.reservation.executionWitness,coreBytes=plan.contract.environment.assets.reduce((n:number,a:any)=>n+a.bytes,0),producerBytes=plan.contract.environment.producerBuild.bytes;
  console.log(JSON.stringify({witnessCost:{kind,preflightPasses:preflight[0],executionPasses:actual[0],coreAssetBytes:actual[1],producerBytes:actual[2],confirmedPasses:witness.passes}}));
  assert.equal(actual[0],(kind==='vmaf'||kind==='xpsnr')?3:2*requests.length);assert.equal(witness.passes,actual[0]);assert.equal(witness.stages.reduce((n:number,s:any)=>n+s.passes,0),actual[0]);assert.equal(actual[1],actual[0]*coreBytes,'actual core asset witness bytes match every confirmed pass');assert.equal(actual[2],actual[0]*producerBytes,'actual producer witness bytes match every confirmed pass');assert.ok(actual[1]<=witness.passes*witness.maxCoreAssetBytesPerPass);assert.ok(actual[2]<=witness.passes*witness.maxProducerBytesPerPass);
}

for(const kind of ['single','range','vmaf','xpsnr'] as const)test(`real ${kind}: stopped failure → explicit full reexecution → new result and candidate, immutable original`,{timeout:180000},async t=>{
  const f=await (kind==='xpsnr'?xpsnrFixture:nativeFixture)({depth:kind==='range'?10:8,distorted:true,containers:kind==='single'?['flv','mp4']:kind==='range'?['mp4','flv']:['mp4','mp4']});t.after(()=>f.close());
  const library=f.service.library,runner=library.quality as any,create=runner.createWorker;let measureCount=0,gateAt=kind==='single'?1:2,gate:Int32Array|undefined;
  runner.createWorker=(data:any)=>{
    if(data.mode==='measure'&&++measureCount===gateAt){gate=new Int32Array(new SharedArrayBuffer(20));return new Worker(new URL('../helpers/quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:'decode',phaseState:gate.buffer}});}
    return create(data);
  };
  const frozen=library.qualityCorrespondence.result(f.input.plan.id,f.actor).rangePlan!;
  const pair={...frozen.input.pairs[0],ssim:{variant:SSIM_VARIANT},spatial:{blockWidth:64,blockHeight:48}};
  const input=kind==='single'?{schema:'voidplayer-psnr-frame-job',version:1,client:{id:'explicit-reexecution-test',kind:'agent'},request:pair}:kind==='range'?{...frozen.input,client:{id:'explicit-reexecution-test',kind:'agent'},pairs:frozen.input.pairs.map((p:any)=>({...p,ssim:{variant:SSIM_VARIANT},spatial:{blockWidth:64,blockHeight:48}}))}:f.input;
  let nativeKilled=false;
  if((kind==='vmaf'||kind==='xpsnr')){
    const nativeRunner=((kind==='xpsnr'?library.qualityXpsnr:library.qualityVmaf) as any).runner,run=nativeRunner.run.bind(nativeRunner);
    nativeRunner.run=(input:any,snapshot:any,signal:any,hooks:any)=>run(input,snapshot,signal,{...hooks,...({prepared:(p:any)=>{hooks.prepared(p);if(!nativeKilled){nativeKilled=true;throw Error('Injected failure after real companion preparation');}}})});
  }
  const collection=kind==='single'?'/api/quality/jobs':kind==='range'?'/api/quality/ranges':'/api/quality/'+kind+'/jobs';
  const first=(kind==='range'?await f.json('/api/quality/correspondence-plans/'+f.input.plan.id+'/execute',{digest:f.input.plan.digest}):await f.json(collection,input,'initial-execution')).job,url=collection+'/'+first.id;
  const read=async(id=first.id)=>{const v=await f.json(collection+'/'+id);return kind==='range'?v.job:v;};
  if(kind==='single'||kind==='range'){
    await until(()=>gate&&Atomics.load(gate,0),Boolean,'Actual decode gate did not start');
    const current=await read();if(kind==='single')assert.ok(current.executionContract);else assert.ok(library.qualityJobs.get(current.samples.at(-1)!.jobId,f.actor).executionContract);
    const blocked=await f.json(url+'/reexecution-plan',{reason:'Must not compute while running'});assert.equal(blocked.eligible,false);assert.ok(blocked.blocks.some((b:any)=>b.code==='original-not-stopped'));
    await f.json(url+'/cancel',{});await until(()=>read(),(j:any)=>['cancelled','interrupted','failed','partial'].includes(j.state),'Physical cancellation');gateAt=Infinity;
  }
  const original=await until(()=>read(),(j:any)=>['cancelled','interrupted','failed','partial'].includes(j.state),'Original failure');
  assert.ok(original.endedAt);if((kind==='vmaf'||kind==='xpsnr')){assert.equal(nativeKilled,true);assert.equal(original.state,'partial');assert.equal(original.metrics.psnr.state,'completed');assert.ok(original.executionContract?.analysis);}
  if(kind==='range')assert.equal(original.summary.scoredPairs,1);
  const oldResult=(kind==='vmaf'||kind==='xpsnr')?await f.json(url+'/result'):kind==='range'?await f.json(url+'/results'):null;
  let oldCandidate:any;
  const rangePolicy={space:'default',side:'reference',metric:'psnr',maxDb:120,limit:1,minAuDistance:1,text:'Original partial score stays immutable',severity:2};
  if(kind==='range'){const p=await f.json(url+'/candidates',rangePolicy);assert.equal(p.createdIds.length,1);oldCandidate=await f.json('/api/annotations/spaces/default/'+p.createdIds[0]);}
  const oldJson=JSON.stringify(await read()),count=measureCount;
  const reason='Explicitly recompute all frozen input after a stopped failure';
  const plan=await f.json(url+'/reexecution-plan',{reason});assert.equal(plan.eligible,true,JSON.stringify(plan));assert.equal(plan.cost.reusesPreviousScores,false);assert.equal(plan.cost.scope,'entire-frozen-input-from-start');assert.equal(measureCount,count,'Planning never invokes scoring');assert.equal((await f.json(url+'/reexecutions')).successor,null);
  const request={schema:'voidplayer-quality-reexecution',version:1,reason:kind==='single'?' \t'+reason+'\n ':reason,planDigest:plan.digest,confirm:plan.cost};
  const wrong=structuredClone(request);wrong.confirm.selectedPairs++;assert.equal((await f.request(url+'/reexecutions',wrong,'changed-cost')).status,409);
  const other='guest-'+randomUUID();assert.equal((await f.request(url+'/reexecution-plan',{reason},'cross-actor',{cookie:'voidplayer-user='+other,'x-voidplayer-actor':other})).status,404);
  assert.equal((await f.request(url+'/reexecution-plan',{reason},'changed-actor',{cookie:'voidplayer-user='+other})).status,409);
  if(kind==='single'){
    const dry=await runHttpQuality(f.base,{mode:kind,reexecution:{jobId:first.id,reason}},{cookie:f.cookie,actor:f.actor});assert.equal(dry.reexecutionPlan.digest,plan.digest);assert.equal((await f.json(url+'/reexecutions')).successor,null);
    let lost=false;const sent:any[]=[],statuses:number[]=[];const client=await runHttpQuality(f.base,{mode:kind,key:'frozen-example',reexecution:{jobId:first.id,reason:request.reason,actor:f.actor,request}},{cookie:f.cookie,actor:f.actor,allow:{reexecute:true,retryUnknown:true},fetchImpl:async(target:any,init:any)=>{const r=await fetch(target,init);if(String(target).endsWith('/reexecutions')&&init.method==='POST'){sent.push({body:init.body,key:init.headers['idempotency-key'],actor:init.headers['x-voidplayer-actor']});statuses.push(r.status);if(!lost){lost=true;await r.json();return new Response('',{status:202});}}return r;}});
    assert.equal(client.job.state,'completed');assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(client.job.retryOf.retryOf,first.id);assert.equal(client.reexecutionReceipt.key,'frozen-example:single.reexecute');assert.deepEqual(statuses,[202,200]);assert.equal(JSON.parse(sent[0].body).reason,request.reason);assert.equal(client.reexecutionReceipt.request.reason,reason);
    for(const field of ['actor','key','cost','digest','lineage']){await assert.rejects(runHttpQuality(f.base,{mode:kind,key:'frozen-example',reexecution:{jobId:first.id,reason:request.reason,actor:f.actor,request}},{cookie:f.cookie,actor:f.actor,allow:{reexecute:true},fetchImpl:async(target:any,init:any)=>{const r=await fetch(target,init);if(String(target).endsWith('/reexecutions')&&init.method==='POST'){const v=await r.json();if(field==='actor')v.receipt.actorId='wrong';if(field==='key')v.receipt.key='wrong';if(field==='cost')v.receipt.request.confirm.selectedPairs++;if(field==='digest')v.receipt.request.planDigest='f'.repeat(64);if(field==='lineage')v.receipt.lineage.generation++;return new Response(JSON.stringify(v),{status:r.status,headers:{'content-type':'application/json'}});}return r;}}),(error:any)=>{assert.equal(error.code,'unknown-post-outcome');assert.deepEqual(error.details.body,request);assert.equal(error.details.key,'frozen-example:single.reexecute');assert.equal(error.details.actor,f.actor);return true;});assert.equal((await f.json(url+'/reexecutions')).successor.id,client.job.id,'bad receipt never creates a second job');}
    // Independently consume an intact real 202 with a whitespace reason. This
    // is a new explicit initial intent, not a replacement key for uncertainty.
    gateAt=measureCount+1;gate=undefined;
    const plainOriginal=(await f.json(collection,input,'intact-202-original')).job,plainUrl=collection+'/'+plainOriginal.id;await until(()=>gate&&Atomics.load(gate,0),Boolean);await f.json(plainUrl+'/cancel',{});await until(()=>read(plainOriginal.id),(j:any)=>j.state==='cancelled');gateAt=Infinity;
    const rawReason=' \tIntact successful acknowledgement\n ',plainPlan=await f.json(plainUrl+'/reexecution-plan',{reason:rawReason}),plainRequest={schema:'voidplayer-quality-reexecution',version:1,reason:rawReason,planDigest:plainPlan.digest,confirm:plainPlan.cost};let intactStatus=0;
    const intact=await runHttpQuality(f.base,{mode:kind,key:'intact-202',reexecution:{jobId:plainOriginal.id,reason:rawReason,actor:f.actor,request:plainRequest}},{cookie:f.cookie,actor:f.actor,allow:{reexecute:true},fetchImpl:async(target:any,init:any)=>{const r=await fetch(target,init);if(String(target).endsWith('/reexecutions')&&init.method==='POST')intactStatus=r.status;return r;}});assert.equal(intactStatus,202);assert.equal(intact.job.state,'completed');assert.equal(intact.reexecutionReceipt.request.reason,rawReason.trim());assert.equal((await f.json(plainUrl+'/reexecutions',plainRequest,'intact-202:single.reexecute')).job.id,intact.job.id);
    // The rest of the common assertions replay the exact already accepted example request.
    const receipt=await f.json(url+'/reexecutions',request,'frozen-example:single.reexecute');assert.equal(receipt.job.id,client.job.id);
  }
  const response=await f.request(url+'/reexecutions',request,kind==='single'?'frozen-example:single.reexecute':'frozen-reexecution-key');assert.equal(response.status,kind==='single'?200:202,await response.clone().text());const accepted=await response.json();assert.notEqual(accepted.job.id,first.id);assert.equal(accepted.job.retryOf.retryOf,first.id);assert.equal(accepted.job.retryOf.generation,2);assert.equal(accepted.job.retryOf.rootJobId,first.id);
  const replay=await f.json(url+'/reexecutions',request,kind==='single'?'frozen-example:single.reexecute':'frozen-reexecution-key');assert.equal(replay.replayed,true);assert.equal(replay.job.id,accepted.job.id);
  assert.equal((await f.request(url+'/reexecutions',request,'second-window-key')).status,409,'another window cannot fork the original with a fresh key');
  const done=await until(()=>read(accepted.job.id),(j:any)=>!['queued','preparing','running','cancelling'].includes(j.state),'New full execution');assert.equal(done.state,'completed',JSON.stringify(done));
  if(kind==='single'){assert.equal(done.attempt.number,1);const result=await f.json(collection+'/'+done.id+'/result');assert.ok(result.value.result.ssim);assert.equal(result.value.result.metric.spatial.blocks.length,4);}
  if(kind==='range'){assert.equal(done.summary.scoredPairs,8);assert.equal(measureCount-count,8,'old completed scores are recomputed too');}
  if((kind==='vmaf'||kind==='xpsnr')){const result=await f.json(collection+'/'+done.id+'/result');assert.ok(result[kind]);assert.equal(result[kind].frames.length,8);assert.equal(result.metrics.ssim.state,'completed');}
  await measuredWitnesses(library,kind,plan,kind==='single'?[input.request]:frozen.input.pairs,f.input,{...f.input.plan,value:library.qualityCorrespondence.result(f.input.plan.id,f.actor)});
  assert.equal(JSON.stringify(await read()),oldJson,'Original terminal job/attempt/reason stays byte-identical');
  if(oldResult)assert.deepEqual(await f.json(url+((kind==='vmaf'||kind==='xpsnr')?'/result':'/results')),oldResult);
  if(oldCandidate)assert.deepEqual(await f.json('/api/annotations/spaces/default/'+oldCandidate.id),oldCandidate);
  const center=await f.json('/api/tasks/'+kind+'/'+first.id),successorCenter=await f.json('/api/tasks/'+kind+'/'+done.id);assert.ok(center.related.some((r:any)=>r.relation==='reexecution'&&r.id===done.id));assert.ok(successorCenter.related.some((r:any)=>r.relation==='parent-reexecution'&&r.id===first.id));assert.equal((await f.request('/api/tasks/'+kind+'/'+first.id,undefined,undefined,{cookie:'voidplayer-user='+other,'x-voidplayer-actor':other})).status,404);
  const chain=await f.json(url+'/reexecutions');assert.equal(chain.successor.id,done.id);assert.equal((await f.json(collection+'/'+done.id+'/reexecutions')).retryOf.retryOf,first.id);
  if(kind==='single'){
    const candidate=await f.json('/api/annotations/spaces/default',{action:'create-quality-candidate',operationId:randomUUID(),id:randomUUID(),revision:0,candidate:{text:'Explicit reexecuted PSNR/SSIM/grid candidate',severity:2},evidence:{jobId:done.id,attemptId:done.attempt.id,digest:done.result.digest,side:'reference'},client:{kind:'agent',id:'explicit-reexecution-test'}},'single-candidate',{'x-voidplayer-action':'annotation'});
    assert.equal(candidate.document.mark.qualityEvidence[0].ref.jobId,done.id);
  }
  if(kind!=='single'){
    assert.equal(await f.json(collection+'/'+done.id+'/candidates'),null,'new success never automatically publishes');
    const policy=kind==='range'?{...rangePolicy,text:'Explicit new full-range candidate'}:{space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'Explicit reexecuted native candidate',severity:2};
    const published=await f.json(collection+'/'+done.id+'/candidates',policy);assert.equal(published.createdIds.length,1);
    const candidate=await f.json('/api/annotations/spaces/default/'+published.createdIds[0]);const evidence=candidate.document.mark.qualityEvidence[0];if((kind==='vmaf'||kind==='xpsnr'))assert.ok(evidence.ref.jobId.startsWith(done.id+'-f'));else assert.ok(done.samples.some((s:any)=>s.jobId===evidence.ref.jobId),'new range candidate cites a newly computed child, not an old sample');
  }
  // Receipt-first replay is independent of now-invalid source eligibility.
  const file=path.join(f.media,'reference.'+f.containers[0]),bytes=await readFile(file);await writeFile(file,Buffer.concat([bytes,Buffer.from([0])]));
  assert.equal((await f.json(url+'/reexecutions',request,kind==='single'?'frozen-example:single.reexecute':'frozen-reexecution-key')).job.id,done.id);
  assert.equal((await f.json(collection+'/'+done.id+'/reexecution-plan',{reason})).eligible,false,'completed successors cannot be recomputed');
  // Result retention is independent of an already committed acceptance receipt.
  if(kind==='single')((library.qualityJobs as any).store.db).prepare('UPDATE quality_jobs SET result_json=NULL WHERE id=?').run(done.id);
  else if(kind==='range')for(const sample of done.samples)((library.qualityJobs as any).store.db).prepare('UPDATE quality_jobs SET result_json=NULL WHERE id=?').run(sample.jobId);
  else ((kind==='xpsnr'?library.qualityXpsnr:library.qualityVmaf) as any).db.prepare('UPDATE quality_'+kind+'_jobs SET result=NULL,prepared=NULL WHERE id=?').run(done.id);
  const retained=await f.json(url+'/reexecutions',request,kind==='single'?'frozen-example:single.reexecute':'frozen-reexecution-key');assert.equal(retained.replayed,true);assert.equal(retained.job.id,done.id);assert.deepEqual(retained.receipt,accepted.receipt,'receipt replay survives source changes and result reclamation');

});

// Each crash executes inside a separate real service process. No response is
// fabricated and the helper kills synchronously at the transaction boundary.
for(const kind of ['single','range','vmaf','xpsnr'] as const)test(`${kind}: SIGKILL before/after receipt commit, restart and exact-key replay create at most one successor`,{timeout:180000},async t=>{
  const {spawn}=await import('node:child_process'),{once}=await import('node:events');
  const f=await (kind==='xpsnr'?xpsnrFixture:nativeFixture)({distorted:true,containers:['mp4','flv']});let closeProcess=async()=>{};t.after(async()=>{await closeProcess();await f.close();});
  const lib=f.service.library,runner=lib.quality as any,create=runner.createWorker;let gate:Int32Array|undefined;
  runner.createWorker=(data:any)=>{if(data.mode==='measure'&&!gate){gate=new Int32Array(new SharedArrayBuffer(20));return new Worker(new URL('../helpers/quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:'decode',phaseState:gate.buffer}});}return create(data);};
  if((kind==='vmaf'||kind==='xpsnr')){const r=((kind==='xpsnr'?lib.qualityXpsnr:lib.qualityVmaf) as any).runner,run=r.run.bind(r);r.run=(...args:any[])=>run(args[0],args[1],args[2],{...args[3],...({prepared:(p:any)=>{args[3].prepared(p);throw Error('Injected failure after real companion preparation');}})});}
  const range=lib.qualityCorrespondence.result(f.input.plan.id,f.actor).rangePlan!.input;
  const collection=kind==='single'?'/api/quality/jobs':kind==='range'?'/api/quality/ranges':'/api/quality/'+kind+'/jobs';
  const body=kind==='single'?{schema:'voidplayer-psnr-frame-job',version:1,client:{id:'crash-original',kind:'agent'},request:range.pairs[0]}:kind==='range'?range:f.input;
  const original=(await f.json(collection,body,'crash-original')).job,url=collection+'/'+original.id;
  const get=async()=>{const r=await f.json(url);return kind==='range'?r.job:r;};
  if(kind==='single'||kind==='range'){await until(()=>gate&&Atomics.load(gate,0),Boolean,'Original actual decode gate');await f.json(url+'/cancel',{});}
  await until(get,(j:any)=>['failed','cancelled','partial'].includes(j.state),'Original physical exit');const frozenOriginal=JSON.stringify(await get());
  const plan=await f.json(url+'/reexecution-plan',{reason:'Explicit crash-boundary full recomputation'});assert.equal(plan.eligible,true,JSON.stringify(plan));
  const request={schema:'voidplayer-quality-reexecution',version:1,reason:plan.reason,planDigest:plan.digest,confirm:plan.cost},settings=path.join(f.directory,'service.json'),marker=path.join(f.directory,'receipt.json');await writeFile(settings,JSON.stringify(f.config));await f.stop();
  let child:any,output='',base='';
  const stop=async()=>{if(!child)return;if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill('SIGTERM');await done;}child=undefined;};closeProcess=stop;
  const start=async(mode:string)=>{output='';child=spawn(process.execPath,[path.resolve('test/helpers/quality-reexecution-server.mjs'),settings,mode,marker],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});child.stdout.on('data',(b:Buffer)=>output=(output+b).slice(-65536));child.stderr.on('data',(b:Buffer)=>output=(output+b).slice(-65536));const port=await until(()=>{assert.equal(child.exitCode,null,output);return Number(/"event":"ready","port":(\d+)/.exec(output)?.[1]);},Boolean,'Restart service ready');base='http://127.0.0.1:'+port;};
  const req=(suffix='',value?:unknown,key='frozen-process-key')=>fetch(base+url+suffix,{method:value===undefined?'GET':'POST',headers:{...f.headers,origin:base,'idempotency-key':key},...(value===undefined?{}:{body:JSON.stringify(value)})});
  await start('before-commit');let closed=once(child,'close');await assert.rejects(req('/reexecutions',request));await closed;assertForcedProcessExit(child);const uncommitted=JSON.parse(await readFile(marker,'utf8'));await stop();
  await start('normal');assert.equal((await(await req('/reexecutions')).json()).successor,null,'uncommitted successor and receipt rolled back together');assert.equal((await fetch(base+collection+'/'+uncommitted.jobId,{headers:f.headers})).status,404);assert.equal(JSON.stringify(kind==='range'?(await(await req()).json()).job:await(await req()).json()),frozenOriginal);assert.doesNotMatch(output,/measure-start/,'startup never recomputes');await stop();
  await start('after-commit');closed=once(child,'close');await assert.rejects(req('/reexecutions',request));await closed;assertForcedProcessExit(child);const committed=JSON.parse(await readFile(marker,'utf8'));await stop();
  await start('normal');const chain=await(await req('/reexecutions')).json();assert.equal(chain.successor.id,committed.jobId);assert.equal(chain.successor.state,'interrupted');assert.doesNotMatch(output,/measure-start/,'restart observes the committed successor without automatic execution');
  const replay=await req('/reexecutions',request);assert.equal(replay.status,200,await replay.clone().text());const receipt=await replay.json();assert.equal(receipt.replayed,true);assert.equal(receipt.job.id,committed.jobId);assert.deepEqual(receipt.receipt,committed);
  assert.equal((await req('/reexecutions',request,'another-window')).status,409);assert.equal(JSON.stringify(kind==='range'?(await(await req()).json()).job:await(await req()).json()),frozenOriginal);assert.doesNotMatch(output,/measure-start/);
});

for(const kind of ['single','range','vmaf','xpsnr'] as const)test(`${kind}: changed cache/plan/executor/model/source, legacy witness and unconfirmed physical stop refuse new computation`,{timeout:180000},async t=>{
  const {cp,mkdir,truncate}=await import('node:fs/promises'),{openIndexDatabase}=await import('../../server/sqlite.ts');
  const f=await (kind==='xpsnr'?xpsnrFixture:nativeFixture)({distorted:true,containers:['mp4','flv']});t.after(()=>f.close());const lib=f.service.library,runner=lib.quality as any,create=runner.createWorker;let gate:Int32Array|undefined,measures=0;
  runner.createWorker=(data:any)=>{if(data.mode==='measure'){measures++;if(!gate){gate=new Int32Array(new SharedArrayBuffer(20));return new Worker(new URL('../helpers/quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:'decode',phaseState:gate.buffer}});}}return create(data);};
  if((kind==='vmaf'||kind==='xpsnr')){const r=((kind==='xpsnr'?lib.qualityXpsnr:lib.qualityVmaf) as any).runner,run=r.run.bind(r);r.run=(...args:any[])=>run(args[0],args[1],args[2],{...args[3],...({prepared:(p:any)=>{args[3].prepared(p);throw Error('Injected failure after real companion preparation');}})});}
  const collection=kind==='single'?'/api/quality/jobs':kind==='range'?'/api/quality/ranges':'/api/quality/'+kind+'/jobs',range=lib.qualityCorrespondence.result(f.input.plan.id,f.actor).rangePlan!.input;
  const accepted=kind==='range'?await f.json('/api/quality/correspondence-plans/'+f.input.plan.id+'/execute',{digest:f.input.plan.digest}):await f.json(collection,kind==='single'?{schema:'voidplayer-psnr-frame-job',version:1,client:{id:'frozen-negatives',kind:'agent'},request:range.pairs[0]}:f.input,'negative-original');const url=collection+'/'+accepted.job.id;
  const read=async()=>{const r=await f.json(url);return kind==='range'?r.job:r;};if(kind==='single'||kind==='range'){await until(()=>gate&&Atomics.load(gate,0),Boolean);await f.json(url+'/cancel',{});}await until(read,(j:any)=>['failed','cancelled','partial'].includes(j.state));
  const original=JSON.stringify(await read()),reason='Verify exact original conditions',good=await f.json(url+'/reexecution-plan',{reason});assert.equal(good.eligible,true,JSON.stringify(good));const count=measures;
  const blocked=async()=>{const r=await f.request(url+'/reexecution-plan',{reason}),v=await r.json();assert.ok(r.status===409||r.status===200&&!v.eligible,JSON.stringify(v));assert.equal((await f.json(url+'/reexecutions')).successor,null);assert.equal(measures,count,'blocked metadata validation does not score');};
  const db=openIndexDatabase(lib.indexDatabase),saved=db.prepare('SELECT producer_json FROM media_index_manifests WHERE media_id=?').get(f.entries[0].id)!.producer_json;
  try{db.prepare('UPDATE media_index_manifests SET producer_json=? WHERE media_id=?').run('{}',f.entries[0].id);await blocked();}finally{db.prepare('UPDATE media_index_manifests SET producer_json=? WHERE media_id=?').run(saved,f.entries[0].id);db.close();}
  if(kind!=='single'){
    const c=(lib.qualityCorrespondence as any).db,row=c.prepare('SELECT body FROM quality_correspondence_plans WHERE id=?').get(f.input.plan.id),body=JSON.parse(String(row.body));body.resultDigest='f'.repeat(64);try{c.prepare('UPDATE quality_correspondence_plans SET body=? WHERE id=?').run(JSON.stringify(body),f.input.plan.id);await blocked();}finally{c.prepare('UPDATE quality_correspondence_plans SET body=? WHERE id=?').run(row.body,f.input.plan.id);}
  }
  if((kind==='vmaf'||kind==='xpsnr')){
    const r=((kind==='xpsnr'?lib.qualityXpsnr:lib.qualityVmaf) as any).runner,prior=r.analysisDir,copy=path.join(f.directory,'changed-analysis');await cp(prior,copy,{recursive:true});const restore=await replaceRunnerAnalysisDirectory(r,copy);try{await truncate(path.join(copy,'voidplayer-analysis.wasm'),8);await blocked();}finally{await restore();}
    if(kind==='xpsnr'){try{r.stopUncertain=true;const p=await f.json(url+'/reexecution-plan',{reason});assert.ok(p.blocks.some((b:any)=>b.code==='xpsnr-service-unavailable'&&b.next==='wait-and-replan'));}finally{r.stopUncertain=false;}}

  }else{
    const core=runner.coreDir,copy=path.join(f.directory,'changed-core');await mkdir(copy);for(const name of ['voidplayer-core.js','voidplayer-core.wasm','capabilities.json','provenance.json'])await cp(path.join(core,name),path.join(copy,name));try{runner.coreDir=copy;const js=path.join(copy,'voidplayer-core.js');await writeFile(js,Buffer.concat([await readFile(js),Buffer.from('\n')]));await blocked();await truncate(js,33*1024*1024);await blocked();}finally{runner.coreDir=core;}
    try{runner.stopFailed=true;const p=await f.json(url+'/reexecution-plan',{reason});assert.ok(p.blocks.some((b:any)=>b.code==='physical-stop-unconfirmed'&&b.next==='wait-and-replan'));}finally{runner.stopFailed=false;}
  }
  if(kind==='single'){
    const store=(lib.qualityJobs as any).store,raw=store.db.prepare('SELECT execution_json FROM quality_jobs WHERE id=?').get(accepted.job.id).execution_json;try{store.db.prepare('UPDATE quality_jobs SET execution_json=? WHERE id=?').run('{}',accepted.job.id);const p=await f.json(url+'/reexecution-plan',{reason});assert.ok(p.blocks.some((b:any)=>b.code==='execution-contract-unavailable'));}finally{store.db.prepare('UPDATE quality_jobs SET execution_json=? WHERE id=?').run(raw,accepted.job.id);}
  }
  const restored=await f.json(url+'/reexecution-plan',{reason});assert.equal(restored.digest,good.digest,JSON.stringify(restored));
  const source=path.join(f.media,'reference.mp4'),bytes=await readFile(source);bytes[bytes.length-1]^=1;await writeFile(source,bytes);await blocked();const request={schema:'voidplayer-quality-reexecution',version:1,reason,planDigest:good.digest,confirm:good.cost};assert.equal((await f.request(url+'/reexecutions',request,'blocked-after-preview')).status,409);
  assert.equal(JSON.stringify(await read()),original,'negative plans never rewrite original facts');
});
