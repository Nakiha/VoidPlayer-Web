import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {openIndexDatabase} from '../../sqlite.ts';
import {lockDatabase} from '../../library-store.ts';
import {AdminError} from '../../admin-error.ts';
import type {Actor} from '../../identity.ts';
import type {AnnotationStore} from '../../annotations.ts';
import type {QualityJobService} from './job-service.ts';
import {qualityJobRequest,qualityIdempotencyKey} from './job-request.ts';
import {aggregateRange,planQualityRange,terminalRange,rangeCandidatePolicy,selectRangeCandidates,QUALITY_RANGE_LIMITS as LIMITS} from '../../../shared/analysis/quality/ranges.ts';
import type {QualityRangeJob,QualityRangeInput,RangeCandidatePolicy} from '../../../shared/analysis/quality/ranges.ts';
import {terminalQualityJob} from '../../../shared/analysis/quality/jobs.ts';
import type {QualityEvidenceRef} from '../../../shared/review/quality-evidence.ts';

const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,25));
const serviceNow=()=>Math.floor(performance.timeOrigin+performance.now());
type Publication={policy:RangeCandidatePolicy;origin:string;selected:{au:number;id:string;operationId:string;evidence:QualityEvidenceRef}[];createdIds:string[]};

/** Parent never acquires admission; existing child runner owns physical stop. */
export class QualityRangeService {
  private db:ReturnType<typeof openIndexDatabase>;
  private unlock:()=>void;
  private active?:Promise<void>;
  private closed=false;
  private fatal:unknown;
  private closing?:Promise<void>;
  private jobs:QualityJobService;
  private now:()=>number;

  constructor(file:string,jobs:QualityJobService,now=serviceNow){
    this.jobs=jobs;this.now=now;mkdirSync(path.dirname(file),{recursive:true});this.unlock=lockDatabase(file);
    let db:ReturnType<typeof openIndexDatabase>|undefined;
    try{
      this.db=db=openIndexDatabase(file);db.exec('PRAGMA busy_timeout=0;');
      if(Number(db.prepare('PRAGMA user_version').get()!.user_version)>1)throw Error('Quality ranges require a newer application');
      db.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS quality_ranges(
          id TEXT PRIMARY KEY,actor TEXT NOT NULL,client TEXT NOT NULL,
          key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,
          reserved INTEGER NOT NULL,UNIQUE(actor,client,key)
        );
        CREATE TABLE IF NOT EXISTS quality_range_publications(range_id TEXT PRIMARY KEY,body TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      for(const job of this.rows())if(!terminalRange(job.state)){
        job.state='interrupted';job.endedAt=now();job.reason={code:'service-restarted',message:'Previous execution interrupted; no automatic retry or candidate creation.'};
        for(const sample of job.samples)if(!['completed','failed','unsupported','cancelled','interrupted'].includes(sample.state)){sample.state='interrupted';sample.reason=job.reason;}
        this.save(job);
      }
    }catch(e){db?.close();this.unlock();throw e;}
  }
  plan(value:unknown){
    try{
      const input=structuredClone(value) as QualityRangeInput;
      if(Array.isArray(input?.pairs))input.pairs=input.pairs.map(request=>qualityJobRequest({schema:'voidplayer-psnr-frame-job',version:1,client:input.client,request}).input.request);
      const plan=planQualityRange(input);
      if(Buffer.byteLength(JSON.stringify(plan))>LIMITS.requestBytes)throw Error('Range request exceeds byte budget');
      return plan;
    }catch(e){if(e instanceof AdminError)throw e;throw new AdminError(400,(e as Error).message,'invalid-range-plan');}
  }
  private rows(){return this.db.prepare('SELECT body FROM quality_ranges ORDER BY rowid').all().map(r=>JSON.parse(String(r.body)) as QualityRangeJob);}
  private save(job:QualityRangeJob){job.revision++;this.db.prepare('UPDATE quality_ranges SET body=? WHERE id=?').run(JSON.stringify(job),job.id);}
  get(id:string,actor:string){
    const row=this.db.prepare('SELECT body FROM quality_ranges WHERE id=? AND actor=?').get(id,actor);
    if(!row)throw new AdminError(404,'Range not found.','range-not-found');return JSON.parse(String(row.body)) as QualityRangeJob;
  }
  list(actor:string,after=0,limit=10){
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>10)throw new AdminError(400,'Invalid range page.','invalid-cursor');
    const rows=this.db.prepare('SELECT rowid,body FROM quality_ranges WHERE actor=? AND rowid>? ORDER BY rowid LIMIT ?').all(actor,after,limit+1);
    return {entries:rows.slice(0,limit).map(r=>{const j=JSON.parse(String(r.body)) as QualityRangeJob;const {plan,...rest}=j;return {...rest,coverage:this.coverage(j),sampling:plan.input.sampling};}),after:rows.length?Number(rows[Math.min(limit,rows.length)-1].rowid):after,more:rows.length>limit};
  }
  coverage(job:QualityRangeJob){
    return {domain:job.plan.coverageDomain,startAu:job.plan.input.interval.startAu,endAu:job.plan.input.interval.endAu,
      complete:job.state==='completed'&&job.plan.input.sampling.mode==='all'&&job.plan.unmappedAus.length===0,
      selected:job.plan.selectedAus.length,scored:job.samples.filter(s=>s.state==='completed').map(s=>s.au),unmapped:job.plan.unmappedAus,unsampled:job.plan.unsampledAus,
      unsupported:job.samples.filter(s=>s.state==='unsupported').map(s=>({au:s.au,reason:s.reason})),
      holes:job.plan.selectedAus.filter(au=>!job.samples.some(s=>s.au===au&&s.state==='completed'))};
  }
  progress(job:QualityRangeJob){
    const sample=job.samples.find(s=>!['completed','failed','unsupported','cancelled','interrupted'].includes(s.state));
    const child=sample?this.jobs.get(sample.jobId,job.actor.id):null;
    return {targetPositions:job.plan.targets,scoredPairs:job.summary.scoredPairs,
      finishedAttempts:job.samples.filter(s=>['completed','failed','unsupported','cancelled','interrupted'].includes(s.state)).length,
      active:child&&!terminalQualityJob(child.state)?{au:sample!.au,jobId:child.id,attemptId:child.attempt?.id??null,state:child.state,phase:child.phase,reason:child.reason,readBytes:null,decodedFrames:null}:null,
      completedMeasurementWork:job.summary.work,remainingSelectedPositions:job.plan.targets-job.summary.scoredPairs};
  }
  submit(value:unknown,actor:Actor,requestId:string,key:unknown){
    if(this.closed||this.fatal)throw new AdminError(503,'Range service unavailable.','range-service-unavailable');
    const plan=this.plan(value),k=qualityIdempotencyKey(key),fingerprint=digest(plan.input);
    const prior=this.db.prepare('SELECT id,fingerprint FROM quality_ranges WHERE actor=? AND client=? AND key=?').get(actor.id,plan.input.client.id,k);
    if(prior){if(prior.fingerprint!==fingerprint)throw new AdminError(409,'Range key already binds another plan.','idempotency-conflict');return {job:this.get(String(prior.id),actor.id),replayed:true};}
    const rows=this.rows(),reserve=Buffer.byteLength(JSON.stringify(plan))+64*1024;
    if(rows.length>=LIMITS.historyRows||Number(this.db.prepare('SELECT coalesce(sum(reserved),0) AS n FROM quality_ranges').get()!.n)+reserve>LIMITS.reservedBytes)
      throw new AdminError(429,'Range history full.','range-history-full');
    if(rows.filter(j=>!terminalRange(j.state)).length>=LIMITS.queued||rows.filter(j=>j.actor.id===actor.id&&!terminalRange(j.state)).length>=LIMITS.actorOutstanding)
      throw new AdminError(429,'Range queue admission full.','range-queue-full');
    const job:QualityRangeJob={id:randomUUID(),actor:{id:actor.id,name:actor.name},requestId,key:k,plan,state:'queued',createdAt:this.now(),startedAt:null,endedAt:null,reason:null,samples:[],summary:aggregateRange([]),cancelRequestedAt:null,revision:1};
    this.db.prepare('INSERT INTO quality_ranges VALUES(?,?,?,?,?,?,?)').run(job.id,actor.id,plan.input.client.id,k,fingerprint,JSON.stringify(job),reserve);
    this.pump();return {job:this.get(job.id,actor.id),replayed:false};
  }
  cancel(id:string,actor:string){
    const job=this.get(id,actor);
    if(!terminalRange(job.state)){job.cancelRequestedAt=this.now();job.state=job.state==='queued'?'cancelled':'cancelling';if(job.state==='cancelled')job.endedAt=this.now();this.save(job);}
    return this.get(id,actor);
  }
  private pump(){
    if(this.active||this.closed||this.fatal)return;const job=this.rows().find(j=>j.state==='queued');if(!job)return;
    this.active=this.execute(job).catch(e=>{this.fatal=e;console.error('Range service stopped; durable state retained',e);}).finally(()=>{this.active=undefined;this.pump();});
  }
  private async execute(initial:QualityRangeJob){
    let job=initial;job.state='running';job.startedAt=this.now();this.save(job);
    if(job.startedAt-job.createdAt>=300000){job.state='failed';job.endedAt=this.now();job.reason={code:'queue-expired',message:'Range queue wait exceeded five minutes; no child attempt started.'};this.save(job);return;}
    const deadline=job.startedAt+job.plan.input.budget.maxElapsedMs,results=[] as ReturnType<QualityJobService['result']>[];
    for(const au of job.plan.selectedAus){
      job=this.get(job.id,job.actor.id);if(this.closed||job.cancelRequestedAt!==null||this.now()>=deadline)break;
      const pair=job.plan.input.pairs.find(p=>p.reference.picture.au===au);if(!pair)continue;
      const request=structuredClone(pair);request.budget={...request.budget,maxElapsedMs:Math.max(1,Math.min(request.budget?.maxElapsedMs??30000,deadline-this.now()))};
      let child;
      try{child=this.jobs.submit({schema:'voidplayer-psnr-frame-job',version:1,client:{kind:job.plan.input.client.kind,id:`range:${job.id}`},request},job.actor,job.requestId,`sample:${au}`).job;}
      catch(e){const err=e as {code?:string;message?:string};job.reason={code:err.code??'submission-failed',message:err.message??'Child admission failed'};this.save(job);break;}
      job.samples.push({au,jobId:child.id,state:child.state,reason:null});this.save(job);
      while(!terminalQualityJob(child.state)){
        job=this.get(job.id,job.actor.id);
        if((this.closed||job.cancelRequestedAt!==null||this.now()>=deadline)&&child.state!=='cancelling')this.jobs.cancel(child.id,job.actor.id,job.requestId);
        await pause();child=this.jobs.get(child.id,job.actor.id);
        if(!this.jobs.resources().available){job=this.get(job.id,job.actor.id);job.state='cancelling';job.reason={code:'worker-stop-uncertain',message:'Child service unavailable or physical stop unconfirmed; parent admission retained.'};this.save(job);throw new Error(job.reason.message);}
      }
      job=this.get(job.id,job.actor.id);const sample=job.samples.find(s=>s.au===au)!;
      sample.state=['unsupported-source','unsupported-format','incompatible-input','missing-color'].includes(child.reason?.code??'')?'unsupported':child.state;sample.reason=child.reason;
      if(child.state==='completed'){const result=this.jobs.result(child.id,job.actor.id);sample.result={attemptId:result.attemptId,digest:child.result.digest!};results.push(result);job.summary=aggregateRange(results);}
      this.save(job);
    }
    job=this.get(job.id,job.actor.id);
    job.state=this.closed?'interrupted':job.cancelRequestedAt!==null?'cancelled':job.summary.scoredPairs===job.plan.selectedAus.length?'completed':job.summary.scoredPairs?'partial':'failed';
    if(this.now()>=deadline)job.reason={code:'range-deadline',message:'Total range elapsed deadline reached; remaining positions are holes.'};
    if(this.closed)job.reason={code:'service-shutdown',message:'Service stopped after the active child physically exited; no automatic retry.'};
    else if(job.cancelRequestedAt!==null)job.reason={code:'cancelled',message:'Explicit cancellation completed after the active child physically exited.'};
    job.endedAt=this.now();this.save(job);
  }
  results(id:string,actor:string,after=0,limit:number=LIMITS.page){
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>LIMITS.page)throw new AdminError(400,'Invalid result cursor.','invalid-cursor');
    const job=this.get(id,actor),samples=job.samples.filter(s=>s.state==='completed'&&s.au>=after);
    const entries=samples.slice(0,limit).map(s=>({au:s.au,result:this.jobs.result(s.jobId,actor)}));
    return {entries,nextAu:samples.length>limit?entries.at(-1)!.au+1:null,coverage:this.coverage(job),summary:job.summary};
  }
  publish(id:string,actor:Actor,policyValue:unknown,origin:string,annotations:AnnotationStore,requestId:string){
    const job=this.get(id,actor.id);
    if(!terminalRange(job.state))throw new AdminError(409,'Wait for a terminal range before publishing.','range-not-terminal');
    let policy:RangeCandidatePolicy;try{policy=rangeCandidatePolicy(policyValue);}catch(e){throw new AdminError(400,(e as Error).message,'invalid-candidate-policy');}
    const row=this.db.prepare('SELECT body FROM quality_range_publications WHERE range_id=?').get(id);let publication:Publication;
    if(row){publication=JSON.parse(String(row.body));if(digest(publication.policy)!==digest(policy))throw new AdminError(409,'Publication already binds another policy.','publication-conflict');}
    else{
      const results=job.samples.filter(s=>s.state==='completed').map(s=>({au:s.au,result:this.jobs.result(s.jobId,actor.id)}));
      publication={policy,origin,createdIds:[],selected:selectRangeCandidates(results,policy).map(x=>{const sample=job.samples.find(s=>s.au===x.au)!;return {au:x.au,id:randomUUID(),operationId:randomUUID(),evidence:{jobId:sample.jobId,attemptId:sample.result!.attemptId,digest:sample.result!.digest,side:policy.side}};})};
      // Freeze the entire decision before the first annotation transaction.
      this.db.prepare('INSERT INTO quality_range_publications VALUES(?,?)').run(id,JSON.stringify(publication));
    }
    for(const item of publication.selected){
      annotations.mutate(policy.space,{operationId:item.operationId,id:item.id,revision:0,action:'create-quality-candidate',candidate:{text:policy.text,severity:policy.severity},evidence:item.evidence,client:{kind:'agent',id:`range_${id}`}},actor,requestId,{
        origin:publication.origin,resolve:ref=>{const child=this.jobs.get(ref.jobId,actor.id);if(child.state!=='completed'||child.attempt?.id!==ref.attemptId||child.result.digest!==ref.digest)throw new AdminError(409,'Immutable result unavailable.','evidence-unavailable');return this.jobs.result(ref.jobId,actor.id);}
      });
      if(!publication.createdIds.includes(item.id)){publication.createdIds.push(item.id);this.db.prepare('UPDATE quality_range_publications SET body=? WHERE range_id=?').run(JSON.stringify(publication),id);}
    }
    return {...publication,assessment:'not-subjectively-assessed',ranking:'finite-psnr-db-ascending-reference-au-ties',coverage:this.coverage(job)};
  }
  publication(id:string,actor:string){this.get(id,actor);const row=this.db.prepare('SELECT body FROM quality_range_publications WHERE range_id=?').get(id);return row?JSON.parse(String(row.body)) as Publication:null;}
  close(){return this.closing??=(async()=>{this.closed=true;await this.active;if(this.fatal)throw this.fatal;for(const j of this.rows())if(!terminalRange(j.state)){j.state='interrupted';j.endedAt=this.now();j.reason={code:'service-shutdown',message:'Service stopped before execution; no automatic retry.'};this.save(j);}this.db.close();this.unlock();})();}
}
