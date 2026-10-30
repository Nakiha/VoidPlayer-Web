import { Worker } from 'node:worker_threads';
import { AdminError } from '../admin-error.ts';
import type { QualityAdmission } from '../quality-admission.ts';
import type { FileStatWitness } from '../file-stat.ts';
import { DISCOVERY_LIMITS } from '../../shared/media/discovery.ts';
import type { DiscoverySource, MediaProbe } from '../../shared/media/discovery.ts';
declare const VOIDPLAYER_COMPILED:boolean;
export type ProbeValue={probe:MediaProbe;witness:FileStatWitness};
export type ProbeWorkerData={database:string;source:DiscoverySource;control:SharedArrayBuffer};
/** All preflights and bounded reads stay in the owned Worker. Async file IO must
 * drain and explicitly close before termination, including on Bun. Parser CPU
 * work holds no file handle, so it can be killed without a descriptor leak. */
export class DiscoveryProbeRunner {
  private active=new Set<{abort():void;done:Promise<unknown>}>();
  private closed=false;
  stopUncertain=false;
  private database:string;
  private admission:QualityAdmission;
  private createWorker:(data:ProbeWorkerData)=>Worker;
  private timers:{set(callback:()=>void,ms:number):ReturnType<typeof setTimeout>;clear(timer:ReturnType<typeof setTimeout>):void};
  constructor(database:string,admission:QualityAdmission,
    createWorker=(data:ProbeWorkerData)=>new Worker(new URL(typeof VOIDPLAYER_COMPILED!=='undefined'&&VOIDPLAYER_COMPILED?'./discovery/probe-worker.ts':'./probe-worker.ts',import.meta.url),
      {workerData:data,resourceLimits:{maxOldGenerationSizeMb:DISCOVERY_LIMITS.workerHeapMiB},trackUnmanagedFds:true}),
    timers={set:(callback:()=>void,ms:number)=>setTimeout(callback,ms),clear:(timer:ReturnType<typeof setTimeout>)=>clearTimeout(timer)}){
    this.database=database;this.admission=admission;this.createWorker=createWorker;this.timers=timers;
  }
  run(source:DiscoverySource,signal:AbortSignal,admitted:()=>void):Promise<ProbeValue>{
    if(this.closed||this.stopUncertain)return Promise.reject(new AdminError(503,'Metadata probe is unavailable.','preparation-unavailable'));
    let release:()=>void;try{signal.throwIfAborted();release=this.admission.acquire({executor:'preparation',memoryBytes:256*1024**2,readBytes:4*1024**2,threads:1});}catch(error){return Promise.reject(error);}
    try{admitted();signal.throwIfAborted();}catch(error){release();return Promise.reject(error);}
    const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);
    const control=new Int32Array(new SharedArrayBuffer(8));
    const timer=this.timers.set(()=>controller.abort(new AdminError(413,'Metadata preparation execution deadline exceeded.','probe-budget-exceeded')),DISCOVERY_LIMITS.elapsedMs);
    let stopped=true;
    const entry={abort:()=>controller.abort(new AdminError(499,'Metadata service stopped.','service-shutdown')),done:Promise.resolve() as Promise<unknown>};
    const response=new Promise<ProbeValue>((resolve,reject)=>{
      let worker:Worker;try{worker=this.createWorker({database:this.database,source,control:control.buffer as SharedArrayBuffer});stopped=false;}catch(error){reject(error);return;}
      let finishing=false,exited=false;
      const finish=async(outcome:{ok:true;value:ProbeValue}|{ok:false;error:unknown})=>{
        if(finishing)return;finishing=true;combined.removeEventListener('abort',abort);Atomics.store(control,0,1);
        if(combined.aborted){try{worker.postMessage({type:'cancel'});}catch{/* Stop still owns the resource fence. */}}
        try{
          for(;;){const io=Atomics.load(control,1);if(io===0)break;if(exited)throw Error('Metadata Worker exited with unsettled file IO');
            const wait=(Atomics as typeof Atomics&{waitAsync(array:Int32Array,index:number,value:number):{value:Promise<string>|string}}).waitAsync(control,1,io);await wait.value;}
          await worker.terminate();stopped=true;if(outcome.ok){if(combined.aborted)reject(combined.reason);else resolve(outcome.value);}else reject(outcome.error);}
        catch(error){this.stopUncertain=true;reject(error);}
      };
      const abort=()=>void finish({ok:false,error:combined.reason});
      worker.on('message',(message:{ok:boolean;value?:ProbeValue;code?:string})=>{
        const value=message?.value;
        if(message?.ok&&value?.probe?.schema==='voidplayer-media-probe'&&value.probe.source.id===source.id&&value.probe.source.version===source.version
          &&Buffer.byteLength(JSON.stringify(value.probe))<=DISCOVERY_LIMITS.probeResultBytes)void finish({ok:true,value});
        else void finish({ok:false,error:new AdminError(message?.code==='source-changed'?409:message?.code?.includes('budget')?413:422,'Metadata preparation did not establish a supported bounded result.',message?.code??'probe-failed')});
      });
      worker.on('error',()=>void finish({ok:false,error:new AdminError(500,'Metadata Worker failed.','probe-worker-failed')}));
      worker.on('messageerror',()=>void finish({ok:false,error:new AdminError(500,'Metadata Worker reply was invalid.','probe-worker-failed')}));
      worker.on('exit',()=>{exited=true;Atomics.notify(control,1);void finish({ok:false,error:new AdminError(500,'Metadata Worker exited before a result.','probe-worker-failed')});});
      combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();
    });
    const done=response.finally(()=>{this.timers.clear(timer);this.active.delete(entry);if(stopped)release();});entry.done=done;this.active.add(entry);return done;
  }
  async close(){this.closed=true;for(const entry of this.active)entry.abort();await Promise.allSettled([...this.active].map(e=>e.done));if(this.stopUncertain)throw Error('Metadata Worker stop is uncertain');}
}
