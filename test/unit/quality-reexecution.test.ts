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
