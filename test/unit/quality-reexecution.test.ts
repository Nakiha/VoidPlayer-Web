import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {QualityJobStore} from '../../server/analysis/quality/job-store.ts';
import {qualityJobRequest} from '../../server/analysis/quality/job-request.ts';
import {ReexecutionLedger} from '../../server/analysis/quality/reexecution-ledger.ts';
import {nextReexecutionLineage,reexecutionRequest,reexecutionReason} from '../../shared/analysis/quality/reexecution.ts';
import type {QualityExecutionContract,ReexecutionRequest} from '../../shared/analysis/quality/reexecution.ts';
import {jobInput} from '../helpers/quality-job-fixture.ts';
import {QualityReexecutionClient} from '../../src/services/quality-reexecution.ts';
import {ApiError} from '../../src/services/api-error.ts';
import type {ReexecutionPlan} from '../../shared/analysis/quality/reexecution.ts';

const actor={id:'reexecution-owner',name:'Owner'},hash='a'.repeat(64);
const contract:QualityExecutionContract={schema:'voidplayer-quality-execution-contract',version:1,environment:{schema:'voidplayer-quality-execution-environment',version:1,runtime:'node',runtimeVersion:process.versions.node,recipe:'source-yuv-psnr-ssim-packet-identity-v1',assets:[{file:'voidplayer-core.wasm',sha256:hash,bytes:123}]},sources:[]};
const request:ReexecutionRequest={schema:'voidplayer-quality-reexecution',version:1,reason:'Explicitly recompute after the stopped failure',planDigest:hash,confirm:{scope:'entire-frozen-input-from-start',selectedPairs:1,reusesPreviousScores:false,budget:{maxElapsedMs:30000},reservation:{}}};
test('explicit full-scope confirmation and bounded lineage keep attempt and execution generation separate',()=>{
  assert.deepEqual(reexecutionRequest(request),request);assert.equal(reexecutionReason(' reason '),'reason');
  for(const v of [{...request,reason:''},{...request,unknown:true},{...request,planDigest:'short'},{...request,confirm:{...request.confirm,reusesPreviousScores:true}},{...request,confirm:{...request.confirm,scope:'resume-holes'}}])assert.throws(()=>reexecutionRequest(v));
  const first=nextReexecutionLineage('original',undefined,request.reason,hash,100);assert.equal(first.generation,2);assert.equal(first.rootJobId,'original');
  const second=nextReexecutionLineage('second',first,'Another explicit decision',hash,200);assert.equal(second.generation,3);assert.equal(second.retryOf,'second');assert.equal(second.rootJobId,'original');
  assert.throws(()=>nextReexecutionLineage('last',{...second,generation:32},'stop',hash,300));
});
class MemoryStorage{
  values=new Map<string,string>();fail=false;
  get length(){return this.values.size;}key(index:number){return [...this.values.keys()][index]??null;}
  getItem(key:string){return this.values.get(key)??null;}removeItem(key:string){this.values.delete(key);}
  setItem(key:string,value:string){if(this.fail)throw Error('Storage unavailable');this.values.set(key,value);}
}
const parentId='00000000-0000-4000-8000-000000000001',newId='00000000-0000-4000-8000-000000000002';
const clientPlan={schema:'voidplayer-quality-reexecution-plan',version:1,kind:'single',jobId:parentId,state:'failed',revision:2,reason:request.reason,eligible:true,blocks:[],digest:hash,cost:request.confirm,previous:{reason:null,result:null},lineage:null,contract:null,inputDigest:hash,next:{plan:'',execute:'',chain:''}} as ReexecutionPlan;
test('GUI empty or malformed success keeps the exact actor/body/key; same-key receipt replay clears it only after ownership validation',async()=>{
  for(const bad of [null,{}, {job:{id:newId,state:'queued'},replayed:false}]){
    const storage=new MemoryStorage(),calls:any[]=[];let valid=false,pending:any;
    const api={async request<T>(...args:any[]){calls.push(args);if(!valid)return bad as T;const lineage=nextReexecutionLineage(parentId,undefined,pending.body.reason,pending.body.planDigest,2000);return {job:{id:newId,state:'queued',retryOf:lineage},replayed:true,receipt:{actorId:actor.id,parentId,jobId:newId,key:pending.key,request:pending.body,lineage}} as T;}};
    const client=new QualityReexecutionClient(storage,'http://localhost:8123',api,()=> 'frozen-browser-key');pending=client.freeze(actor.id,'single',parentId,clientPlan);
    await assert.rejects(client.send(pending,actor.id,new AbortController().signal),/acknowledgement/);assert.equal(client.pending(actor.id,'single')!.key,pending.key);assert.throws(()=>client.clearRejected(actor.id,'single'),/unknown/);
    await assert.rejects(client.send(pending,'another-actor',new AbortController().signal),/Actor changed/);assert.equal(calls.length,1);
    valid=true;const accepted=await client.send(pending,actor.id,new AbortController().signal);assert.equal(accepted.job.id,newId);assert.equal(client.pending(actor.id,'single'),null);assert.equal(calls.length,2);assert.equal(JSON.stringify(calls[0][4]),JSON.stringify(calls[1][4]));assert.equal(calls[0][5],calls[1][5]);assert.equal(calls[0][0],actor.id);
  }
});
test('GUI transport/body-budget failures stay unknown; only a definite parsed 4xx can end the local request',async()=>{
  const storage=new MemoryStorage();let known=false;
  const api={async request<T>():Promise<T>{if(known)throw new ApiError(409,'Frozen conditions changed','reexecution-blocked');throw Error('Response byte budget or truncated body');}};
  const client=new QualityReexecutionClient(storage,'http://localhost:8123',api,()=> 'frozen-browser-key'),p=client.freeze(actor.id,'single',parentId,clientPlan);
  await assert.rejects(client.send(p,actor.id,new AbortController().signal));assert.equal(client.pending(actor.id,'single')?.rejected,undefined);assert.throws(()=>client.clearRejected(actor.id,'single'));
  known=true;await assert.rejects(client.send(p,actor.id,new AbortController().signal),{status:409});assert.equal(client.pending(actor.id,'single')!.rejected!.status,409);client.clearRejected(actor.id,'single');assert.equal(client.pending(actor.id,'single'),null);
});
test('GUI persistence failure or unresolved capacity never sends/evicts, and origins do not inherit another server request',()=>{
  const storage=new MemoryStorage();storage.fail=true;let calls=0;const api={async request<T>():Promise<T>{calls++;throw Error('Must not send');}};
  const client=new QualityReexecutionClient(storage,'http://localhost:8123',api,()=> 'frozen-browser-key');assert.throws(()=>client.freeze(actor.id,'single',parentId,clientPlan),/Storage/);assert.equal(calls,0);
  storage.fail=false;const p=client.freeze(actor.id,'single',parentId,clientPlan);assert.equal(new QualityReexecutionClient(storage,'http://localhost:8124',api).pending(actor.id,'single'),null);
  assert.throws(()=>client.freeze(actor.id,'single',newId,{...clientPlan,jobId:newId}),/existing unknown/);assert.equal(client.pending(actor.id,'single')!.bodyJson,p.bodyJson);
  for(let n=0;n<15;n++)storage.setItem('voidplayer-quality-reexecution:other-'+n,'unknown');assert.throws(()=>client.freeze('other','range',parentId,{...clientPlan,kind:'range'}),/history is full/);assert.equal(storage.length,16);
});
test('new job and exact reexecution receipt commit atomically; replay/restart never fork or rewrite the original',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'vp-reexecution-ledger-')),file=path.join(directory,'jobs.sqlite');let store=new QualityJobStore(file,1000);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const input=qualityJobRequest(jobInput()),original=store.submit(input,actor,'first-request','first-key',1000).job,attempt=store.start(original.id,1001);
  store.recordExecutionContract(original.id,attempt,contract);store.finish(original.id,attempt,'failed',{code:'decoder-error',message:'Stopped failure'},1002);
  const before=JSON.stringify(store.get(original.id)),lineage=nextReexecutionLineage(original.id,undefined,request.reason,hash,2000),creation={parentId:original.id,parentRevision:store.get(original.id).revision,key:'explicit-original-key',request,lineage,contract};
  const insert=ReexecutionLedger.prototype.insert;let injected=false;
  ReexecutionLedger.prototype.insert=function(...args){injected=true;throw Error('Failure after new-row insertion and before receipt commit');};
  try{assert.throws(()=>store.submit(input,actor,'retry-request','private-new-key',2000,creation),/before receipt commit/);}finally{ReexecutionLedger.prototype.insert=insert;}
  assert.equal(injected,true);assert.equal(store.changes(actor.id).entries.length,1);assert.equal(store.reexecutions.get(original.id,actor.id),null);assert.equal(JSON.stringify(store.get(original.id)),before);
  const accepted=store.submit(input,actor,'retry-request','private-new-key',2000,creation);assert.equal(accepted.replayed,false);assert.equal(accepted.job.attempt,null);assert.deepEqual(accepted.job.retryOf,lineage);assert.deepEqual(accepted.job.input,input.input);assert.notEqual(accepted.job.id,original.id);
  assert.equal(store.submit(input,actor,'late-response','another-private-key',2001,creation).job.id,accepted.job.id);assert.equal(store.changes(actor.id).entries.length,2);
  assert.throws(()=>store.submit(input,actor,'double-window','unused-private-key',2002,{...creation,key:'different-window-key'}),{code:'reexecution-conflict'});
  assert.throws(()=>store.submit(input,actor,'changed-body','unused-private-key',2002,{...creation,request:{...request,reason:'changed'}}),{code:'reexecution-conflict'});
  assert.equal(JSON.stringify(store.get(original.id)),before);
  store.close();store=new QualityJobStore(file,3000);assert.equal(store.get(accepted.job.id).state,'interrupted');assert.equal(store.get(accepted.job.id).attempt,null);assert.equal(store.queued(),null);
  const replay=store.submit(input,actor,'after-restart','unused-after-restart',3001,creation);assert.equal(replay.replayed,true);assert.equal(replay.job.id,accepted.job.id);assert.equal(store.changes(actor.id).entries.length,2);assert.equal(JSON.stringify(store.get(original.id)),before);
  assert.equal(store.reexecutions.get(original.id,'another-actor'),null);
});
