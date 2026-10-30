import type {MediaLibraryIndex} from '../../library.ts';
import type {Actor} from '../../identity.ts';
import {AdminError} from '../../admin-error.ts';
import {CAMBI_LIMITS,cambiOutputBudget} from '../../../shared/analysis/quality/cambi.ts';
import {pairBudget} from '../../../shared/analysis/quality/frame-pair.ts';
import type {FramePairRequest} from '../../../shared/analysis/quality/frame-pair.ts';
import {canonicalJson} from '../../../shared/analysis/quality/correspondence.ts';
import {executionWitnessReservation,nextReexecutionLineage,reexecutionPath,reexecutionReason,reexecutionRequest,REEXECUTION_LIMITS} from '../../../shared/analysis/quality/reexecution.ts';
import type {ReexecutionKind,ReexecutionPlan,ReexecutionCost,QualityExecutionContract} from '../../../shared/analysis/quality/reexecution.ts';
import {executionDigest} from './reexecution-ledger.ts';
import {qualityIdempotencyKey} from './job-request.ts';

type Description={job:{id:string;state:string;revision:number;endedAt:number|null;reason:unknown;retryOf?:import('../../../shared/analysis/quality/reexecution.ts').ReexecutionLineage};input:unknown;requests:FramePairRequest[];contract:QualityExecutionContract|undefined;cost:ReexecutionCost;previous:ReexecutionPlan['previous'];correspondence:ReexecutionPlan['correspondence']};
/** This adapter owns no scheduler, job database or compute permit. Read-only
 * validation uses the existing killable runners and returns after physical exit;
 * only then does the original service atomically accept a fresh durable job. */
export class QualityReexecutionService{
  private library:MediaLibraryIndex;
  private stopping=new AbortController();
  private active=new Set<Promise<unknown>>();
  constructor(library:MediaLibraryIndex){this.library=library;}
  private service(kind:ReexecutionKind){return kind==='single'?this.library.qualityJobs:kind==='range'?this.library.qualityRanges:kind==='xpsnr'?this.library.qualityXpsnr:kind==='cambi'?this.library.qualityCambi:this.library.qualityVmaf;}
  private job(kind:ReexecutionKind,id:string,actor:string){const service=this.service(kind),job=service.get(id,actor);if(job.retryOf){const receipt=service.reexecutionReceipt(job.retryOf.retryOf,actor);if(!receipt||receipt.jobId!==id||executionDigest(receipt.lineage)!==executionDigest(job.retryOf))throw new AdminError(409,'Stored execution lineage changed.','stored-reexecution-invalid');}return job;}
  private describe(kind:ReexecutionKind,id:string,actor:string):Description{
    const base=(budget:Record<string,number>,pairs:number,reservation:Record<string,unknown>):ReexecutionCost=>({scope:'entire-frozen-input-from-start',selectedPairs:pairs,reusesPreviousScores:false,budget,reservation:{...reservation,executionWitness:executionWitnessReservation(kind,pairs),witness:{maxCoreAssetBytes:REEXECUTION_LIMITS.maxReadBytes,maxProducerBytes:REEXECUTION_LIMITS.maxProducerBytes,maxIndexBytes:REEXECUTION_LIMITS.maxIndexBytes,maxIndexPackets:REEXECUTION_LIMITS.maxIndexPackets,maxElapsedMs:REEXECUTION_LIMITS.maxElapsedMs},newAttemptPerJob:1}});
    if(kind==='single'){
      const j=this.library.qualityJobs.get(id,actor),input=this.library.qualityJobs.reexecutionInput(id,actor);
      return {job:j,input,requests:[input.request],contract:j.executionContract,cost:base({...pairBudget(input.request),maxInputBytes:input.request.budget!.maxInputBytes!,maxSamples:input.request.budget!.maxSamples!},1,{}),previous:{reason:j.reason,result:j.result},correspondence:null};
    }
    if(kind==='range'){
      const service=this.library.qualityRanges,j=service.get(id,actor),input=service.reexecutionInput(id,actor),requests=input.pairs.filter(p=>j.plan.selectedAus.includes(p.reference.picture.au));
      return {job:j,input,requests,contract:service.executionContract(id,actor),cost:base({...input.budget},requests.length,{...j.plan.reservation,interval:input.interval,selectedPositions:j.plan.selectedAus.length,unmappedPositions:j.plan.unmappedAus.length,unsampledPositions:j.plan.unsampledAus.length}),previous:{reason:j.reason,result:{summary:{scoredPairs:j.summary.scoredPairs,work:j.summary.work,pixelDomains:j.summary.groups.length},coverage:service.coverage(j),results:`${reexecutionPath(kind,id)}/results`}},correspondence:this.library.qualityCorrespondence.executionContext(j.retryOf?.rootJobId??id,actor)};
    }
    if(kind==='cambi'){
      const service=this.library.qualityCambi,j=service.get(id,actor),selection=(j.executionContract?.nativeCambi?.selection??j.executionContract?.analysis?.selection);
      const pictures=selection&&'pictures'in selection?selection.pictures:undefined,count=selection?pictures?.length??('selectedPictures'in selection?selection.selectedPictures:0):0;
      const output=selection?cambiOutputBudget(selection.geometry.width,selection.geometry.height,count,j.input):null;
      const analysis=!!j.executionContract?.analysis;
      const dependencyInputs=pictures?[...new Map(pictures.map(t=>[t.decode?`${t.decode.startAu}:${t.decode.mode==='packet-identity-gop-v1'?t.decode.endAu:t.au}`:`${t.au}`,t.decode?(t.decode.mode==='packet-identity-gop-v1'?t.decode.endAu:t.au)-t.decode.startAu+1:1])).values()].reduce((a,b)=>a+b,0):(selection&&'dependencyInputs'in selection?selection.dependencyInputs:null);
      const cost=base({...j.input.budget,maxReadBytes:CAMBI_LIMITS.maxReadBytes,maxPackets:CAMBI_LIMITS.maxPackets,maxIndexBytes:CAMBI_LIMITS.maxIndexBytes,maxIndexPackets:CAMBI_LIMITS.maxIndexPackets},0,{selectedPictures:selection?count:null,selectedAus:pictures?.map(p=>p.au)??null,sourcePtsUs:pictures?.map(p=>p.sourcePtsUs)??null,selectionSha256:selection?executionDigest(selection):null,frameOrder:selection?.frameOrder??null,interval:j.input.interval,sampling:j.input.sampling,output,workerOldGenerationLimitBytes:256*1024*1024,decoderWasmMemoryMaximumBytes:256*1024*1024,...(analysis?{analysisWasmMemoryMaximumBytes:Math.min(j.input.budget.nativeMemoryBytes,512*1024*1024)}:{nativeAssetVerificationPasses:3,nativeAssetMaxBytesPerPass:5*16*1024*1024+32768}),persistentWitnessReceiptBytes:32*1024,dependencyInputs});cost.selectedPictures=count;
      return {job:j,input:j.input,requests:[],contract:j.executionContract,cost,previous:{reason:j.reason,result:{digest:j.resultDigest,progress:j.progress,resultAvailable:!!j.resultDigest,discardedIncompleteHeatmaps:true}},correspondence:null};
    }
    const service=kind==='xpsnr'?this.library.qualityXpsnr:this.library.qualityVmaf,j=service.get(id,actor),snapshot=service.frozenSnapshot(id,actor),range=snapshot.value.rangePlan;
    if(!range)throw new AdminError(409,'Original native sequence plan has no frozen input.','plan-changed');
    return {job:j,input:j.input,requests:range.input.pairs,contract:j.executionContract,cost:base({...range.input.budget,...j.input.budget},range.input.pairs.length,{...range.reservation,nativeAssetVerificationPasses:3}),previous:{reason:j.reason,result:{digest:j.resultDigest,metrics:j.metrics,progress:j.progress,result:`${reexecutionPath(kind,id)}/result`}},correspondence:j.input.plan};
  }
  private own<T>(work:(signal:AbortSignal)=>Promise<T>,external:AbortSignal){
    if(this.stopping.signal.aborted)throw new AdminError(503,'Reexecution planner is stopping.','reexecution-unavailable');
    const promise=work(AbortSignal.any([external,this.stopping.signal]));this.active.add(promise);void promise.finally(()=>this.active.delete(promise)).catch(()=>{});return promise;
  }
  plan(kind:ReexecutionKind,id:string,actor:string,reasonValue:unknown,signal:AbortSignal){return this.own(async combined=>{
    let reason:string;try{reason=reexecutionReason(reasonValue);}catch(error){throw new AdminError(400,(error as Error).message,'invalid-reexecution-request');}this.job(kind,id,actor);let d:Description;try{d=this.describe(kind,id,actor);}catch(error){const e=error as {code?:string};if(['stored-plan-invalid','stored-input-invalid','plan-changed'].includes(e.code??''))throw new AdminError(409,'Frozen original or C plan cannot be verified. Declare a new intent; nothing was rebuilt.','reexecution-blocked');throw error;}const path=reexecutionPath(kind,id);
    const plan:ReexecutionPlan={schema:'voidplayer-quality-reexecution-plan',version:1,kind,jobId:id,state:d.job.state,revision:d.job.revision,reason,eligible:false,blocks:[],digest:null,cost:d.cost,previous:d.previous,lineage:null,correspondence:d.correspondence,contract:d.contract??null,inputDigest:executionDigest(d.input),next:{plan:path+'/reexecution-plan',execute:path+'/reexecutions',chain:path+'/reexecutions'}};
    const block=(code:string,message:string,next:ReexecutionPlan['blocks'][number]['next'])=>plan.blocks.push({code,message,next});
    if(!(kind==='cambi'?['failed','interrupted','cancelled']:['failed','interrupted','cancelled','partial']).includes(d.job.state)||d.job.endedAt===null)block('original-not-stopped',kind==='cambi'?'Only a failed/interrupted/cancelled terminal CAMBI job can be explicitly reexecuted.':'Only a failed/interrupted/cancelled/partial terminal job can be explicitly reexecuted.','observe-original');
    if(!d.contract)block('execution-contract-unavailable','This historical job has no complete execution witness. Declare a new intent; current assets cannot prove the old conditions.','new-intent');
    if((d.job.retryOf?.generation??1)>=REEXECUTION_LIMITS.chain)block('reexecution-chain-full','The bounded execution chain is full.','new-intent');
    const prior=this.service(kind).reexecutionReceipt(id,actor);
    if(prior)block('successor-exists','This original already has a durable successor. Observe the chain; do not change keys to create another.','observe-original');
    if(plan.blocks.length)return plan;
    try{
      if(kind==='cambi')await this.library.qualityCambi.reexecutionPreflight(id,actor,d.contract!,combined);
      else if(kind==='vmaf'||kind==='xpsnr')await (kind==='xpsnr'?this.library.qualityXpsnr:this.library.qualityVmaf).reexecutionPreflight(id,actor,d.contract!,combined);
      else {const resources=this.library.qualityJobs.resources();if(!resources.available||resources.admissionBlocked)throw new AdminError(503,'Physical executor exit is unconfirmed.','physical-stop-unconfirmed');await this.library.quality.reexecutionPreflight(d.requests,d.contract!,combined);}
      combined.throwIfAborted();
      // Re-read all frozen records after the owned IO probe, before offering a
      // confirmation digest. Terminal originals and C receipts must not drift.
      const current=this.describe(kind,id,actor);
      if(current.job.revision!==d.job.revision||executionDigest(current.input)!==plan.inputDigest||canonicalJson(current.correspondence)!==canonicalJson(d.correspondence))throw new AdminError(409,'Frozen original or correspondence changed.','plan-changed');
      const digest=executionDigest({schema:plan.schema,version:1,kind,id,revision:plan.revision,reason,inputDigest:plan.inputDigest,cost:plan.cost,contract:plan.contract,correspondence:plan.correspondence});
      const {requestedAt,...lineage}=nextReexecutionLineage(id,d.job.retryOf,reason,digest,0);void requestedAt;plan.lineage=lineage;plan.digest=digest;plan.eligible=true;
    }catch(error){combined.throwIfAborted();const e=error as {code?:string;message?:string};const code=e.code??'reexecution-validation-failed';block(code,(e.message??'Frozen execution conditions could not be verified.').slice(0,400),['quality-busy','busy','physical-stop-unconfirmed','vmaf-service-unavailable','xpsnr-service-unavailable','cambi-service-unavailable'].includes(code)?'wait-and-replan':'new-intent');}
    return plan;
  },signal);}
  async execute(kind:ReexecutionKind,id:string,actor:Actor,requestId:string,keyValue:unknown,value:unknown,signal:AbortSignal){
    let request;try{request=reexecutionRequest(value);}catch(error){throw new AdminError(400,(error as Error).message,'invalid-reexecution-request');}
    const key=qualityIdempotencyKey(keyValue),service=this.service(kind);
    this.job(kind,id,actor.id);const receipt=service.reexecutionReceipt(id,actor.id,key,request);
    if(receipt)return {job:service.get(receipt.jobId,actor.id),replayed:true,receipt};
    const plan=await this.plan(kind,id,actor.id,request.reason,signal);
    if(!plan.eligible)throw new AdminError(409,plan.blocks.map(b=>b.code+': '+b.message).join('; ').slice(0,1200),'reexecution-blocked');
    if(request.planDigest!==plan.digest||canonicalJson(request.confirm)!==canonicalJson(plan.cost))throw new AdminError(409,'Confirm the current exact full recomputation scope and cost.','reexecution-plan-conflict');
    signal.throwIfAborted();this.stopping.signal.throwIfAborted();const original=this.job(kind,id,actor.id);
    const creation={parentId:id,parentRevision:plan.revision,key,request,lineage:nextReexecutionLineage(id,original.retryOf,request.reason,plan.digest!,Date.now()),contract:plan.contract!};
    const accepted=service.reexecute(creation,actor,requestId);
    return {...accepted,receipt:service.reexecutionReceipt(id,actor.id)!};
  }
  chain(kind:ReexecutionKind,id:string,actor:string){const job=this.job(kind,id,actor),next=this.service(kind).reexecutionReceipt(id,actor);return {schema:'voidplayer-quality-reexecution-chain',version:1,current:{id:job.id,state:job.state,attemptSemantics:'one-attempt-per-job'},retryOf:job.retryOf??null,successor:next?{id:next.jobId,url:reexecutionPath(kind,next.jobId),lineage:next.lineage,state:this.job(kind,next.jobId,actor).state}:null,automaticExecution:false};}
  async close(){this.stopping.abort(new AdminError(503,'Reexecution planner stopping.','reexecution-unavailable'));await Promise.allSettled([...this.active]);}
}
