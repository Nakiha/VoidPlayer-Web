// Observes real witness IO inside the unchanged numeric tasks. No HTTP input or
// production workerData enables this optional, test-only callback.
import {parentPort,workerData} from 'node:worker_threads';
import {runQualityTask} from '../../server/analysis/quality/task.ts';
import {runVmafDecode} from '../../server/analysis/vmaf/decode-task.ts';
import type {ExecutionEnvironment} from '../../shared/analysis/quality/reexecution.ts';
const state=new Int32Array(workerData.witnessState),record=(value:ExecutionEnvironment)=>{Atomics.add(state,0,1);Atomics.add(state,1,value.assets.reduce((n,a)=>n+a.bytes,0));Atomics.add(state,2,value.producerBuild.bytes);};
try{const {domain,...data}=workerData;if(domain==='vmaf')await runVmafDecode(data,()=>{},undefined,record);else await runQualityTask(data,new AbortController().signal,undefined,undefined,record);parentPort!.postMessage({ok:true});}catch(error){parentPort!.postMessage({ok:false,error:String(error)});}finally{parentPort!.close();}
