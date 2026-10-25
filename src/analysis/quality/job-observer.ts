import type { QualityJob, QualityJobInput, QualityJobResult } from '../../../shared/analysis/quality/jobs.ts';
import type { QualityHistory, QualityTransport } from '../../services/quality-jobs.ts';
import { randomUUID } from '../../../shared/utils/uuid.ts';

export type PendingQualitySubmission={actor:string;client:string;key:string;input:QualityJobInput};
export type QualityObservation={jobs:Omit<QualityJob,'input'>[];detail:QualityJob|null;result:QualityJobResult|null;
  pending:PendingQualitySubmission|null;busy:boolean;error:unknown|null;operationError:unknown|null;history:QualityHistory|null};
/** Tab-local observation and retry state, never an execution owner. Captured actor
 * and client scopes fence every async publication, including after abort is ignored.
 * A pending request is persisted BEFORE POST; retries never reconstruct its body. */
export class QualityJobObserver {
  private life=new AbortController();private generation=0;private cursor=0;private polling=false;private listing=0;
  private submitting:Promise<void>|null=null;private selecting=0;private selected:string|null=null;
  private jobs=new Map<string,Omit<QualityJob,'input'>>();
  private value:QualityObservation={jobs:[],detail:null,result:null,pending:null,busy:false,error:null,operationError:null,history:null};
  private transport:QualityTransport;readonly actor:string;readonly client:string;
  private changed:(value:QualityObservation)=>void;private storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>;private uuid:()=>string;
  constructor(transport:QualityTransport,actor:string,client:string,changed:(value:QualityObservation)=>void,
    storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,uuid:()=>string=randomUUID){
    this.transport=transport;this.actor=actor;this.client=client;this.changed=changed;this.storage=storage;this.uuid=uuid;
    try{const raw=storage.getItem(this.storageKey);if(raw){const p=JSON.parse(raw)as PendingQualitySubmission;
      if(p.actor===actor&&p.client===client&&typeof p.key==='string'&&p.input?.schema==='voidplayer-psnr-frame-job'&&p.input.client.id===client)this.value.pending=p;}}
    catch{/* Unreadable drafts are not submitted automatically. */}
    this.emit();
  }
  private get storageKey(){return `voidplayer-quality-pending:${this.actor}:${this.client}`;}
  private emit(){this.value.jobs=[...this.jobs.values()].sort((a,b)=>b.createdAt-a.createdAt||b.sequence-a.sequence);this.changed({...this.value,pending:this.value.pending?structuredClone(this.value.pending):null});}
  private active(g:number){return !this.life.signal.aborted&&g===this.generation;}
  snapshot(){return structuredClone(this.value);}
  /** Stop all HTTP observation. No POST cancel and no removal of uncertain submission. */
  dispose(){this.generation++;this.life.abort();}
  forgetPending(){if(this.value.busy)return;try{this.storage.removeItem(this.storageKey);this.value.pending=null;this.value.error=null;this.value.operationError=null;}catch(error){this.value.operationError=error;}this.emit();}
  private accept(job:QualityJob){if(job.submitted.actorId!==this.actor)throw new Error('Quality response belongs to another actor');const previous=this.jobs.get(job.id);if(!previous||job.revision>=previous.revision)this.jobs.set(job.id,job);}
  submit(input?:QualityJobInput):Promise<void>{
    if(this.submitting)return this.submitting;
    const g=this.generation;
    this.submitting=this.send(input,g).finally(()=>{this.submitting=null;});return this.submitting;
  }
  private async send(input:QualityJobInput|undefined,g:number){
    if(this.life.signal.aborted)return;
    this.value.busy=true;this.value.operationError=null;this.emit();
    try{
      if(!this.value.pending){
        if(!input||input.client.id!==this.client)throw new Error('Quality request client scope changed');
        const pending={actor:this.actor,client:this.client,key:this.uuid(),input:structuredClone(input)};
        // A failed persistence must not send a request whose lost-response retry is unrepeatable.
        this.storage.setItem(this.storageKey,JSON.stringify(pending));this.value.pending=pending;this.emit();
      }
      const pending=this.value.pending;
      const {job}=await this.transport.submit(this.actor,structuredClone(pending.input),pending.key,this.life.signal);
      if(!this.active(g))return;
      if(job.submitted.client.id!==this.client)throw new Error('Quality submission client scope changed');
      this.accept(job);this.value.detail=job;this.selected=job.id;this.value.result=null;this.selecting++;
      this.storage.removeItem(this.storageKey);this.value.pending=null;
    }catch(error){if(this.active(g))this.value.operationError=error;}
    finally{if(this.active(g)){this.value.busy=false;this.emit();}}
  }
  resync(){this.listing++;this.cursor=0;this.jobs.clear();this.selected=null;this.selecting++;this.value.detail=null;this.value.result=null;this.value.error=null;this.emit();return this.poll();}
  async poll(){
    if(this.polling||this.life.signal.aborted)return;this.polling=true;const g=this.generation,list=this.listing;
    try{
      let pages=0,more=false;
      do{const page=await this.transport.changes(this.actor,this.cursor,this.life.signal);if(!this.active(g)||list!==this.listing)return;
        for(const job of page.entries){if(job.submitted.actorId!==this.actor)throw new Error('Quality history actor scope changed');const previous=this.jobs.get(job.id);if(!previous||job.revision>=previous.revision)this.jobs.set(job.id,job);}
        this.cursor=page.cursor;more=page.more;this.value.history=page;this.value.error=null;this.emit();
      }while(more&&++pages<20); // bounded to the service's 1000-row retained history
      if(list===this.listing&&this.selected)await this.select(this.selected);
    }catch(error){if(this.active(g)&&list===this.listing){this.value.error=error;this.emit();}}
    finally{this.polling=false;}
  }
  async select(id:string){
    const g=this.generation,selection=++this.selecting;
    if(this.selected!==id){this.value.detail=null;this.value.result=null;}this.selected=id;this.emit();
    try{
      const detail=await this.transport.get(this.actor,id,this.life.signal);
      if(!this.active(g)||selection!==this.selecting)return;
      if(detail.id!==id)throw new Error('Quality detail identity mismatch');
      this.accept(detail);this.value.detail=detail;
      if(detail.result.available){
        if(this.value.result?.jobId!==id||this.value.result.attemptId!==detail.attempt?.id){
          const result=await this.transport.result(this.actor,id,this.life.signal);
          if(!this.active(g)||selection!==this.selecting)return;
          if(result.jobId!==detail.id||result.attemptId!==detail.attempt?.id||result.submitted.actorId!==this.actor)throw new Error('Quality result identity mismatch');
          this.value.result=result;
        }
      }else this.value.result=null;
      this.value.error=null;this.emit();
    }catch(error){if(this.active(g)&&selection===this.selecting){this.value.error=error;this.emit();}}
  }
  async cancel(id:string){
    const g=this.generation;
    try{const job=await this.transport.cancel(this.actor,id,this.life.signal);if(!this.active(g))return;
      this.accept(job);if(this.selected===id){this.value.detail=job;this.value.result=null;}this.value.operationError=null;this.emit();
    }catch(error){if(this.active(g)){this.value.operationError=error;this.emit();}}
  }
}
