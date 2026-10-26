import { parentPort,workerData } from 'node:worker_threads';
import { runProbeTask } from '../../server/discovery/probe-task.ts';
const state=new Int32Array(workerData.phaseState);
try{const value=await runProbeTask(workerData,async(phase,fd)=>{
  if(phase!==workerData.hangPhase)return;
  Atomics.store(state,1,fd);Atomics.store(state,0,1);Atomics.notify(state,0);
  if(phase==='parse')for(;;){ /* Deliberate CPU-bound parser-stage fault. No open file or database. */ }
  await new Promise<void>(resolve=>parentPort!.once('message',()=>resolve()));
});parentPort!.postMessage({ok:true,value});}
catch{parentPort!.postMessage({ok:false,code:'cancelled'});}
finally{parentPort!.on('message',()=>{});}
