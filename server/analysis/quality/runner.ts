import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import { fileStatWitness, sameFileStat } from '../../file-stat.ts';
import type { MediaLibraryIndex } from '../../library.ts';
import { AdminError } from '../../admin-error.ts';
import { pairBudget } from '../../../shared/analysis/quality/frame-pair.ts';
import type { FramePairRequest } from '../../../shared/analysis/quality/frame-pair.ts';
import type { LibraryPairBinding, LibraryPairResult } from '../../../shared/analysis/quality/library-pair.ts';
declare const VOIDPLAYER_COMPILED: boolean;
export type QualityWorkerData = {database:string;coreDir:string;request:FramePairRequest;paths:[string,string]};
type Outcome = {ok:true;value:LibraryPairResult}|{ok:false;error:unknown};

/** Transport-scoped, one-shot execution. This is NOT a durable job or lease. */
export class LibraryPairRunner {
  private active = new Set<{abort():void;done:Promise<unknown>}>();
  private closed = false;
  private stopFailed = false;
  private stopError: unknown;
  private library:MediaLibraryIndex;
  private coreDir:string;
  private createWorker:(data:QualityWorkerData)=>Worker;
  constructor(library:MediaLibraryIndex,coreDir:string,
    createWorker=(data:QualityWorkerData)=>new Worker(new URL(typeof VOIDPLAYER_COMPILED!=='undefined'&&VOIDPLAYER_COMPILED?'./analysis/quality/worker.ts':'./worker.ts',import.meta.url),
      {workerData:data,resourceLimits:{maxOldGenerationSizeMb:256}})) {this.library=library;this.coreDir=coreDir;this.createWorker=createWorker;}
  async source(id:string,version:string):Promise<LibraryPairBinding> {
    if(!/^[a-f0-9]{24}$/.test(id)||!/^[a-f0-9]{24}$/.test(version))throw new AdminError(400,'Invalid media identity.','invalid-request');
    const filePath=await this.library.resolve(id,version);
    if(!filePath)throw new AdminError(409,'Library source changed.','source-changed');
    const {binding,producer}=await this.library.indexJobs.call('psnr-source',{id,version});
    const entry=this.library.metadata(id);
    const currentStat=await stat(filePath,{bigint:true}).catch(()=>null);
    if(!entry||entry.size!==binding.size||!currentStat||!sameFileStat(producer.sourceStat,fileStatWitness(currentStat))
      ||await this.library.resolve(id,version)!==filePath)throw new AdminError(409,'Library source changed.','source-changed');
    return {binding,producer};
  }
  measure(request:FramePairRequest,signal:AbortSignal):Promise<LibraryPairResult> {
    if(this.closed)return Promise.reject(new AdminError(503,'Quality service closed.','busy'));
    let budget;
    try { budget=pairBudget(request);signal.throwIfAborted(); } catch(error) { return Promise.reject(error); }
    let release:()=>void;
    try { release=this.library.qualityAdmission.acquire(); } catch(error) { return Promise.reject(error); }
    const controller=new AbortController(), combined=AbortSignal.any([signal,controller.signal]);
    const timer=setTimeout(()=>controller.abort(new AdminError(413,'Quality execution deadline exceeded.','budget-exceeded')),budget.maxElapsedMs);
    const entry={abort:()=>controller.abort(new AdminError(499,'Quality service closed.','cancelled')),done:Promise.resolve() as Promise<unknown>};
    let stopped=true;
    const execute=async()=>{
      const targets=[request.reference,request.distorted], paths:string[]=[];
      for(const target of targets){
        combined.throwIfAborted();const current=await this.source(target.mediaId,target.mediaVersion);
        if(current.binding.indexBuildId!==target.indexBuildId || current.binding.size!==target.size)
          throw new AdminError(409,'Quality cache binding changed.','identity-mismatch');
        const filePath=await this.library.resolve(target.mediaId,target.mediaVersion);
        if(!filePath)throw new AdminError(409,'Quality source changed.','source-changed');paths.push(filePath);
      }
      combined.throwIfAborted();
      const worker=this.createWorker({database:this.library.indexDatabase,coreDir:this.coreDir,request,paths:paths as [string,string]});
      stopped=false;
      const value=await new Promise<LibraryPairResult>((resolve,reject)=>{
        let finishing=false;
        const finish=async(outcome:Outcome)=>{
          if(finishing)return;finishing=true;combined.removeEventListener('abort',abort);
          try {
            await worker.terminate();stopped=true;
            if(outcome.ok)resolve(outcome.value);else reject(outcome.error);
          } catch(error) { this.stopFailed=true;this.stopError=error;reject(error); }
          finally { if(stopped){worker.off('message',message);worker.off('error',error);worker.off('messageerror',messageerror);worker.off('exit',exit);} }
        };
        const abort=()=>void finish({ok:false,error:combined.reason});
        const error=(error:Error)=>void finish({ok:false,error:(error as Error&{code?:string}).code==='ERR_WORKER_OUT_OF_MEMORY'
          ?new AdminError(413,'Quality Worker memory budget exceeded.','budget-exceeded'):new AdminError(500,'Quality Worker failed.','decoder-error')});
        const messageerror=()=>error(new Error('Quality Worker reply could not be deserialized'));
        const exit=(code:number)=>error(new Error(`Quality Worker exited without a result (${code})`));
        const message=(data:{ok:boolean;value?:LibraryPairResult;error?:{message:string;code:string;status?:number}})=>{
          if(data?.ok===true&&data.value?.schema==='voidplayer-library-frame-pair-psnr')void finish({ok:true,value:data.value});
          else void finish({ok:false,error:new AdminError(data?.error?.status??400,data?.error?.message??'Invalid quality Worker result.',data?.error?.code??'decoder-error')});
        };
        worker.on('message',message);worker.on('error',error);worker.on('messageerror',messageerror);worker.on('exit',exit);
        combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();
      });
      combined.throwIfAborted();
      // Recheck current library roots/version and cache identity before publishing.
      for(const target of targets){const current=await this.source(target.mediaId,target.mediaVersion);combined.throwIfAborted();if(current.binding.indexBuildId!==target.indexBuildId)throw new AdminError(409,'Quality cache changed before publication.','source-changed');}
      return value;
    };
    const task=execute().finally(()=>{clearTimeout(timer);this.active.delete(entry);if(stopped)release();});
    entry.done=task;this.active.add(entry);return task;
  }
  async close(){this.closed=true;for(const entry of this.active)entry.abort();await Promise.allSettled([...this.active].map(entry=>entry.done));if(this.stopFailed)throw this.stopError;}
}
