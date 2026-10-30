import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {closeResources,cleanupAfterFailure} from '../../server/shutdown.ts';
import {MediaLibraryIndex} from '../../server/library.ts';
import {AdminController} from '../../server/admin.ts';
import {loadConfig} from '../../server/config.ts';
import {startService} from '../../server/runtime.ts';
import {QualityApplication} from '../../server/quality-application.ts';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {LibraryPairRunner} from '../../server/analysis/quality/runner.ts';
import {jobInput} from '../helpers/quality-job-fixture.ts';
import {openIndexDatabase} from '../../server/sqlite.ts';

const owners=['taskService','reexecutionService','correspondenceService','cambiService','xpsnrService','vmafService','discoveryService','rangeService','jobService','pairRunner','indexJobs'];
for(const kind of ['database','build'] as const)test(`index ${kind} stop failure retains the real SQLite worker and library ownership`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'vp-index-stop-')),database=path.join(directory,'library.sqlite');
  let index:MediaLibraryIndex|undefined,worker:Worker|undefined,healthy:Worker|undefined,stop:(()=>Promise<number>)|undefined;
  try{
    index=new MediaLibraryIndex([],{database,watch:false});
    worker=new Worker(new URL('../helpers/index-ownership-worker.ts',import.meta.url),{workerData:{database}});
    await once(worker,'message');healthy=new Worker(new URL('../helpers/index-ownership-worker.ts',import.meta.url),{workerData:{database}});await once(healthy,'message');stop=worker.terminate.bind(worker);let stops=0;
    worker.terminate=async()=>{stops++;throw Error('physical termination rejected');};
    const jobs=index.indexJobs as any;if(kind==='database'){jobs.worker=worker;jobs.buildWorkers.add(healthy);}else{jobs.buildWorkers.add(worker);jobs.worker=healthy;}
    const closing=index.close();await assert.rejects(closing,AggregateError);assert.equal(index.close(),closing);await assert.rejects(index.close());assert.equal(stops,1);assert.equal(healthy.threadId,-1,'an independent healthy worker physically stops before close rejects');
    assert.ok(kind==='database'?jobs.worker===worker:jobs.buildWorkers.has(worker));
    assert.throws(()=>new MediaLibraryIndex([],{database,watch:false}),/另一个实例/);
    assert.throws(()=>index!.qualityAdmission.acquire(),e=>(e as any).code==='quality-busy');
    const ping=once(worker,'message');worker.postMessage('ping');assert.equal((await ping)[0].n,0,'unconfirmed worker really remains able to use SQLite');
  }finally{
    await stop?.();await healthy?.terminate();if(index)(index as any).store.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
function library(failed='') {
  const calls:string[]=[],failure=Error('physical exit unconfirmed');
  const value=Object.assign(Object.create(MediaLibraryIndex.prototype),{
    stop(){calls.push('stop');if(failed==='stop')throw failure;},store:{close(){calls.push('database');}},indexJobs:{close(){calls.push('indexJobs');if(failed==='indexJobs')throw failure;}}
  }) as MediaLibraryIndex;
  const fields={taskService:'taskCenter',reexecutionService:'reexecutions',correspondenceService:'correspondence',cambiService:'cambi',xpsnrService:'xpsnr',vmafService:'vmaf',discoveryService:'preparation',rangeService:'ranges',jobService:'jobs',pairRunner:'quality'};
  const app=Object.assign(Object.create(QualityApplication.prototype),{library:value});
  for(const [name,field]of Object.entries(fields)){
    const stop=()=>{calls.push(name);if(name===failed)throw failure;};
    app[field]=['taskService','reexecutionService','pairRunner'].includes(name)?{close:stop}:{stopExecution:stop,close(){}};
  }
  value.attachQualityApplication(app);
  return {value,calls,failure};
}
test('independent closes start before a slow owner settles and aggregate original failures',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),calls:string[]=[],one=Error('one'),two=Error('two');
  const close=closeResources('failed',[['slow',()=>{calls.push('slow');return gate;}],['sync',()=>{calls.push('sync');throw one;}],['async',async()=>{calls.push('async');throw two;}]]);
  assert.deepEqual(calls,['slow','sync','async'],'signal owners begin cleanup before another signal listener can force exit');
  await new Promise(r=>setImmediate(r));release();
  await assert.rejects(close,(error:AggregateError)=>{assert.equal(error.errors.length,2);assert.equal(error.errors[0].cause,one);assert.equal(error.errors[1].cause,two);return true;});
});
test('every library shutdown failure still stops independent owners and retains shared storage',async t=>{
  for(const failed of ['stop',...owners])await t.test(failed,async()=>{
    const {value,calls,failure}=library(failed),closed=value.close();assert.equal(value.close(),closed);
    await assert.rejects(closed,(error:AggregateError)=>{const contains=(e:any):boolean=>e===failure||!!e?.cause&&contains(e.cause)||!!e?.errors?.some(contains);assert.ok(contains(error));return true;});
    assert.deepEqual(new Set(calls),new Set(['stop',...owners]));assert.equal(calls.includes('database'),false);
    await assert.rejects(value.close());assert.equal(calls.length,owners.length+1,'settled owners are not closed twice');
  });
});
test('shared database waits for external owners; success releases once and uncertainty retains it',async()=>{
  for(const failed of [false,true]){
    let resolve!:()=>void,reject!:(error:Error)=>void;const external=new Promise<void>((a,b)=>{resolve=a;reject=b;}),{value,calls}=library(),closed=value.close(external);
    await new Promise(r=>setImmediate(r));assert.equal(calls.includes('database'),false);assert.ok(calls.includes('indexJobs'));
    if(failed){reject(Error('admin analysis exit unconfirmed'));await assert.rejects(closed);assert.equal(calls.includes('database'),false);}
    else{resolve();await closed;await value.close();assert.equal(calls.filter(x=>x==='database').length,1);}
  }
});
test('admin cleanup attempts every independent owner even when one close fails',async()=>{
  for(const failed of ['measurements','analysisInstance','workspaces','annotations']){
    const calls:string[]=[];const admin=Object.assign(Object.create(AdminController.prototype),Object.fromEntries(['measurements','analysisInstance','workspaces','annotations'].map(name=>[name,{close(){calls.push(name);if(name===failed)throw Error(name);}}]))) as AdminController;
    const close=admin.close();assert.equal(admin.close(),close);await assert.rejects(close);assert.deepEqual(new Set(calls),new Set(['measurements','analysisInstance','workspaces','annotations']));
  }
});
test('admin drains settings that create analysis during shutdown before releasing shared ownership',async()=>{
  for(const failed of [false,true]){
    let release!:()=>void;const gate=new Promise<void>(r=>release=r),calls:string[]=[];
    const admin=Object.assign(Object.create(AdminController.prototype),Object.fromEntries(['measurements','workspaces','annotations'].map(name=>[name,{close(){calls.push(name);}}]))) as any;
    admin.mutation=gate.then(()=>{admin.analysisInstance={close(){calls.push('late analysis');}};if(failed)throw Error('settings failed after creating analysis');});
    let settled=false;const closed=admin.close().then(()=>{settled=true;});
    assert.throws(()=>admin.saveRoots(null),/服务正在关闭/);assert.throws(()=>admin.saveAnalysisSettings(null),/服务正在关闭/);
    await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.deepEqual(new Set(calls),new Set(['measurements','workspaces','annotations']));
    release();await closed;assert.equal(settled,true);assert.equal(calls.filter(x=>x==='late analysis').length,1);
  }
});
test('rollback keeps both the initiating error and cleanup errors, with every cleanup attempted',async()=>{
  const original=Error('listen failed'),cleanup=Error('close failed'),calls:string[]=[];
  await assert.rejects(cleanupAfterFailure(original,'startup failed',[['first',()=>{calls.push('first');throw cleanup;}],['second',()=>{calls.push('second');}]]),(error:AggregateError)=>{assert.equal(error.cause,original);assert.equal(error.errors[0],original);assert.equal(error.errors[1].errors[0].cause,cleanup);return true;});
  assert.deepEqual(calls,['first','second']);await assert.rejects(cleanupAfterFailure(original,'startup failed',[]),e=>e===original);
});
test('real service shutdown releases all databases and supports restarting the same data directory',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'vp-shutdown-'));
  try{
    const config=await loadConfig([],'production',directory,{dataDir:directory,staticDir:path.resolve('public'),allowEmptyRoots:true});Object.assign(config,{mediaRoots:[],logsDir:null,indexWatch:false,port:0});
    const service=await startService(config,false),closed=service.close();assert.equal(service.close(),closed);await closed;
    const restarted=await startService(config,false);await restarted.close();
  }finally{await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('real runtime retains the shared index after admin failure but still stops independent executors',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'vp-shutdown-failure-'));
  let service:Awaited<ReturnType<typeof startService>>|undefined;
  try{
    const config=await loadConfig([],'production',directory,{dataDir:directory,staticDir:path.resolve('public'),allowEmptyRoots:true});Object.assign(config,{mediaRoots:[],logsDir:null,indexWatch:false,port:0});
    service=await startService(config,false);
    const close=AdminController.prototype.close,original=Error('injected admin ownership failure');
    t.mock.method(AdminController.prototype,'close',async function(this:AdminController){await close.call(this);throw original;});
    await assert.rejects(service.close(),AggregateError);
    const library=service.library as any;
    assert.equal(library.indexJobs.closed,true);assert.equal(library.attachedQualityApplication.cambi.closed,true);assert.equal(library.attachedQualityApplication.vmaf.closed,true);
    assert.throws(()=>new MediaLibraryIndex([],{database:library.indexDatabase}),/另一个实例/);
    // The injected error occurs after the real admin has stopped. Only the test
    // can therefore prove it is safe to release the deliberately retained index.
    library.store.close();service=undefined;
    t.mock.restoreAll();const restarted=await startService(config,false);await restarted.close();
  }finally{t.mock.restoreAll();if(service)(service.library as any).store.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('running range drains its real child Worker before committing parent state and disposing databases',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-range-shutdown-')),database=path.join(dir,'library.sqlite');
 const library=new MediaLibraryIndex([],{database,watch:false});let worker!:Worker,online!:Promise<unknown>,stopSeen!:()=>void,release!:()=>void;
 const stopped=new Promise<void>(r=>stopSeen=r),gate=new Promise<void>(r=>release=r);
 const pairRunner=new LibraryPairRunner(library,'/unused',data=>{
   worker=new Worker('setInterval(()=>{},1000)',{eval:true,execArgv:[],workerData:data});online=once(worker,'online');
   const terminate=worker.terminate.bind(worker);worker.terminate=()=>{stopSeen();return gate.then(terminate);};return worker;
 });
 const application=new QualityApplication(library,{pairRunner});await application.ready;
 const jobs=library.qualityJobs,ranges=library.qualityRanges,actor={id:'owner',name:'Owner'},pair=jobInput().request;
 pair.budget={maxReadBytes:1024,maxInputBytes:1024};
 const parent=ranges.submit({schema:'voidplayer-quality-range',version:1,client:{id:'shutdown-test',kind:'agent'},interval:{startAu:0,endAu:0},correspondence:{mode:'explicit-au-table'},sampling:{mode:'all'},pairs:[pair],budget:{maxReadBytes:4096,maxPackets:128,maxOutputFrames:128,maxInputBytes:4096,maxElapsedMs:10000}},actor,'shutdown','key').job;
 try{
   await online;const child=ranges.get(parent.id,actor.id).samples[0].jobId;
   let settled=false;const close=library.close().then(()=>{settled=true;});await stopped;await new Promise(r=>setImmediate(r));
   assert.equal(settled,false);assert.throws(()=>new MediaLibraryIndex([],{database,watch:false}),/另一个实例/);
   assert.ok(jobs.get(child,actor.id));release();await close;assert.equal(worker.threadId,-1);
   for(const [file,table,id]of [[database+'.quality.sqlite','quality_jobs',child],[database+'.quality-ranges.sqlite','quality_ranges',parent.id]]){
     const db=openIndexDatabase(file);try{const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)!;assert.equal(table==='quality_jobs'?row.state:JSON.parse(String(row.body)).state,'interrupted');}finally{db.close();}
   }
   const reopened=new MediaLibraryIndex([],{database,watch:false});await reopened.close();
 }finally{release();await library.close();await rm(dir,{recursive:true,force:true});}
});

test('media property reads cannot assemble quality services; one explicit application owns stable instances',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-explicit-quality-')),database=path.join(dir,'library.sqlite');
 const library=new MediaLibraryIndex([],{database,watch:false});
 try{
   assert.equal(library.attachedQualityApplication,undefined);
   assert.throws(()=>library.qualityJobs,{code:'quality-storage-unavailable'});
   const db=openIndexDatabase(database);try{assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='discovery_meta'").get()!.n,0);}finally{db.close();}
   const app=new QualityApplication(library);await app.ready;
   assert.equal(library.qualityJobs,app.qualityJobs);assert.equal(library.qualityJobs,app.qualityJobs);
   assert.equal(library.qualityRanges,app.qualityRanges);assert.throws(()=>new QualityApplication(library),/already attached/);
   await app.close();await library.close();
   const reopened=new MediaLibraryIndex([],{database,watch:false});await reopened.close();
 }finally{await library.close();await rm(dir,{recursive:true,force:true});}
});
