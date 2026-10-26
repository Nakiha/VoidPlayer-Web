import { parentPort,workerData } from 'node:worker_threads';
import { runQualityTask } from '../../server/analysis/quality/task.ts';
import { AdminError } from '../../server/admin-error.ts';
const state=new Int32Array(workerData.phaseState),controller=new AbortController();
let resume:(()=>void)|undefined;
let occurrence=0;
parentPort!.on('message',data=>{
  if(data?.type==='cancel'){controller.abort(new AdminError(499,'Quality request cancelled.','cancelled'));Atomics.store(state,2,1);Atomics.notify(state,2);}
  if(data?.type==='resume')resume?.();
});
try{
  const value=await runQualityTask(workerData,controller.signal,async phase=>{
    if(phase!==workerData.hangPhase)return;
    if(++occurrence!==(workerData.hangOccurrence??1))return;
    Atomics.store(state,0,1);Atomics.notify(state,0);
    await new Promise<void>(resolve=>resume=resolve);
    Atomics.store(state,4,1);Atomics.notify(state,4);
  });
  controller.signal.throwIfAborted();Atomics.store(state,3,1);parentPort!.postMessage({ok:true,value});
}catch(error){const e=error as Error&{code?:string;status?:number};parentPort!.postMessage({ok:false,error:{message:e.message,code:e.code,status:e.status??400}});}
finally{parentPort!.close();}
