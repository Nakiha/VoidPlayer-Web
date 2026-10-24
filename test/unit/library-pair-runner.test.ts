import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { MediaLibraryIndex } from '../../server/library.ts';
import { LibraryPairRunner } from '../../server/analysis/quality/runner.ts';
import { FrameIndexJobs } from '../../server/frame-index-jobs.ts';
import { AnalysisScheduler } from '../../server/analysis/bitstream/scheduler.ts';
import { QualityAdmission } from '../../server/quality-admission.ts';
import { FLV_MEDIA_INDEX_IDENTITY } from '../../shared/media/indexing/media-index-identity.ts';
import { pairRequest } from '../helpers/frame-pair-fixture.ts';
import type { PairTarget } from '../../shared/analysis/quality/frame-pair.ts';
import { PAIR_LIMITS } from '../../shared/analysis/quality/frame-pair.ts';
import { createPairDecoder } from '../../shared/analysis/quality/wasm-decoder.ts';
import { WasmMemoryBudgetError } from '../../shared/wasm/core.ts';
const target:PairTarget={mediaId:'a'.repeat(24),mediaVersion:'b'.repeat(24),size:100,indexIdentity:{...FLV_MEDIA_INDEX_IDENTITY},indexBuildId:'test-cache',sourcePtsUs:0,
 picture:{sourceVersion:`${'a'.repeat(24)}@${'b'.repeat(24)}`,stream:'video',configuration:0,au:0,picture:0,layer:0,field:'frame'}};
test('decode-time WASM growth denial remains an explicit budget failure and destroys its packet context',async()=>{
 let destroyed=false,freed=false;const core={_vp_frame_info(){},_vp_frame_format(){},_vp_core_build_id(){},_vp_packet_open(){},_malloc:()=>4,_free:()=>{freed=true;},
 ccall(name:string){if(name==='vp_core_build_id')return 'a'.repeat(40);if(name==='vp_create')return 1;if(name==='vp_packet_open')throw new WasmMemoryBudgetError();if(name==='vp_destroy')destroyed=true;}};
 const decoder=await createPairDecoder(async()=>({core,heap:()=>new Uint8Array(64)}));
 await assert.rejects(decoder.decode('h264',new Uint8Array([1]),new Uint8Array([1]),0,0,PAIR_LIMITS),{code:'budget-exceeded'});assert.equal(destroyed,true);assert.equal(freed,true);decoder.close();
});
function host(){
 const qualityAdmission=new QualityAdmission();
 const library={qualityAdmission,indexDatabase:'/unused',resolve:async()=>{throw Error('unowned host resolve');},metadata:()=>{throw Error('unowned host metadata');},
 indexJobs:{call:async()=>{throw Error('unowned host database RPC');}}} as unknown as MediaLibraryIndex;
 return {library,gate:qualityAdmission};
}
function runnerFor(h:ReturnType<typeof host>,create:(data:any)=>Worker){return new LibraryPairRunner(h.library,'/unused',create);}
function heldWorker(){
 let release!:()=>void,fail!:(error:unknown)=>void,notifyTerminate!:()=>void;
 const terminating=new Promise<void>(resolve=>notifyTerminate=resolve);
 const stopped=new Promise<number>((resolve,reject)=>{release=()=>resolve(0);fail=reject;});
 const events=new EventEmitter();let terminationCalls=0;
 const worker=Object.assign(events,{terminate(){terminationCalls++;notifyTerminate();return stopped;},postMessage(){}}) as unknown as Worker;
 return {worker,release,fail,terminating,get terminationCalls(){return terminationCalls;}};
}
for(const reason of [null,false,0,''])test(`server cancellation preserves ${JSON.stringify(reason)} and holds instance admission until termination`,async()=>{
 const h=host(),w=heldWorker();let constructed!:()=>void;const started=new Promise<void>(resolve=>constructed=resolve);
 const runner=runnerFor(h,()=>{constructed();return w.worker;}),controller=new AbortController();
 const task=runner.measure(pairRequest(target),controller.signal);const checked=assert.rejects(task,error=>error===reason);await started;
 controller.abort(reason);assert.equal(w.terminationCalls,1);assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});assert.throws(()=>h.gate.ordinary(),{code:'quality-busy'});
 let settled=false;void task.then(()=>settled=true,()=>settled=true);await Promise.resolve();assert.equal(settled,false);
 w.release();await checked;const release=h.gate.acquire();release();await runner.close();
});
for(const event of ['error','messageerror','exit'] as const)test(`server ${event} terminal waits for Worker stop`,async()=>{
 const h=host(),w=heldWorker();let constructed!:()=>void;const started=new Promise<void>(resolve=>constructed=resolve);
 const runner=runnerFor(h,()=>{constructed();return w.worker;});
 const checked=assert.rejects(runner.measure(pairRequest(target),new AbortController().signal),{code:'decoder-error'});await started;
 w.worker.emit(event,event==='exit'?7:new Error('fixture worker fault'));assert.equal(w.terminationCalls,1);assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});
 w.release();await checked;h.gate.acquire()();await runner.close();
});
test('late final success cannot replace cancellation while physical termination is pending',async()=>{
 const h=host(),w=heldWorker();let constructed!:()=>void;const started=new Promise<void>(resolve=>constructed=resolve);
 const runner=runnerFor(h,()=>{constructed();return w.worker;});
 const controller=new AbortController(),reason=new Error('cancelled during final check');
 const checked=assert.rejects(runner.measure(pairRequest(target),controller.signal),error=>error===reason);await started;
 controller.abort(reason);w.worker.emit('message',{ok:true,value:{schema:'voidplayer-library-frame-pair-psnr'}});assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});w.release();await checked;h.gate.acquire()();await runner.close();
});
test('failed termination keeps quality admission poisoned rather than overlapping a new Worker',async()=>{
 const h=host(),w=heldWorker();let constructed!:()=>void;const started=new Promise<void>(resolve=>constructed=resolve);
 const runner=runnerFor(h,()=>{constructed();return w.worker;}),controller=new AbortController(),stopError=new Error('unknown worker survival');
 const checked=assert.rejects(runner.measure(pairRequest(target),controller.signal),error=>error===stopError);await started;controller.abort();w.fail(stopError);await checked;
 assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});assert.equal(w.terminationCalls,1);await assert.rejects(runner.close(),error=>error===stopError);
});
test('source lookup deadline covers a never-resolving check and rejects late completion',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=host(),w=heldWorker();let created=0;
 const runner=runnerFor(h,()=>{created++;return w.worker;});
 const checked=assert.rejects(runner.source(target.mediaId,target.mediaVersion),{code:'budget-exceeded'});
 t.mock.timers.tick(PAIR_LIMITS.maxElapsedMs);assert.equal(created,1);assert.equal(w.terminationCalls,1);assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});
 w.worker.emit('message',{ok:true,value:{binding:target,producer:{}}});w.release();await checked;h.gate.acquire()();await runner.close();
});
test('close cancels a suspended source lookup, waits physical exit, and never revives late IO',async()=>{
 const h=host(),w=heldWorker();let created=0;const runner=runnerFor(h,()=>{created++;return w.worker;});
 const checked=assert.rejects(runner.source(target.mediaId,target.mediaVersion),{code:'cancelled'}),closing=runner.close();let closed=false;void closing.then(()=>closed=true);
 await Promise.resolve();assert.equal(closed,false);assert.equal(w.terminationCalls,1);assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});
 w.worker.emit('message',{ok:true,value:{binding:target,producer:{}}});w.release();await checked;await closing;
 await assert.rejects(runner.source(target.mediaId,target.mediaVersion),{code:'busy'});assert.equal(created,1);h.gate.acquire()();
});
test('cancellation revokes new source IO and drains its descriptor scope before terminate',async()=>{
 const h=host(),w=heldWorker();let control!:Int32Array;
 const runner=runnerFor(h,data=>{control=new Int32Array(data.control);Atomics.store(control,1,1);return w.worker;}),controller=new AbortController(),reason=new Error('cancel during source IO');
 const checked=assert.rejects(runner.measure(pairRequest(target),controller.signal),error=>error===reason);controller.abort(reason);
 assert.equal(Atomics.load(control,0),1);assert.equal(w.terminationCalls,0,'Bun must not be terminated with an unmanaged source descriptor open');assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});
 Atomics.store(control,1,0);Atomics.notify(control,1);await w.terminating;assert.equal(w.terminationCalls,1);
 assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});w.release();await checked;h.gate.acquire()();await runner.close();
});
test('an exited worker with unclosed source IO poisons admission instead of inventing cleanup',async()=>{
 const h=host(),w=heldWorker();const runner=runnerFor(h,data=>{Atomics.store(new Int32Array(data.control),1,1);return w.worker;});
 const checked=assert.rejects(runner.measure(pairRequest(target),new AbortController().signal),/unsettled source IO/);w.worker.emit('exit',1);await checked;
 assert.equal(w.terminationCalls,0);assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});await assert.rejects(runner.close(),/unsettled source IO/);
});
test('index builds retain physical exit exclusion and reject new builds/uploads while quality owns it',async()=>{
 const gate=new QualityAdmission(),w=heldWorker(),jobs=new FrameIndexJobs('/unused','/unused',()=>w.worker,gate);
 const request={id:target.mediaId,version:target.mediaVersion,size:100,filePath:'/unused',epoch:0,identity:FLV_MEDIA_INDEX_IDENTITY};
 const pending=jobs.buildIndex(request);let settled=false;void pending.then(()=>settled=true);w.worker.emit('message',{value:{built:true}});
 await Promise.resolve();assert.equal(settled,false);assert.throws(()=>gate.acquire(),{code:'quality-busy'});w.release();await pending;await new Promise(resolve=>setImmediate(resolve));
 const release=gate.acquire();assert.throws(()=>jobs.acquireUpload(),{code:'quality-busy'});assert.throws(()=>jobs.startBuild(request),{code:'quality-busy'});await assert.rejects(jobs.call('put',{id:target.mediaId,version:target.mediaVersion,size:100,identity:FLV_MEDIA_INDEX_IDENTITY,bytes:new Uint8Array()}),{code:'quality-busy'});release();await jobs.close();
});
test('bitstream pending submission and quality exclusion share the same instance boundary',async()=>{
 const h=host(),dir=await mkdtemp(join(tmpdir(),'vp-quality-admission-'));let answer!:(value:null)=>void;
 h.library.resolve=()=>new Promise<null>(resolve=>answer=resolve);
 const scheduler=new AnalysisScheduler(h.library,'/unused',dir);
 try{
  const target={sourceVersion:`${'a'.repeat(24)}@${'b'.repeat(24)}`,sourcePtsUs:0,normalizedMediaUs:0};
  const pending=scheduler.submit('a'.repeat(24),'b'.repeat(24),target,'owner');const checked=assert.rejects(pending);await Promise.resolve();
  assert.throws(()=>h.gate.acquire(),{code:'quality-busy'});answer(null);await checked;
  const release=h.gate.acquire();await assert.rejects(scheduler.submit('a'.repeat(24),'b'.repeat(24),target,'owner'),error=>(error as {info:{code:string}}).info.code==='resource-limit');release();
 }finally{await scheduler.close();await rm(dir,{recursive:true,force:true});}
});
