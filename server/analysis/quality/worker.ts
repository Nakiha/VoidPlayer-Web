import {Mp4QualityError} from '../../../shared/media/indexing/mp4-quality-index.ts';
import { parentPort,workerData } from 'node:worker_threads';
import { runQualityTask } from './task.ts';
import { FramePairError } from '../../../shared/analysis/quality/frame-pair.ts';
import { PsnrError } from '../../../shared/analysis/quality/psnr.ts';
import { AdminError } from '../../admin-error.ts';
const controller=new AbortController();
parentPort!.on('message',data=>{if(data?.type==='cancel')controller.abort(new AdminError(499,'Quality request cancelled.','cancelled'));});
try{
  const value=await runQualityTask(workerData,controller.signal,async phase=>{parentPort!.postMessage({type:'phase',phase});},contract=>parentPort!.postMessage({type:'execution-contract',contract}));controller.signal.throwIfAborted();parentPort!.postMessage({ok:true,value});
}catch(error){
  const e=error as Error&{code?:string;status?:number},known=error instanceof Mp4QualityError||error instanceof FramePairError||error instanceof PsnrError||error instanceof AdminError;
  if(!known)console.error('Quality Worker failed',error);
  parentPort!.postMessage({ok:false,error:known?{message:e.message,code:e.code,status:e.status??(e.code==='budget-exceeded'?413:['source-changed','identity-mismatch','cache-miss'].includes(e.code??'')?409:e.code==='unsupported-source'?422:400)}:
    {message:e.code==='ENOENT'?'Pinned decoder assets are unavailable.':'Quality decoder failed.',code:e.code==='ENOENT'?'decoder-unavailable':'decoder-error',status:e.code==='ENOENT'?503:500}});
}finally{parentPort!.close();}
