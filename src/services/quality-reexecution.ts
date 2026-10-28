import {QualityClient} from './quality-jobs.ts';
import {ApiError} from './api-error.ts';
import {randomUUID} from '../../shared/utils/uuid.ts';
import {canonicalJson} from '../../shared/analysis/quality/correspondence.ts';
import {reexecutionPath,reexecutionRequest,REEXECUTION_LIMITS} from '../../shared/analysis/quality/reexecution.ts';
import type {ReexecutionKind,ReexecutionPlan,ReexecutionRequest} from '../../shared/analysis/quality/reexecution.ts';

export type FrozenReexecution={schema:'voidplayer-pending-reexecution';version:1;origin:string;actor:string;kind:ReexecutionKind;jobId:string;key:string;body:ReexecutionRequest;bodyJson:string;createdAt:number;rejected?:{status:number;code?:string}};
type StoragePort=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
export type ReexecutionAcknowledgement={job:{id:string;state:string;retryOf:{retryOf:string;rootJobId:string;generation:number;planDigest:string}};replayed:boolean;receipt:{actorId:string;parentId:string;jobId:string;key:string;request:ReexecutionRequest;lineage:unknown}};
/** At most one unresolved request per actor/kind and sixteen per tab. A lost
 * reply never frees that slot, changes the key or enables a new computation. */
export class QualityReexecutionClient{
  private storage:StoragePort;private api:Pick<QualityClient,'request'>;private origin:string;private uuid:()=>string;
  constructor(storage:StoragePort,origin:string,api:Pick<QualityClient,'request'>=new QualityClient(),uuid=randomUUID){this.storage=storage;this.origin=origin;this.api=api;this.uuid=uuid;}
  private key(actor:string,kind:ReexecutionKind){return 'voidplayer-quality-reexecution:'+encodeURIComponent(this.origin)+':'+encodeURIComponent(actor)+':'+kind;}
  pending(actor:string,kind:ReexecutionKind):FrozenReexecution|null{
    const raw=this.storage.getItem(this.key(actor,kind));if(!raw)return null;
    if(new TextEncoder().encode(raw).byteLength>REEXECUTION_LIMITS.requestBytes+4096)throw Error('Stored reexecution exceeds its client budget');
    const p=JSON.parse(raw) as FrozenReexecution;
    if(p.schema!=='voidplayer-pending-reexecution'||p.version!==1||p.origin!==this.origin||p.actor!==actor||p.kind!==kind||typeof p.jobId!=='string'||!(kind==='vmaf'?/^vmaf-[a-f0-9-]{36}$/:/^[a-f0-9-]{36}$/).test(p.jobId)||typeof p.key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(p.key)||JSON.stringify(p.body)!==p.bodyJson)throw Error('Stored reexecution identity changed');
    reexecutionRequest(p.body);return p;
  }
  freeze(actor:string,kind:ReexecutionKind,id:string,plan:ReexecutionPlan){
    const prior=this.pending(actor,kind);if(prior){if(prior.jobId!==id)throw Error('Resolve the existing unknown reexecution for this actor and task kind first');return prior;}
    if(!plan.eligible||plan.jobId!==id||plan.kind!==kind||!plan.digest)throw Error('An eligible exact full recomputation plan is required');
    let count=0;for(let i=0;i<this.storage.length;i++)if(this.storage.key(i)?.startsWith('voidplayer-quality-reexecution:'))count++;if(count>=16)throw Error('Pending reexecution history is full; resolve unknown requests before creating more');
    const body:ReexecutionRequest={schema:'voidplayer-quality-reexecution',version:1,reason:plan.reason,planDigest:plan.digest,confirm:structuredClone(plan.cost)},bodyJson=JSON.stringify(body);
    if(new TextEncoder().encode(bodyJson).byteLength>REEXECUTION_LIMITS.requestBytes)throw Error('Reexecution request exceeds its byte budget');
    const p:FrozenReexecution={schema:'voidplayer-pending-reexecution',version:1,origin:this.origin,actor,kind,jobId:id,key:this.uuid(),body,bodyJson,createdAt:Date.now()};
    this.storage.setItem(this.key(actor,kind),JSON.stringify(p));return p;
  }
  async send(p:FrozenReexecution,currentActor:string,signal:AbortSignal){
    if(currentActor!==p.actor)throw Error('Actor changed; the frozen request was not sent');
    const stored=this.pending(p.actor,p.kind);if(!stored||stored.key!==p.key||stored.bodyJson!==p.bodyJson)throw Error('Original reexecution receipt changed; the request was not sent');
    let value:ReexecutionAcknowledgement;
    try{
      value=await this.api.request<ReexecutionAcknowledgement>(p.actor,reexecutionPath(p.kind,p.jobId)+'/reexecutions',signal,'POST',p.body,p.key,'quality-job',35000);
      if(!value||typeof value.replayed!=='boolean'||!value.job?.id||value.job.id===p.jobId||!value.job.state||value.job.retryOf?.retryOf!==p.jobId||value.job.retryOf.planDigest!==p.body.planDigest||value.receipt?.actorId!==p.actor||value.receipt.parentId!==p.jobId||value.receipt.jobId!==value.job.id||value.receipt.key!==p.key||canonicalJson(value.receipt.request)!==canonicalJson(p.body)||canonicalJson(value.receipt.lineage)!==canonicalJson(value.job.retryOf))throw Error('Incomplete successful reexecution acknowledgement; outcome remains unknown');
    }catch(error){
      if(error instanceof ApiError&&error.status>=400&&error.status<500){const still=this.pending(p.actor,p.kind);if(still?.key===p.key)this.storage.setItem(this.key(p.actor,p.kind),JSON.stringify({...still,rejected:{status:error.status,code:error.code}}));}
      throw error;
    }
    const still=this.pending(p.actor,p.kind);if(still?.key===p.key)this.storage.removeItem(this.key(p.actor,p.kind));return value;
  }
  clearRejected(actor:string,kind:ReexecutionKind){const p=this.pending(actor,kind);if(!p?.rejected)throw Error('An unknown submission cannot be discarded to create a new key');this.storage.removeItem(this.key(actor,kind));}
}
