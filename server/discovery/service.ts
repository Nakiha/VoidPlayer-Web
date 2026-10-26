import { AdminError } from '../admin-error.ts';
import type { Actor } from '../identity.ts';
import type { MediaLibraryIndex } from '../library.ts';
import { DiscoveryStore } from './store.ts';
import { DiscoveryProbeRunner } from './probe-runner.ts';
import type { ProbeValue } from './probe-runner.ts';

/** Durable ownership is independent of any submitting/observing connection. */
export class LibraryDiscoveryService {
  readonly store:DiscoveryStore;
  private probe:DiscoveryProbeRunner;
  private active?:{id:string;controller:AbortController;done:Promise<void>};
  private timer?:ReturnType<typeof setTimeout>;
  private closed=false;
  private fatal:unknown;
  private failed=false;
  private closing?:Promise<void>;
  private library:MediaLibraryIndex;
  constructor(library:MediaLibraryIndex,probe=new DiscoveryProbeRunner(library.indexDatabase,library.qualityAdmission)){this.library=library;this.store=new DiscoveryStore(library.indexDatabase);this.probe=probe;}
  private available(){if(this.closed||this.failed)throw new AdminError(503,'Library preparation service is unavailable.','preparation-unavailable');
    if(!this.library.durableQualityJobsEnabled)throw new AdminError(503,'Preparation jobs require a persistent library database.','preparation-storage-unavailable');}
  submit(value:unknown,actor:Actor,requestId:string,key:unknown){this.available();const result=this.store.submit(value,actor,requestId,key,Date.now());
    if(!result.replayed){this.pump();this.wake();}return {...result,job:this.store.get(result.job.id,actor.id)};}
  cancel(id:string,actor:string){this.available();const job=this.store.cancel(id,actor,Date.now());if(job.state==='cancelling'&&this.active?.id===id)this.active.controller.abort(new AdminError(499,'Preparation explicitly cancelled.','cancelled'));return job;}
  private wake(){if(this.timer||this.closed||this.failed||!this.store.queued())return;
    this.timer=setTimeout(()=>{this.timer=undefined;try{this.store.expire(Date.now());this.pump();this.wake();}catch(error){this.failed=true;this.fatal=error;}},250);this.timer.unref();}
  private pump(){if(this.closed||this.failed||this.active)return;this.store.expire(Date.now());const job=this.store.queued();if(!job)return;
    const active={id:job.id,controller:new AbortController(),done:Promise.resolve()};this.active=active;
    active.done=this.execute(job.id,active.controller).catch(error=>{this.failed=true;this.fatal=error;console.error('Library preparation stopped; history retained.');}).finally(()=>{if(this.active===active)this.active=undefined;this.wake();});}
  private async execute(id:string,controller:AbortController){
    const job=this.store.get(id);let admitted=false;
    const start=()=>{this.store.start(id,Date.now());admitted=true;};
    try{
      let result:unknown,probe:ProbeValue|undefined;
      if(job.input.operation==='probe'){probe=await this.probe.run(job.input.source,controller.signal,start);result=probe.probe;}
      else result=await this.library.quality.buildSource(job.input.source.id,job.input.source.version,controller.signal,{admitted:start,phase:()=>{}});
      this.store.finish(id,this.closed?'interrupted':'completed',Date.now(),this.closed?{code:'service-shutdown',message:'Service stopped; no automatic retry.'}:null,result,probe);
    }catch(error){
      if(this.probe.stopUncertain||this.library.quality.stopUncertain)throw error;
      if(!admitted&&error instanceof AdminError&&error.code==='quality-busy')return;
      const known=error instanceof Error&&typeof (error as {code?:unknown}).code==='string';
      this.store.finish(id,this.closed?'interrupted':'failed',Date.now(),{code:this.closed?'service-shutdown':known?String((error as {code?:string}).code):'preparation-failed',
        message:this.closed?'Service stopped; no automatic retry.':'Preparation failed; inspect its code and source version before submitting a new explicit operation.'});
    }
  }
  close(){return this.closing??=this.stop();}
  private async stop(){this.closed=true;clearTimeout(this.timer);this.active?.controller.abort(new AdminError(499,'Library preparation service stopping.','service-shutdown'));
    await this.active?.done;await this.probe.close();if(this.failed)throw this.fatal;
    for(const job of this.store.unfinished())this.store.finish(job.id,'interrupted',Date.now(),{code:'service-shutdown',message:'Service stopped; no automatic retry.'});
    this.store.close();}
}
