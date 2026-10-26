/** Test-only gate around the real service task, never accepted from HTTP. */
import { parentPort,workerData } from 'node:worker_threads';
import { runQualityTask } from '../../server/analysis/quality/task.ts';
const controller=new AbortController();
parentPort!.on('message',data=>{if(data?.type==='cancel')controller.abort(new Error('cancelled'));});
try{
 const value=await runQualityTask(workerData,controller.signal,async phase=>{
  parentPort!.postMessage({type:'phase',phase});
  if(((workerData.mode==='measure'&&phase==='decode')||(workerData.mode==='correspondence-plan'&&phase==='resolve'))&&workerData.gate){
   const gate=new Int32Array(workerData.gate);Atomics.store(gate,1,1);Atomics.notify(gate,1);
   while(Atomics.load(gate,0)===0)Atomics.wait(gate,0,0);
  }
 });
 parentPort!.postMessage({ok:true,value});
}catch(error){const e=error as Error&{code?:string;status?:number};parentPort!.postMessage({ok:false,error:{message:e.message,code:e.code??'execution-failed',status:e.status??400}});}
finally{parentPort!.close();}
