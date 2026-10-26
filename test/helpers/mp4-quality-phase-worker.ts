/** Test-only instrumentation of the actual MP4 descriptor and runner IO fence. */
import {parentPort,workerData} from 'node:worker_threads';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const state=new Int32Array(workerData.phaseState),controller=new AbortController();
const open=fs.open;
fs.open=async function(...args:Parameters<typeof fs.open>){
 const handle=await open.apply(fs,args);
 if(String(args[0]).endsWith('.mp4')){
  Atomics.store(state,1,handle.fd);Atomics.add(state,5,1);
  const close=handle.close.bind(handle);handle.close=async()=>{await close();Atomics.add(state,6,1);};
 }
 return handle;
} as typeof fs.open;
syncBuiltinESMExports();
const {runQualityTask}=await import('../../server/analysis/quality/task.ts');
let resume:(()=>void)|undefined,occurrence=0;
parentPort!.on('message',data=>{if(data?.type==='resume')resume?.();if(data?.type==='cancel'){controller.abort(new Error('Test cancellation'));resume?.();}});
try{
 const value=await runQualityTask(workerData,controller.signal,async phase=>{
  parentPort!.postMessage({type:'phase',phase});
  if(phase==='resolve'&&++occurrence===2){Atomics.store(state,0,1);await new Promise<void>(r=>resume=r);}
 });parentPort!.postMessage({ok:true,value});
}catch(e){const error=e as Error&{code?:string};parentPort!.postMessage({ok:false,error:{code:error.code,message:error.message,status:409}});}
// Deliberately retain the test port after IO drains: terminate must physically
// stop this Worker before the runner can release its shared permit.
