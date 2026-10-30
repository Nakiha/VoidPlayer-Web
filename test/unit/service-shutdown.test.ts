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

const owners=['taskService','reexecutionService','correspondenceService','cambiService','xpsnrService','vmafService','discoveryService','rangeService','jobService','pairRunner','indexJobs'];
function library(failed='') {
  const calls:string[]=[],failure=Error('physical exit unconfirmed');
  const value=Object.assign(Object.create(MediaLibraryIndex.prototype),{
    stop(){calls.push('stop');if(failed==='stop')throw failure;},
    store:{close(){calls.push('database');}},
    ...Object.fromEntries(owners.map(name=>[name,{close(){calls.push(name);if(name===failed)throw failure;}}])),
  }) as MediaLibraryIndex;
  return {value,calls,failure};
}
test('independent closes start before a slow owner settles and aggregate original failures',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),calls:string[]=[],one=Error('one'),two=Error('two');
  const close=closeResources('failed',[['slow',()=>{calls.push('slow');return gate;}],['sync',()=>{calls.push('sync');throw one;}],['async',async()=>{calls.push('async');throw two;}]]);
  await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['slow','sync','async']);release();
  await assert.rejects(close,(error:AggregateError)=>{assert.equal(error.errors.length,2);assert.equal(error.errors[0].cause,one);assert.equal(error.errors[1].cause,two);return true;});
});
test('every library shutdown failure still stops independent owners and retains shared storage',async t=>{
  for(const failed of ['stop',...owners])await t.test(failed,async()=>{
    const {value,calls,failure}=library(failed),closed=value.close();assert.equal(value.close(),closed);
    await assert.rejects(closed,(error:AggregateError)=>{assert.ok(error.errors.some(e=>e.cause===failure));return true;});
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
    assert.equal(library.indexJobs.closed,true);assert.equal(library.cambiService.closed,true);assert.equal(library.vmafService.closed,true);
    assert.throws(()=>new MediaLibraryIndex([],{database:library.indexDatabase}),/另一个实例/);
    // The injected error occurs after the real admin has stopped. Only the test
    // can therefore prove it is safe to release the deliberately retained index.
    library.store.close();service=undefined;
    t.mock.restoreAll();const restarted=await startService(config,false);await restarted.close();
  }finally{t.mock.restoreAll();if(service)(service.library as any).store.close();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
