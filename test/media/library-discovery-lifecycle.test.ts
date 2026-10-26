import test from 'node:test';import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';import {fstatSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {Worker} from 'node:worker_threads';
import {MediaLibraryIndex} from '../../server/library.ts';import {DiscoveryProbeRunner} from '../../server/discovery/probe-runner.ts';import {DiscoveryStore} from '../../server/discovery/store.ts';
const sample=JSON.parse(await readFile(new URL('../helpers/quality-http-samples.json',import.meta.url),'utf8')).samples.find((s:any)=>s.codec==='h264'&&s.depth===8&&s.tagged);
async function setup(t:any){const dir=await mkdtemp(path.join(tmpdir(),'vp-probe-lifecycle-'));await writeFile(path.join(dir,'source.flv'),Buffer.from(sample.flv,'base64'));
 const library=new MediaLibraryIndex([dir],{database:path.join(dir,'library.sqlite'),watch:false});await library.refresh();const entry=library.browse({recursive:true}).entries[0];
 const cleanup:(()=>Promise<unknown>|void)[]=[];t.after(async()=>{for(const close of cleanup)await close();await library.close();await rm(dir,{recursive:true,force:true});});return{dir,library,cleanup,source:{id:entry.id,version:entry.version!}};}
const stage=async(state:Int32Array)=>{const until=Date.now()+10000;while(!Atomics.load(state,0)){if(Date.now()>until)throw Error('Real probe file stage not reached');await new Promise(r=>setTimeout(r,5));}};
test('real probe cancellation/deadline/close explicitly close files before termination and retain admission until physical exit',async t=>{
 for(const phase of ['opened','publish'] as const)for(const mode of ['abort','deadline','close'] as const){const f=await setup(t),state=new Int32Array(new SharedArrayBuffer(8));
  let exited=false,allowStop!:()=>void,deadline!:()=>void,stopRequested=false;const stopGate=new Promise<void>(r=>allowStop=r);
  const runner=new DiscoveryProbeRunner(f.library.indexDatabase,f.library.qualityAdmission,data=>{
   const worker=new Worker(new URL('../helpers/discovery-phase-worker.ts',import.meta.url),{workerData:{...data,phaseState:state.buffer,hangPhase:phase},trackUnmanagedFds:true});
   worker.once('exit',()=>exited=true);const stop=worker.terminate.bind(worker);worker.terminate=async()=>{stopRequested=true;await stopGate;return stop();};return worker;
  },{set(callback,ms){assert.equal(ms,30000);deadline=callback;return 1 as any;},clear(){}});
  f.cleanup.push(async()=>{allowStop();await runner.close();});
  const controller=new AbortController();let settled=false;const work=runner.run(f.source,controller.signal,()=>{}),handled=work.then(value=>{settled=true;return {ok:true,value,error:null as any};},error=>{settled=true;return {ok:false,value:null,error};});
  await stage(state);const fd=Atomics.load(state,1);assert.ok(fstatSync(fd).isFile());assert.throws(()=>f.library.qualityAdmission.acquire());
  let closing:Promise<void>|undefined;if(mode==='abort')controller.abort(0);else if(mode==='deadline')deadline();else closing=runner.close();
  const stopDeadline=Date.now()+10000;while(!stopRequested){if(Date.now()>stopDeadline)throw Error('Actual probe IO did not drain before termination');await new Promise(r=>setTimeout(r,5));}
  assert.equal(settled,false);assert.equal(exited,false);assert.throws(()=>fstatSync(fd),e=>(e as any).code==='EBADF');assert.throws(()=>f.library.qualityAdmission.acquire());
  allowStop();const result=await handled;await closing;assert.equal(result.ok,false);assert.equal(exited,true);assert.throws(()=>fstatSync(fd),e=>(e as any).code==='EBADF');
  if(mode==='abort')assert.equal(result.error,0);if(mode==='deadline')assert.equal(result.error.code,'probe-budget-exceeded');
  const release=f.library.qualityAdmission.acquire();release();
 }
});
test('prepared metadata/result transaction, cancellation-completion races and restart interruption retain exact receipts',async t=>{
 const f=await setup(t),actor={id:'actor',name:'Actor'} as any;let store=new DiscoveryStore(f.library.indexDatabase),key=0;
 const submit=()=>store.submit({source:f.source,operation:'probe',client:{id:'agent',name:'Agent'}},actor,'request',`key-${key++}`,Date.now()).job;
 const queued=submit();assert.equal(store.cancel(queued.id,actor.id,Date.now()).state,'cancelled');
 const running=submit();store.start(running.id,Date.now());store.cancel(running.id,actor.id,Date.now());store.finish(running.id,'completed',Date.now(),null,{shouldNotPublish:true});assert.equal(store.get(running.id).state,'cancelled');assert.equal(store.get(running.id).result,null);
 const done=submit();store.start(done.id,Date.now());store.finish(done.id,'completed',Date.now(),null,{fact:'committed'});assert.equal(store.cancel(done.id,actor.id,Date.now()).state,'completed');
 const interrupted=submit();store.start(interrupted.id,Date.now());store.close();store=new DiscoveryStore(f.library.indexDatabase);f.cleanup.push(()=>store.close());assert.equal(store.get(interrupted.id).state,'interrupted');assert.equal(store.get(done.id).state,'completed');assert.deepEqual(store.get(done.id).result,{fact:'committed'});
 assert.throws(()=>store.get(done.id,'different-actor'),e=>(e as any).status===404);
 const expired=submit();assert.throws(()=>store.start(expired.id,expired.queueUntil),e=>(e as any).code==='queue-expired');store.expire(expired.queueUntil);assert.equal(store.get(expired.id).state,'failed');assert.equal(store.get(expired.id).attemptId,null);
 const atomic=submit();store.start(atomic.id,Date.now());const prior=store.db.prepare('SELECT count(*) AS n FROM discovery_probes').get()!.n;
 const descriptor:any={schema:'voidplayer-media-probe',version:1,source:f.source,streams:[],parser:'test',container:{value:'flv',status:'known',source:'container-index'},streamInventoryComplete:false,coverage:{}};
 assert.throws(()=>store.finish(atomic.id,'completed',Date.now(),null,'x'.repeat(32769),{probe:descriptor,witness:{} as any}),e=>(e as any).code==='probe-budget-exceeded');
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM discovery_probes').get()!.n,prior,'probe publication and terminal result roll back together');assert.equal(store.get(atomic.id).state,'running');store.finish(atomic.id,'failed',Date.now(),{code:'test-failure',message:'No partial result'});
});
test('CPU-bound parser deadline physically terminates the Worker with no open media or database handles',async t=>{
 const f=await setup(t),state=new Int32Array(new SharedArrayBuffer(8));let deadline!:()=>void,exited=false;
 const runner=new DiscoveryProbeRunner(f.library.indexDatabase,f.library.qualityAdmission,data=>{const worker=new Worker(new URL('../helpers/discovery-phase-worker.ts',import.meta.url),{workerData:{...data,phaseState:state.buffer,hangPhase:'parse'}});worker.once('exit',()=>exited=true);return worker;},
  {set(callback,ms){assert.equal(ms,30000);deadline=callback;return 1 as any;},clear(){}});f.cleanup.push(()=>runner.close());
 const work=runner.run(f.source,new AbortController().signal,()=>{}),handled=work.then(()=>({ok:true,error:null as any}),error=>({ok:false,error}));
 await stage(state);assert.equal(Atomics.load(state,1),-1);assert.throws(()=>f.library.qualityAdmission.acquire());deadline();const result=await handled;
 assert.equal(result.ok,false);assert.equal(result.error.code,'probe-budget-exceeded');assert.equal(exited,true);const release=f.library.qualityAdmission.acquire();release();
});
