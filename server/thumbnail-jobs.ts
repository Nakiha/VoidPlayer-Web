import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { AdminError } from './admin-error.ts';
import type { CoverImage, CoverInput } from './thumbnail-decode.ts';
import type { MediaThumbnailStore } from './media-thumbnail-store.ts';
import { THUMB_RECIPE_VERSION } from '../shared/thumbnails/contract.ts';

function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(error:Error)=>void;
  const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});
  return {promise,resolve,reject};
}

type CoverJob = {
  id:string; version:string; epoch:number; key:string; input:CoverInput;
  result:ReturnType<typeof deferred<CoverImage>>; readers:number;
};
type Slot = {worker:Worker; job?:CoverJob; timer?:NodeJS.Timeout; stopping:boolean; exited:Promise<void>; stopped?:Promise<unknown>};

/** Workers only read the pinned file. The owner commits once while the epoch is current. */
export class ThumbnailJobs {
  private waiting:CoverJob[]=[];
  private jobs=new Map<string,CoverJob>();
  private slots=new Set<Slot>();
  private failures=new Map<string,number>();
  private closed=false;
  private coreDir:string;
  private store:MediaThumbnailStore;
  readonly concurrency=Math.min(2,availableParallelism());
  constructor(coreDir:string, store:MediaThumbnailStore) {this.coreDir=coreDir;this.store=store;}

  async generate(id:string, version:string, epoch:number, input:CoverInput, signal:AbortSignal) {
    signal.throwIfAborted();
    if (this.closed) throw new AdminError(503,'服务正在关闭。');
    const key=[id,version,epoch].join('|');
    if ((this.failures.get(key)??0)>Date.now()) throw new AdminError(422,'暂时无法生成此视频的封面。');
    let job=this.jobs.get(key);
    if (!job) {
      if (this.waiting.length>=48) throw new AdminError(503,'封面队列已满。');
      job={id,version,epoch,key,input,result:deferred<CoverImage>(),readers:0};
      this.jobs.set(key,job);this.waiting.push(job);
    }
    const pending=job;
    pending.readers++;
    const leave=()=>{
      if (--pending.readers!==0) return;
      const index=this.waiting.indexOf(pending);
      if (index>=0) {
        this.waiting.splice(index,1);
        this.finish(pending,new AdminError(499,'封面请求已取消。'));
      }
    };
    signal.addEventListener('abort',leave,{once:true});
    try {this.dispatch();return await pending.result.promise;}
    finally {signal.removeEventListener('abort',leave);if (!signal.aborted) leave();}
  }

  private finish(job:CoverJob, error?:Error, image?:CoverImage) {
    this.jobs.delete(job.key);
    if (error) job.result.reject(error);else job.result.resolve(image!);
  }

  private dispatch() {
    while (this.waiting.length && !this.closed) {
      let slot=[...this.slots].find(item=>!item.job&&!item.stopping);
      if (!slot && this.slots.size>=this.concurrency) return;
      const job=this.waiting.shift()!;
      try {
        slot??=this.createSlot();
        clearTimeout(slot.timer);
        slot.job=job;
        slot.timer=setTimeout(()=>this.stopSlot(slot!,new AdminError(504,'封面生成超时。')),10000);
        slot.worker.postMessage(job.input);
      } catch (error) {
        if (slot) this.stopSlot(slot,error as Error);else this.finish(job,error as Error);
      }
    }
  }

  private rememberFailure(key:string) {
    this.failures.delete(key);this.failures.set(key,Date.now()+60000);
    if (this.failures.size>512) this.failures.delete(this.failures.keys().next().value!);
  }

  private createSlot() {
    const worker=new Worker(new URL('./thumbnail-worker.ts',import.meta.url),{workerData:{coreDir:this.coreDir},
      resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:8}});
    const exit=deferred<void>();
    const slot:Slot={worker,stopping:false,exited:exit.promise};
    this.slots.add(slot);
    worker.on('message',({image,error}:{image?:CoverImage;error?:string})=>{
      const job=slot.job;
      if (!job || slot.stopping) return;
      clearTimeout(slot.timer);slot.job=undefined;
      try {
        if (!image) {
          this.rememberFailure(job.key);
          throw new AdminError(422,error??'无法解码首帧。');
        }
        this.store.put(job.id,job.version,THUMB_RECIPE_VERSION,job.epoch,image.bytes,image);
        this.finish(job,undefined,image);
      } catch (failure) {this.finish(job,failure as Error);}
      slot.timer=setTimeout(()=>this.stopSlot(slot),3000);
      this.dispatch();
    });
    worker.on('error',error=>this.stopSlot(slot,error as Error));
    worker.once('exit',()=>{
      clearTimeout(slot.timer);
      if (slot.job) this.finish(slot.job,new AdminError(503,'封面生成进程已退出。'));
      this.slots.delete(slot);exit.resolve();this.dispatch();
    });
    return slot;
  }

  private stopSlot(slot:Slot,error?:Error) {
    if (slot.stopping) return;
    slot.stopping=true;clearTimeout(slot.timer);
    if (slot.job) {
      if (!this.closed) this.rememberFailure(slot.job.key);
      this.finish(slot.job,error??new AdminError(503,'服务正在关闭。'));slot.job=undefined;
    }
    slot.stopped=Promise.resolve().then(()=>slot.worker.terminate());
    // Keep an unconfirmed executor owned. Shutdown must surface the stop failure.
    void slot.stopped.catch(()=>{
      this.closed=true;
      for (const job of this.waiting.splice(0)) this.finish(job,new AdminError(503,'封面生成进程未能退出。'));
    });
  }

  async close() {
    this.closed=true;
    for (const job of this.waiting.splice(0)) this.finish(job,new AdminError(503,'服务正在关闭。'));
    for (const slot of this.slots) this.stopSlot(slot);
    await Promise.all([...this.slots].map(async slot=>{await slot.stopped;await slot.exited;}));
  }
}
