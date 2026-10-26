import {parentPort,workerData} from 'node:worker_threads';
import {verifyVmafComponent} from './component.ts';
const control=new Int32Array(workerData.control);
try{Atomics.add(control,1,1);let value;
 try{if(Atomics.load(control,0))throw Error('cancelled');value=await verifyVmafComponent(workerData.config,workerData.model);if(Atomics.load(control,0))throw Error('cancelled');}
 finally{Atomics.sub(control,1,1);Atomics.notify(control,1);}
 parentPort!.postMessage({ok:true,value});
}catch(error){parentPort!.postMessage({ok:false,error:{code:(error as {code?:string}).code??'component-unavailable',message:(error as Error).message}});}
parentPort!.on('message',()=>{});
