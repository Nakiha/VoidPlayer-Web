import {parentPort,workerData} from 'node:worker_threads';
import {runVmafDecode} from './decode-task.ts';
try{const value=await runVmafDecode(workerData,(frames,total)=>parentPort!.postMessage({type:'progress',frames,total}));parentPort!.postMessage({ok:true,value});}
catch(error){parentPort!.postMessage({ok:false,error:{code:(error as {code?:string}).code??'execution-failed',message:(error as Error).message}});}
parentPort!.on('message',()=>{});
