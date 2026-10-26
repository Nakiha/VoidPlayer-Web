import { parentPort, workerData } from 'node:worker_threads';
import { runProbeTask } from './probe-task.ts';
try{
  parentPort!.postMessage({ok:true,value:await runProbeTask(workerData)});
}catch(error){
  const code=(error as {code?:string})?.code;
  const message=(error as Error)?.message??'';
  const reason=code==='source-changed'||['ENOENT','ESTALE','ENOTDIR','EISDIR','EACCES'].includes(code??'')||message==='source-changed'?'source-changed'
    :['probe-budget-exceeded','probe-stream-budget-exceeded','probe-result-budget-exceeded','probe-read-call-budget-exceeded'].includes(message)?'probe-budget-exceeded'
    :['EIO','ENXIO'].includes(code??'')?'source-unavailable':message==='cancelled'?'cancelled':'unsupported-or-invalid-metadata';
  parentPort!.postMessage({ok:false,code:reason});
}finally{
  parentPort!.close();
}
