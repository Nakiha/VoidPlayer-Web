import { Worker } from 'node:worker_threads';
import type { MediaLibraryIndex } from '../../library.ts';
import { AdminError } from '../../admin-error.ts';
import { PAIR_LIMITS, pairBudget } from '../../../shared/analysis/quality/frame-pair.ts';
import type { FramePairRequest } from '../../../shared/analysis/quality/frame-pair.ts';
import type { LibraryPairBinding, LibraryPairResult } from '../../../shared/analysis/quality/library-pair.ts';
import { qualityFrameQuery } from '../../../shared/analysis/quality/selection.ts';
import type { QualityFramePage,QualityFrameQuery } from '../../../shared/analysis/quality/selection.ts';
import type {ReferenceRelation,CorrespondenceInput,CorrespondenceResult} from '../../../shared/analysis/quality/correspondence.ts';
import type { QualityTask } from './task.ts';
import {QUALITY_SOURCE_BUILD_LIMITS} from '../../../shared/analysis/quality/source-build.ts';
declare const VOIDPLAYER_COMPILED: boolean;
export type QualityWorkerData = QualityTask & {database:string;coreDir:string;control:SharedArrayBuffer};
type WorkerValue = LibraryPairBinding | LibraryPairResult | QualityFramePage | CorrespondenceResult;
type Outcome<T> = {ok:true;value:T}|{ok:false;error:unknown};
type QualityTimers={set(callback:()=>void,ms:number):ReturnType<typeof setTimeout>;clear(timer:ReturnType<typeof setTimeout>):void};
export type QualityRunHooks = { admitted(): void; phase(phase: 'source' | 'resolve' | 'decode' | 'publish'): void };

/** All source/resolve/final checks belong to this same killable Worker.
 * The main thread never awaits an unowned filesystem or database preflight. */
export class LibraryPairRunner {
  private active=new Set<{abort():void;done:Promise<unknown>}>();
  private closed=false;
  private stopFailed=false;
  private stopError:unknown;
  private library:MediaLibraryIndex;
  private coreDir:string;
  private createWorker:(data:QualityWorkerData)=>Worker;
  private timers:QualityTimers;
  get stopUncertain(){return this.stopFailed;}
  constructor(library:MediaLibraryIndex,coreDir:string,
    createWorker=(data:QualityWorkerData)=>new Worker(new URL(typeof VOIDPLAYER_COMPILED!=='undefined'&&VOIDPLAYER_COMPILED?'./analysis/quality/worker.ts':'./worker.ts',import.meta.url),
      {workerData:data,resourceLimits:{maxOldGenerationSizeMb:256}}),timers:QualityTimers={set:(callback,ms)=>setTimeout(callback,ms),clear:timer=>clearTimeout(timer)}){this.library=library;this.coreDir=coreDir;this.createWorker=createWorker;this.timers=timers;}
  source(id:string,version:string,signal=new AbortController().signal):Promise<LibraryPairBinding>{
    if(!/^[a-f0-9]{24}$/.test(id)||!/^[a-f0-9]{24}$/.test(version))return Promise.reject(new AdminError(400,'Invalid media identity.','invalid-request'));
    return this.run({mode:'source',id,version},PAIR_LIMITS.maxElapsedMs,signal);
  }
  frames(id:string,version:string,query:QualityFrameQuery,signal:AbortSignal):Promise<QualityFramePage>{
    try{qualityFrameQuery(query);if(!/^[a-f0-9]{24}$/.test(id)||!/^[a-f0-9]{24}$/.test(version))throw new AdminError(400,'Invalid media identity.','invalid-request');}
    catch(error){return Promise.reject(error);}
    return this.run({mode:'frames',id,version,query},PAIR_LIMITS.maxElapsedMs,signal);
  }
  buildSource(id:string,version:string,signal:AbortSignal,hooks?:QualityRunHooks):Promise<LibraryPairBinding>{
    if(!/^[a-f0-9]{24}$/.test(id)||!/^[a-f0-9]{24}$/.test(version))return Promise.reject(new AdminError(400,'Invalid media identity.','invalid-request'));
    return this.run({mode:'build-source',id,version},QUALITY_SOURCE_BUILD_LIMITS.maxElapsedMs,signal,hooks);
  }
  measure(request:FramePairRequest,signal:AbortSignal,hooks?:QualityRunHooks):Promise<LibraryPairResult>{
    let budget;try{budget=pairBudget(request);}catch(error){return Promise.reject(error);}
    return this.run({mode:'measure',request},budget.maxElapsedMs,signal,hooks);
  }
  planCorrespondence(relation:ReferenceRelation,request:CorrespondenceInput,signal:AbortSignal,hooks:QualityRunHooks):Promise<CorrespondenceResult>{
    return this.run({mode:'correspondence-plan',relation,request},request.planningBudget.maxElapsedMs,signal,hooks);
  }
  private run<T extends WorkerValue>(task:QualityTask,elapsedMs:number,signal:AbortSignal,hooks?:QualityRunHooks):Promise<T>{
    if(this.closed)return Promise.reject(new AdminError(503,'Quality service closed.','busy'));
    let release:()=>void;
    try{signal.throwIfAborted();release=this.library.qualityAdmission.acquire();}catch(error){return Promise.reject(error);}
    // Persist the attempt synchronously after admission and before any Worker can
    // execute. A failed commit starts no work and immediately returns the permit.
    try{hooks?.admitted();signal.throwIfAborted();}catch(error){release();return Promise.reject(error);}
    const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
    const control=new Int32Array(new SharedArrayBuffer(8));
    const timer=this.timers.set(()=>controller.abort(new AdminError(413,'Quality execution deadline exceeded.','budget-exceeded')),elapsedMs);
    const entry={abort:()=>controller.abort(new AdminError(499,'Quality service closed.','cancelled')),done:Promise.resolve() as Promise<unknown>};
    let stopped=true;
    const response=new Promise<T>((resolve,reject)=>{
      let worker:Worker;
      try{worker=this.createWorker({...task,database:this.library.indexDatabase,coreDir:this.coreDir,control:control.buffer as SharedArrayBuffer});stopped=false;}
      catch(error){reject(error);return;}
      let finishing=false,exited=false;
      const finish=async(outcome:Outcome<T>)=>{
        if(finishing)return;finishing=true;combined.removeEventListener('abort',abort);
        Atomics.store(control,0,1); // Revoke new source IO before checking drain.
        if(combined.aborted){try{worker.postMessage({type:'cancel'});}catch{/* physical termination still owns cleanup */}}
        try{
          for(;;){
            const activeIO=Atomics.load(control,1);if(activeIO===0)break;
            if(exited)throw new Error('Quality Worker exited with unsettled source IO');
            const wait=(Atomics as typeof Atomics&{waitAsync(array:Int32Array,index:number,value:number):{value:Promise<string>|string}}).waitAsync(control,1,activeIO);
            await wait.value;
          }
          await worker.terminate();stopped=true;
          // A deadline reached while stopping also forbids a successful response.
          if(outcome.ok){if(combined.aborted)reject(combined.reason);else resolve(outcome.value);}else reject(outcome.error);
        }catch(error){this.stopFailed=true;this.stopError=error;reject(error);}
        finally{if(stopped){worker.off('message',message);worker.off('error',error);worker.off('messageerror',messageerror);worker.off('exit',exit);}}
      };
      const abort=()=>void finish({ok:false,error:combined.reason});
      const error=(error:Error)=>void finish({ok:false,error:(error as Error&{code?:string}).code==='ERR_WORKER_OUT_OF_MEMORY'
        ?new AdminError(413,'Quality Worker memory budget exceeded.','budget-exceeded'):new AdminError(500,'Quality Worker failed.','decoder-error')});
      const messageerror=()=>error(new Error('Quality Worker reply could not be deserialized'));
      const exit=()=>{exited=true;Atomics.notify(control,1);error(new Error('Quality Worker exited without a result'));};
      const message=(data:{type?:string;phase?:string;ok:boolean;value?:WorkerValue;error?:{message:string;code:string;status?:number}})=>{
        if(finishing)return;
        if(data?.type==='phase'){
          if(['source','resolve','decode','publish'].includes(data.phase??'')){
            try{hooks?.phase(data.phase as Parameters<QualityRunHooks['phase']>[0]);}catch(error){void finish({ok:false,error});}
          }
          return;
        }
        const value=data?.value;
        const valid=task.mode==='source'||task.mode==='build-source'?value&&'binding' in value&&value.binding.mediaId===task.id&&value.binding.mediaVersion===task.version
          :task.mode==='frames'?value&&'schema'in value&&value.schema==='voidplayer-psnr-frame-candidates'&&value.source.binding.mediaId===task.id&&value.source.binding.mediaVersion===task.version
          :task.mode==='correspondence-plan'?value&&'schema'in value&&value.schema==='voidplayer-quality-correspondence-result'&&value.relation.id===task.relation.id
          :value&&'schema' in value&&value.schema==='voidplayer-library-frame-pair-psnr';
        if(data?.ok===true&&valid)void finish({ok:true,value:value as T});
        else void finish({ok:false,error:new AdminError(data?.error?.status??400,data?.error?.message??'Invalid quality Worker result.',data?.error?.code??'decoder-error')});
      };
      worker.on('message',message);worker.on('error',error);worker.on('messageerror',messageerror);worker.on('exit',exit);
      // There is no await before this listener: even a constructor-time abort is
      // observed against an already-owned Worker and cannot escape termination.
      combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();
    });
    const done=response.finally(()=>{this.timers.clear(timer);this.active.delete(entry);if(stopped)release();});
    entry.done=done;this.active.add(entry);return done;
  }
  async close(){this.closed=true;for(const entry of this.active)entry.abort();await Promise.allSettled([...this.active].map(entry=>entry.done));if(this.stopFailed)throw this.stopError;}
}
