import {taskSummaries,taskEdges} from '../../tasks/summary.ts';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {openIndexDatabase} from '../../sqlite.ts';
import {lockDatabase} from '../../library-store.ts';
import {AdminError} from '../../admin-error.ts';
import type {Actor} from '../../identity.ts';
import type {LibraryPairRunner} from './runner.ts';
import type {QualityRangeService} from './range-service.ts';
import {qualityJobRequest,qualityIdempotencyKey} from './job-request.ts';
import {FLV_MEDIA_INDEX_IDENTITY} from '../../../shared/media/indexing/media-index-identity.ts';
import {referenceRelationInput,correspondenceInput,correspondenceKeys,canonicalJson,terminalCorrespondence,CORRESPONDENCE_LIMITS as LIMITS} from '../../../shared/analysis/quality/correspondence.ts';
import type {ReferenceRelation,CorrespondencePlan,CorrespondenceResult,CorrespondenceInput} from '../../../shared/analysis/quality/correspondence.ts';
import type {QualityRangeInput} from '../../../shared/analysis/quality/ranges.ts';

const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const now=()=>Math.floor(performance.timeOrigin+performance.now());
type Intent={actor:Actor;requestId:string;key:string;input:QualityRangeInput;inputDigest:string;digest:string;rangeId:string|null};
/** Durable metadata planning and frozen submission receipts. Only the runner
 * owns admission; submission calls the existing range service after it exits. */
export class CorrespondenceService{
  taskSummaries(actor:string,id?:string,filter?:import('../../../shared/service/tasks.ts').TaskFilter){return taskSummaries(this.db,'correspondence',actor,id,filter);}
  taskEdges(actor:string,id?:string){return taskEdges(this.db,'correspondence',actor,id);}
  taskRange(id:string,actor:string){
    const plan=this.get(id,actor),row=this.db.prepare('SELECT body FROM quality_plan_executions WHERE plan_id=?').get(id);
    if(!row)return null;const intent=JSON.parse(String(row.body)) as Intent;if(!intent.rangeId)return null;
    const job=this.ranges.get(intent.rangeId,actor);
    if(intent.actor.id!==actor||intent.digest!==plan.resultDigest||intent.key!=='execute'||intent.input.client.id!==`clock-plan:${id}`||intent.input.client.kind!==plan.input.client.kind||hash(intent.input)!==intent.inputDigest||job.key!==intent.key||job.requestId!==intent.requestId||hash(job.plan.input)!==hash(this.ranges.plan(intent.input).input))throw new AdminError(500,'Stored plan execution association changed.','stored-plan-invalid');
    return intent.rangeId;
  }

  private db:ReturnType<typeof openIndexDatabase>;
  private unlock:()=>void;
  private active?:{id:string;controller:AbortController;done:Promise<void>};
  private timer?:ReturnType<typeof setTimeout>;
  private closed=false;
  private fatal:unknown;
  private failed=false;
  private closing?:Promise<void>;
  private runner:LibraryPairRunner;
  private ranges:QualityRangeService;
  constructor(file:string,runner:LibraryPairRunner,ranges:QualityRangeService){
    this.runner=runner;this.ranges=ranges;
    mkdirSync(path.dirname(file),{recursive:true});this.unlock=lockDatabase(file);let db:ReturnType<typeof openIndexDatabase>|undefined;
    try{
      this.db=db=openIndexDatabase(file);db.exec('PRAGMA busy_timeout=0;');
      if(Number(db.prepare('PRAGMA user_version').get()!.user_version)>1)throw Error('Reference plans require a newer application');
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS quality_relations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,client TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,reserved INTEGER NOT NULL,UNIQUE(actor,client,key));
        CREATE TABLE IF NOT EXISTS quality_correspondence_plans(id TEXT PRIMARY KEY,actor TEXT NOT NULL,client TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,result TEXT,reserved INTEGER NOT NULL,UNIQUE(actor,client,key));
        CREATE TABLE IF NOT EXISTS quality_plan_executions(plan_id TEXT PRIMARY KEY,body TEXT NOT NULL);
        PRAGMA user_version=1;`);
      db.exec('BEGIN IMMEDIATE');try{
        for(const plan of this.plans())if(!terminalCorrespondence(plan.state)){
          plan.state='interrupted';plan.endedAt=now();plan.reason={code:'service-restarted',message:'Planning interrupted; no automatic replan, scoring or publication.'};this.save(plan);
        }
        this.settle();db.exec('UPDATE quality_relations SET reserved=length(CAST(body AS BLOB))+1024');
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    }catch(e){db?.close();this.unlock();throw e;}
    this.unqueue=runner.admission?.registerQueue(()=>this.plans().map(p=>({actor:p.actor.id,count:1})));
  }
  private unqueue?:()=>void;
  private available(){if(this.closed||this.failed||this.runner.stopUncertain)throw new AdminError(503,'Reference plan service unavailable.','correspondence-unavailable');}
  private parse<T>(fn:()=>T):T{try{return fn();}catch(e){if(e instanceof AdminError)throw e;throw new AdminError(400,(e as Error).message,'invalid-correspondence');}}
  private plans(){return this.db.prepare("SELECT body FROM quality_correspondence_plans WHERE json_extract(body,'$.state') IN ('queued','running','cancelling') ORDER BY rowid").all().map(r=>JSON.parse(String(r.body)) as CorrespondencePlan);}
  private save(p:CorrespondencePlan){p.revision++;this.db.prepare('UPDATE quality_correspondence_plans SET body=? WHERE id=?').run(JSON.stringify(p),p.id);if(terminalCorrespondence(p.state))this.settle(p.id);}
  private settle(id?:string){this.db.prepare("UPDATE quality_correspondence_plans SET reserved=length(CAST(body AS BLOB))+coalesce(length(CAST(result AS BLOB)),0)+1024 WHERE json_extract(body,'$.state') NOT IN ('queued','running','cancelling')"+(id?' AND id=?':'')).run(...(id?[id]:[]));}
  private capacity(reserved:number){
    const bytes=Number(this.db.prepare('SELECT (SELECT coalesce(sum(reserved),0) FROM quality_relations)+(SELECT coalesce(sum(reserved),0) FROM quality_correspondence_plans) AS n').get()!.n);
    if(bytes+reserved>LIMITS.reservedBytes)throw new AdminError(429,'Reference relation/plan history budget full; existing receipts retained.','correspondence-history-full');
  }
  createRelation(value:unknown,actor:Actor,requestId:string,key:unknown){
    this.available();const input=this.parse(()=>referenceRelationInput(value)),k=qualityIdempotencyKey(key),fingerprint=hash(input);
    const prior=this.db.prepare('SELECT id,fingerprint FROM quality_relations WHERE actor=? AND client=? AND key=?').get(actor.id,input.client.id,k);
    if(prior){if(prior.fingerprint!==fingerprint)throw new AdminError(409,'Relation key binds another declaration.','idempotency-conflict');return {relation:this.relation(String(prior.id),actor.id),replayed:true};}
    const relation:ReferenceRelation={id:randomUUID(),actor:{id:actor.id,name:actor.name},requestId,key:k,revision:1,createdAt:now(),input,assessment:'caller-declared-not-content-certified'};
    const reserved=Buffer.byteLength(JSON.stringify(relation))+4096;this.capacity(reserved);
    this.db.prepare('INSERT INTO quality_relations VALUES(?,?,?,?,?,?,?)').run(relation.id,actor.id,input.client.id,k,fingerprint,JSON.stringify(relation),reserved);
    return {relation,replayed:false};
  }
  relation(id:string,actor:string){const row=this.db.prepare('SELECT body FROM quality_relations WHERE id=? AND actor=?').get(id,actor);if(!row)throw new AdminError(404,'Reference relation not found.','relation-not-found');return JSON.parse(String(row.body)) as ReferenceRelation;}
  private page(table:'quality_relations'|'quality_correspondence_plans',actor:string,after:number,limit:number){
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>10)throw new AdminError(400,'Invalid history cursor.','invalid-cursor');
    const rows=this.db.prepare(`SELECT rowid,body FROM ${table} WHERE actor=? AND rowid>? ORDER BY rowid LIMIT ?`).all(actor,after,limit+1);
    return {entries:rows.slice(0,limit).map(r=>JSON.parse(String(r.body))),after:rows.length?Number(rows[Math.min(limit,rows.length)-1].rowid):after,more:rows.length>limit};
  }
  relations(actor:string,after=0,limit=10){return this.page('quality_relations',actor,after,limit);}
  history(actor:string,after=0,limit=10){const page=this.page('quality_correspondence_plans',actor,after,limit);return {...page,entries:(page.entries as CorrespondencePlan[]).map(p=>({id:p.id,state:p.state,revision:p.revision,createdAt:p.createdAt,relationId:p.relation.id,reason:p.reason}))};}
  private normalize(value:unknown):CorrespondenceInput{
    return this.parse(()=>{
      const input=correspondenceInput(value),binding={mediaId:'a'.repeat(24),mediaVersion:'b'.repeat(24),size:1,indexIdentity:FLV_MEDIA_INDEX_IDENTITY,indexBuildId:'recipe-validation',picture:{sourceVersion:`${'a'.repeat(24)}@${'b'.repeat(24)}`,stream:'video' as const,configuration:0,au:0,picture:0,layer:0,field:'frame' as const},sourcePtsUs:0,decode:{mode:'packet-identity-gop-v1' as const,startAu:0,endAu:31}};
      const request=qualityJobRequest({schema:'voidplayer-psnr-frame-job',version:1,client:input.client,request:{pairing:'caller-specified',reference:binding,distorted:binding,...input.recipe}}).input.request;
      input.recipe={roi:request.roi,...(request.spatial?{spatial:request.spatial}:{}),...(request.ssim?{ssim:request.ssim}:{}),budget:request.budget};
      if(Buffer.byteLength(JSON.stringify(input))>LIMITS.requestBytes)throw Error('Plan request exceeds byte budget');return JSON.parse(canonicalJson(input));
    });
  }
  submit(value:unknown,actor:Actor,requestId:string,key:unknown){
    this.available();const input=this.normalize(value),k=qualityIdempotencyKey(key),fingerprint=hash(input);
    const prior=this.db.prepare('SELECT id,fingerprint FROM quality_correspondence_plans WHERE actor=? AND client=? AND key=?').get(actor.id,input.client.id,k);
    if(prior){if(prior.fingerprint!==fingerprint)throw new AdminError(409,'Plan key binds another request.','idempotency-conflict');return {plan:this.get(String(prior.id),actor.id),replayed:true};}
    this.runner.admission?.assertQueue(actor.id);
    const relation=this.relation(input.relation.id,actor.id);if(input.relation.revision!==relation.revision)throw new AdminError(409,'Reference relation revision changed.','relation-conflict');
    const unfinished=this.plans().filter(p=>!terminalCorrespondence(p.state));if(unfinished.length>=LIMITS.queued||unfinished.filter(p=>p.actor.id===actor.id).length>=LIMITS.actorOutstanding)throw new AdminError(429,'Correspondence planning queue full.','correspondence-queue-full');
    const plan:CorrespondencePlan={id:randomUUID(),actor:{id:actor.id,name:actor.name},requestId,key:k,relation,input,createdAt:now(),startedAt:null,endedAt:null,attemptId:null,state:'queued',reason:null,resultDigest:null,revision:1};
    const reserved=LIMITS.planReservation;this.capacity(reserved);
    this.db.prepare('INSERT INTO quality_correspondence_plans VALUES(?,?,?,?,?,?,?,?)').run(plan.id,actor.id,input.client.id,k,fingerprint,JSON.stringify(plan),null,reserved);this.pump();this.wake();return {plan:this.get(plan.id,actor.id),replayed:false};
  }
  get(id:string,actor:string){const row=this.db.prepare('SELECT body FROM quality_correspondence_plans WHERE id=? AND actor=?').get(id,actor);if(!row)throw new AdminError(404,'Correspondence plan not found.','plan-not-found');return JSON.parse(String(row.body)) as CorrespondencePlan;}
  private validate(plan:CorrespondencePlan,value:CorrespondenceResult){
    const invalid=()=>new AdminError(500,'Frozen correspondence facts are inconsistent.','stored-plan-invalid');
    if(value.schema!=='voidplayer-quality-correspondence-result'||value.version!==1||canonicalJson(value.request)!==canonicalJson(plan.input)||canonicalJson(value.relation)!==canonicalJson(plan.relation)||value.rows.length!==plan.input.interval.endAu-plan.input.interval.startAu+1||value.rows.some((r,i)=>r.au!==plan.input.interval.startAu+i)||value.work.indexBytes>plan.input.planningBudget.maxIndexBytes||value.work.indexPackets>plan.input.planningBudget.maxIndexPackets||value.work.sourceReadBytes!==0||value.work.decodedFrames!==0)throw invalid();
    for(const side of ['reference','distorted'] as const){const s=value.sources[side].binding,expected=plan.relation.input[side];if(s.mediaId!==expected.mediaId||s.mediaVersion!==expected.mediaVersion||s.indexBuildId!==plan.input[`${side}BuildId`])throw invalid();}
  }
  result(id:string,actor:string){
    const plan=this.get(id,actor),row=this.db.prepare('SELECT result FROM quality_correspondence_plans WHERE id=?').get(id);
    if(!row?.result||!plan.resultDigest)throw new AdminError(409,'Plan has no frozen result.','plan-result-unavailable');const value=JSON.parse(String(row.result)) as CorrespondenceResult;
    if(hash(value)!==plan.resultDigest)throw new AdminError(500,'Frozen correspondence result digest changed.','stored-plan-invalid');this.validate(plan,value);return value;
  }
  detail(id:string,actor:string){
    const plan=this.get(id,actor),value=plan.resultDigest?this.result(id,actor):null;
    return {plan,summary:value?{assessment:value.assessment,counts:Object.fromEntries(['mapped','unmapped','ambiguous','unsupported'].map(s=>[s,value.rows.filter(r=>r.status===s).length])),selected:value.rows.filter(r=>r.selected).length,work:value.work,sources:value.sources,sourceIssues:value.sourceIssues,executionBlock:value.executionBlock,reservation:value.rangePlan?.reservation??null,preRollAndDrain:value.rangePlan?.preRollAndDrain??null}:null,execution:this.receipt(id,actor)};
  }
  rows(id:string,actor:string,after=0,limit:number=LIMITS.page){
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>LIMITS.page)throw new AdminError(400,'Invalid AU page.','invalid-cursor');
    const value=this.result(id,actor),rows=value.rows.filter(r=>r.au>=after),entries=rows.slice(0,limit);return {entries,nextAu:rows.length>limit?entries.at(-1)!.au+1:null,digest:this.get(id,actor).resultDigest};
  }
  executionContext(rangeId:string,actor:string){const rows=this.db.prepare('SELECT plan_id,body FROM quality_plan_executions').all();for(const row of rows){const intent=JSON.parse(String(row.body)) as Intent;if(intent.actor.id!==actor||intent.rangeId!==rangeId)continue;const plan=this.get(String(row.plan_id),actor),result=this.result(plan.id,actor);if(plan.state!=='completed'||!plan.attemptId||intent.digest!==plan.resultDigest||hash(intent.input)!==intent.inputDigest||hash(this.ranges.plan(intent.input).input)!==hash(this.ranges.reexecutionInput(rangeId,actor))||hash(result)!==plan.resultDigest)throw new AdminError(409,'Original correspondence receipt changed; create a new intent.','plan-changed');return {id:plan.id,attemptId:plan.attemptId,digest:plan.resultDigest!};}return null;}
  rangeInput(id:string,actor:string){const r=this.result(id,actor);if(!r.rangePlan)throw new AdminError(409,r.executionBlock?.message??'No executable pairs.','plan-blocked');return r.rangePlan.input;}
  private receipt(id:string,actor:string){this.get(id,actor);const row=this.db.prepare('SELECT body FROM quality_plan_executions WHERE plan_id=?').get(id);if(!row)return null;const intent=JSON.parse(String(row.body)) as Intent;return {digest:intent.digest,rangeId:intent.rangeId,state:intent.rangeId?'submitted':'submission-unconfirmed'};}
  execute(id:string,actor:Actor,value:unknown,requestId:string){
    this.available();const plan=this.get(id,actor.id);this.parse(()=>correspondenceKeys(value,['digest']));const digest=(value as {digest?:string}).digest;
    if(typeof digest!=='string'||digest!==plan.resultDigest)throw new AdminError(409,'Pin the exact frozen plan digest.','plan-digest-conflict');
    const row=this.db.prepare('SELECT body FROM quality_plan_executions WHERE plan_id=?').get(id);let intent:Intent;
    if(row){intent=JSON.parse(String(row.body));if(intent.digest!==digest||intent.actor.id!==actor.id||intent.key!=='execute'||intent.input.client.id!==`clock-plan:${id}`||intent.input.client.kind!==plan.input.client.kind||hash(intent.input)!==intent.inputDigest)throw new AdminError(500,'Execution receipt binding changed.','stored-plan-invalid');if(intent.rangeId){const job=this.ranges.get(intent.rangeId,actor.id);if(job.key!==intent.key||job.requestId!==intent.requestId||hash(job.plan.input)!==hash(this.ranges.plan(intent.input).input))throw new AdminError(500,'Execution receipt points to another range.','stored-plan-invalid');return {job,replayed:true};}}
    else{
      if(plan.state!=='completed')throw new AdminError(409,'Plan is not executable.','plan-blocked');const input=structuredClone(this.rangeInput(id,actor.id));input.client={id:`clock-plan:${id}`,kind:plan.input.client.kind};
      intent={actor:{id:actor.id,name:actor.name},requestId,key:'execute',input,inputDigest:hash(input),digest,rangeId:null};
      this.db.prepare('INSERT INTO quality_plan_executions VALUES(?,?)').run(id,JSON.stringify(intent));
    }
    const expected=structuredClone(this.rangeInput(id,actor.id));expected.client={id:`clock-plan:${id}`,kind:plan.input.client.kind};
    if(hash(expected)!==intent.inputDigest)throw new AdminError(500,'Frozen execution intent differs from its plan.','stored-plan-invalid');
    // No metadata Worker or outer permit is held. The durable B key is the
    // recovery point if its commit succeeds but this receipt update is lost.
    const accepted=this.ranges.submit(intent.input,intent.actor,intent.requestId,intent.key);intent.rangeId=accepted.job.id;
    this.db.prepare('UPDATE quality_plan_executions SET body=? WHERE plan_id=?').run(JSON.stringify(intent),id);return accepted;
  }
  cancel(id:string,actor:string){this.available();const plan=this.get(id,actor);if(!terminalCorrespondence(plan.state)){if(plan.state==='queued'){plan.state='cancelled';plan.endedAt=now();}else plan.state='cancelling';this.save(plan);if(this.active?.id===id)this.active.controller.abort(new AdminError(499,'Planning explicitly cancelled.','cancelled'));}return this.get(id,actor);}
  private wake(){if(this.timer||this.closed||this.failed||!this.plans().some(p=>p.state==='queued'))return;this.timer=setTimeout(()=>{this.timer=undefined;this.pump();this.wake();},250);this.timer.unref();}
  private pump(){if(this.active||this.closed||this.failed)return;const plan=this.plans().find(p=>p.state==='queued');if(!plan)return;const active={id:plan.id,controller:new AbortController(),done:Promise.resolve()};this.active=active;active.done=this.run(plan,active.controller).catch(e=>{this.failed=true;this.fatal=e;console.error('Correspondence planner stopped; ownership retained',e);}).finally(()=>{this.active=undefined;this.wake();});}
  private async run(initial:CorrespondencePlan,controller:AbortController){
    let plan=initial;
    if(now()-plan.createdAt>=300000){plan.state='failed';plan.endedAt=now();plan.reason={code:'queue-expired',message:'Planning queue wait exceeded five minutes; no Worker started.'};this.save(plan);return;}
    let admitted=false;
    try{
      const value=await this.runner.planCorrespondence(plan.relation,plan.input,controller.signal,{admitted:()=>{admitted=true;plan.state='running';plan.attemptId=randomUUID();plan.startedAt=now();this.save(plan);},phase:()=>{}});
      plan=this.get(plan.id,plan.actor.id);
      if(this.closed||plan.state==='cancelling')throw new AdminError(499,'Planning stopped after physical Worker exit.','cancelled');
      if(value.rangePlan)try{value.rangePlan=this.ranges.plan(value.rangePlan.input);}catch(e){value.rangePlan=null;value.executionBlock={code:'range-plan-blocked',message:e instanceof Error?e.message.slice(0,300):'Planning failed; no automatic retry.'};}
      this.validate(plan,value);if(Buffer.byteLength(JSON.stringify(value))>LIMITS.resultBytes)throw new AdminError(413,'Frozen plan exceeds result byte budget.','budget-exceeded');
      plan.state=value.rangePlan?'completed':'blocked';plan.reason=value.executionBlock;plan.endedAt=now();plan.resultDigest=hash(value);plan.revision++;
      this.db.prepare('UPDATE quality_correspondence_plans SET body=?,result=? WHERE id=?').run(JSON.stringify(plan),JSON.stringify(value),plan.id);this.settle(plan.id);
    }catch(e){
      plan=this.get(plan.id,plan.actor.id);
      if(this.runner.stopUncertain){plan.state='cancelling';plan.reason={code:'worker-stop-uncertain',message:'Physical planner exit unconfirmed; compute and database ownership retained.'};this.save(plan);throw e;}
      if(!admitted&&e instanceof AdminError&&e.code==='quality-busy')return;
      plan.state=this.closed?'interrupted':plan.state==='cancelling'||plan.state==='cancelled'?'cancelled':'failed';plan.endedAt=now();plan.reason={code:this.closed?'service-shutdown':(e as {code?:string}).code??'planning-failed',message:e instanceof Error?e.message.slice(0,300):'Planning failed; no automatic retry.'};this.save(plan);
    }
  }
  close(){return this.closing??=(async()=>{this.closed=true;clearTimeout(this.timer);this.active?.controller.abort(new AdminError(499,'Planner stopping.','service-shutdown'));await this.active?.done;if(this.failed)throw this.fatal;for(const plan of this.plans())if(!terminalCorrespondence(plan.state)){plan.state='interrupted';plan.endedAt=now();plan.reason={code:'service-shutdown',message:'Planning stopped; no automatic retry.'};this.save(plan);}this.unqueue?.();this.db.close();this.unlock();})();}
}
