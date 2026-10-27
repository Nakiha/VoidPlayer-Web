import {ReexecutionLedger} from '../quality/reexecution-ledger.ts';
import type {ReexecutionCreation} from '../quality/reexecution-ledger.ts';
import type {QualityExecutionContract,ReexecutionRequest} from '../../../shared/analysis/quality/reexecution.ts';
import {sameExecutionContract} from '../../../shared/analysis/quality/reexecution.ts';
import {createHash,randomUUID} from 'node:crypto';import {mkdirSync,rmSync} from 'node:fs';import path from 'node:path';
import {openIndexDatabase} from '../../sqlite.ts';import {lockDatabase} from '../../library-store.ts';import {AdminError} from '../../admin-error.ts';
import type {Actor} from '../../identity.ts';import type {CorrespondenceService} from '../quality/correspondence-service.ts';
import {qualityIdempotencyKey} from '../quality/job-request.ts';import {qualityEvidenceValue} from '../../../shared/review/quality-evidence.ts';
import type {QualityEvidenceRef} from '../../../shared/review/quality-evidence.ts';import type {QualityJobResult} from '../../../shared/analysis/quality/jobs.ts';
import type {AnnotationStore} from '../../annotations.ts';
import {vmafInput,canonicalJson,vmafSequenceFrame,VMAF_LIMITS,terminalVmaf,VmafError} from '../../../shared/analysis/quality/vmaf.ts';
import type {VmafInput,VmafJob,VmafResult,VmafPlanSnapshot,VmafPrepared,VmafAssociation} from '../../../shared/analysis/quality/vmaf.ts';
import {NativeVmafRunner,stopOwnedNative} from './runner.ts';
const digest=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const now=()=>Math.floor(performance.timeOrigin+performance.now());
const waiting=()=>({state:'waiting' as const,reason:null});
const reason=(error:unknown)=>({code:typeof (error as {code?:unknown})?.code==='string'?String((error as {code:string}).code):'execution-failed',message:error instanceof Error?error.message.slice(0,300):'VMAF execution failed'});
type Publication={policy:CandidatePolicy;selected:{index:number;id:string;operationId:string;ref:QualityEvidenceRef}[];createdIds:string[]};
type CandidatePolicy={space:string;side:'reference'|'distorted';maxScore:number;limit:number;minFrameDistance:number;text:string;severity:number};
/** Separate metric outcomes, one service-owned attempt, no automatic retry/work sharing. */
export class NativeVmafService{
 readonly reexecutions:ReexecutionLedger;
 private db:ReturnType<typeof openIndexDatabase>;private unlock:()=>void;readonly ready:Promise<void>;
 private recovered=false;private closed=false;private fatal:unknown;private active?:{id:string;controller:AbortController;done:Promise<void>};private timer?:ReturnType<typeof setTimeout>;private closing?:Promise<void>;
 private file:string;private runner:NativeVmafRunner;private plans:CorrespondenceService;
 constructor(file:string,runner:NativeVmafRunner,plans:CorrespondenceService){
  this.file=file;this.runner=runner;this.plans=plans;mkdirSync(path.dirname(file),{recursive:true});this.unlock=lockDatabase(file);
  let db:ReturnType<typeof openIndexDatabase>|undefined;
  try{this.db=db=openIndexDatabase(file);db.exec('PRAGMA busy_timeout=0;');if(Number(db.prepare('PRAGMA user_version').get()!.user_version)>2)throw new AdminError(409,'VMAF history requires a newer application.','future-vmaf-schema');
   db.exec(`PRAGMA journal_mode=WAL;BEGIN IMMEDIATE;CREATE TABLE IF NOT EXISTS quality_vmaf_jobs(id TEXT PRIMARY KEY,actor TEXT NOT NULL,client TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,snapshot TEXT NOT NULL,prepared TEXT,result TEXT,reserved INTEGER NOT NULL,UNIQUE(actor,client,key));CREATE TABLE IF NOT EXISTS quality_vmaf_publications(job_id TEXT PRIMARY KEY,body TEXT NOT NULL);`);this.reexecutions=new ReexecutionLedger(db);db.exec('PRAGMA user_version=2;COMMIT;');
  }catch(error){db?.close();this.unlock();throw error;}
  this.ready=this.recover();void this.ready.catch(error=>{this.fatal=error;});
 }
 private async recover(){
  for(const job of this.all())if(!terminalVmaf(job.state)){
   if(job.process)await stopOwnedNative(job.process);
   job.state='interrupted';job.phase='done';job.endedAt=now();job.process=null;job.reason={code:'service-restarted',message:'Previous execution interrupted; completed companion facts retained without retry.'};
   for(const m of Object.values(job.metrics))if(['waiting','running'].includes(m.state)){m.state='interrupted';m.reason=job.reason;}
   this.finish(job,null);
  }
  // Exactly one prior executor could own raw files. No new work starts before
  // every durably recorded supervisor above has physically exited.
  rmSync(this.file.replace(/\.quality-vmaf\.sqlite$/,'.vmaf-tmp'),{recursive:true,force:true});this.recovered=true;
 }
 private available(){if(this.closed||this.fatal||!this.recovered||this.runner.stopUncertain)throw new AdminError(503,'VMAF service unavailable or recovering.','vmaf-service-unavailable');}
 private all(){return this.db.prepare('SELECT body FROM quality_vmaf_jobs ORDER BY rowid').all().map(r=>JSON.parse(String(r.body)) as VmafJob);}
 private save(job:VmafJob){job.revision++;this.db.prepare('UPDATE quality_vmaf_jobs SET body=? WHERE id=?').run(JSON.stringify(job),job.id);}
 get(id:string,actor:string){const row=this.db.prepare('SELECT body,fingerprint FROM quality_vmaf_jobs WHERE id=? AND actor=?').get(id,actor);if(!row)throw new AdminError(404,'VMAF job not found.','vmaf-not-found');const job=JSON.parse(String(row.body)) as VmafJob;if(digest(job.input)!==row.fingerprint)throw new AdminError(500,'Stored VMAF request changed.','stored-vmaf-invalid');return job;}
 history(actor:string,after=0,limit=8){if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>16)throw new AdminError(400,'Invalid VMAF cursor.','invalid-cursor');const rows=this.db.prepare('SELECT rowid,body FROM quality_vmaf_jobs WHERE actor=? AND rowid>? ORDER BY rowid LIMIT ?').all(actor,after,limit+1);return {entries:rows.slice(0,limit).map(r=>JSON.parse(String(r.body))),after:rows.length?Number(rows[Math.min(limit,rows.length)-1].rowid):after,more:rows.length>limit};}
 private parse(value:unknown){try{return vmafInput(value);}catch(error){throw new AdminError(400,(error as Error).message,'invalid-vmaf-request');}}
 private snapshot(input:VmafInput,actor:string):VmafPlanSnapshot{
  const plan=this.plans.get(input.plan.id,actor);if(plan.state!=='completed'||plan.attemptId!==input.plan.attemptId||plan.resultDigest!==input.plan.digest)throw new AdminError(409,'Pin a completed correspondence attempt/digest.','vmaf-plan-changed');
  return {...input.plan,value:this.plans.result(plan.id,actor)};
 }
 private cachedCapability:Awaited<ReturnType<NativeVmafRunner['capability']>>|null=null;private capabilityCheckedAt=0;
 get descriptor(){return this.cachedCapability?{...this.cachedCapability,checkedAt:this.capabilityCheckedAt}:null;}
 async capability(){const value=await this.runner.capability();if(value.reason==='quality-busy'&&this.cachedCapability)return {...this.descriptor!,verification:'deferred-admission-busy'};this.cachedCapability=value;this.capabilityCheckedAt=now();return {...this.descriptor!,verification:'checked'};}
 async preflight(value:unknown,actor:string,signal:AbortSignal){this.available();const input=this.parse(value);return this.runner.preflight(input,this.snapshot(input,actor),signal);}
 submit(value:unknown,actor:Actor,requestId:string,key:unknown,reexecution?:ReexecutionCreation){
  this.available();const input=this.parse(value),k=qualityIdempotencyKey(key),fingerprint=digest(input);
  this.db.exec('BEGIN IMMEDIATE');let accepted:{job:VmafJob;replayed:boolean};try{accepted=(()=>{
  if(reexecution){const prior=this.reexecutions.replay(reexecution.parentId,actor.id,reexecution.key,reexecution.request);if(prior)return {job:this.reexecutions.verify(prior,this.get(prior.jobId,actor.id)),replayed:true};const parent=this.get(reexecution.parentId,actor.id);if(parent.revision!==reexecution.parentRevision||!['failed','partial','interrupted','cancelled'].includes(parent.state)||parent.endedAt===null||parent.process)throw new AdminError(409,'Original native execution has not physically stopped.','reexecution-blocked');}
  const prior=this.db.prepare('SELECT id,fingerprint FROM quality_vmaf_jobs WHERE actor=? AND client=? AND key=?').get(actor.id,input.client.id,k);
  if(prior){if(prior.fingerprint!==fingerprint)throw new AdminError(409,'VMAF key binds a different recipe.','idempotency-conflict');return {job:this.get(String(prior.id),actor.id),replayed:true};}
  if(process.platform!=='linux'||process.arch!=='x64'||!this.runner.config)throw new AdminError(503,'Install a trusted Linux x64 VMAF component first.','component-unavailable');
  const snapshot=this.snapshot(input,actor.id),all=this.all(),live=all.filter(j=>!terminalVmaf(j.state));
  if(live.length>=VMAF_LIMITS.queued||live.filter(j=>j.actor.id===actor.id).length>=VMAF_LIMITS.actorOutstanding)throw new AdminError(429,'VMAF bounded queue is full.','vmaf-queue-full');
  const reserved=8*1024*1024,used=Number(this.db.prepare('SELECT coalesce(sum(reserved),0) AS n FROM quality_vmaf_jobs').get()!.n);
  if(all.length>=VMAF_LIMITS.historyRows||used+reserved>VMAF_LIMITS.reservedBytes)throw new AdminError(429,'VMAF history budget is full; old receipts retained.','vmaf-history-full');
  const createdAt=now(),job:VmafJob={...(reexecution?{executionContract:reexecution.contract,retryOf:reexecution.lineage}:{}),schema:'voidplayer-native-vmaf-job-state',version:1,id:'vmaf-'+randomUUID(),actor:{id:actor.id,name:actor.name},key:k,requestId,input,revision:1,createdAt,queueUntil:createdAt+VMAF_LIMITS.queueWaitMs,startedAt:null,endedAt:null,attemptId:null,state:'queued',phase:'queued',reason:null,progress:{preparedFrames:0,targetFrames:snapshot.value.rangePlan?.input.pairs.length??0},metrics:{psnr:waiting(),ssim:input.metrics.ssim?waiting():{state:'not-requested',reason:null},vmaf:waiting()},resultDigest:null,process:null};
  this.db.prepare('INSERT INTO quality_vmaf_jobs VALUES(?,?,?,?,?,?,?,NULL,NULL,?)').run(job.id,actor.id,input.client.id,k,fingerprint,JSON.stringify(job),JSON.stringify(snapshot),reserved);if(reexecution)this.reexecutions.insert({actorId:actor.id,parentId:reexecution.parentId,jobId:job.id,key:reexecution.key,request:reexecution.request,lineage:reexecution.lineage});return {job:this.get(job.id,actor.id),replayed:false};
  })();this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}if(!accepted.replayed)this.pump();return {...accepted,job:this.get(accepted.job.id,actor.id)};
 }
 reexecutionReceipt(id:string,actor:string,key?:string,request?:ReexecutionRequest){this.get(id,actor);const receipt=key&&request?this.reexecutions.replay(id,actor,key,request):this.reexecutions.get(id,actor);if(receipt)this.reexecutions.verify(receipt,this.get(receipt.jobId,actor));return receipt;}
 frozenSnapshot(id:string,actor:string){const job=this.get(id,actor),snapshot=JSON.parse(String(this.db.prepare('SELECT snapshot FROM quality_vmaf_jobs WHERE id=?').get(id)!.snapshot)) as VmafPlanSnapshot;if(snapshot.id!==job.input.plan.id||snapshot.attemptId!==job.input.plan.attemptId||snapshot.digest!==job.input.plan.digest||digest(snapshot.value)!==snapshot.digest)throw new AdminError(409,'Frozen VMAF C plan snapshot changed.','stored-input-invalid');return snapshot;}
 async reexecutionPreflight(id:string,actor:string,expected:QualityExecutionContract,signal:AbortSignal){await this.ready;this.available();const job=this.get(id,actor);const stored=this.frozenSnapshot(id,actor);const current=this.snapshot(job.input,actor);if(canonicalJson(stored)!==canonicalJson(current))throw new AdminError(409,'Frozen C plan changed; use a new intent.','vmaf-plan-changed');return this.runner.reexecutionPreflight(job.input,stored,expected,signal);}
 reexecute(creation:ReexecutionCreation,actor:Actor,requestId:string){this.available();const original=this.get(creation.parentId,actor.id);return this.submit(original.input,actor,requestId,'reexecution:'+randomUUID(),creation);}
 private wake(){if(this.timer||this.closed||this.fatal||!this.all().some(j=>j.state==='queued'))return;this.timer=setTimeout(()=>{this.timer=undefined;this.pump();},250);this.timer.unref();}
 private pump(){
  if(this.active||this.closed||this.fatal||!this.recovered)return;
  for(const j of this.all().filter(j=>j.state==='queued'&&j.queueUntil<=now())){j.reason={code:'queue-expired',message:'VMAF queue deadline exceeded before execution'};j.state='failed';j.phase='done';j.endedAt=now();for(const m of Object.values(j.metrics))if(m.state==='waiting'){m.state='failed';m.reason=j.reason;}this.finish(j,null);}
  const job=this.all().find(j=>j.state==='queued');if(!job)return;
  const active={id:job.id,controller:new AbortController(),done:Promise.resolve()};this.active=active;
  active.done=this.execute(job.id,active.controller.signal).catch(error=>{this.fatal=error;console.error('VMAF service stopped; durable history retained.');}).finally(()=>{if(this.active===active)this.active=undefined;this.wake();});
 }
 private prepared(id:string){const row=this.db.prepare('SELECT prepared FROM quality_vmaf_jobs WHERE id=?').get(id);return row?.prepared?JSON.parse(String(row.prepared)) as VmafPrepared:null;}
 private validatePrepared(value:VmafPrepared,snapshot:VmafPlanSnapshot,input:VmafInput){
  if(!value||value.pairs.length<2||value.pairs.length>VMAF_LIMITS.frames||canonicalJson(value.sequence.pairs)!==canonicalJson([...snapshot.value.rangePlan!.input.pairs].sort((a,b)=>a.reference.sourcePtsUs-b.reference.sourcePtsUs))||value.sequence.cadenceUs!==input.cadenceUs)throw new VmafError('worker-result-invalid','Prepared sequence identity changed');
  if(value.pairs.length!==value.sequence.pairs.length||value.geometry.width<VMAF_LIMITS.minDimension||value.geometry.height<VMAF_LIMITS.minDimension||value.geometry.width>VMAF_LIMITS.width||value.geometry.height>VMAF_LIMITS.height||![8,10].includes(value.geometry.bitDepth)||value.raw.bytes!==value.geometry.width*value.geometry.height*3/2*(value.geometry.bitDepth===8?1:2)*value.pairs.length*2||[value.raw.referenceSha256,value.raw.distortedSha256].some(h=>!/^[a-f0-9]{64}$/.test(h)))throw new VmafError('worker-result-invalid','Prepared raw frame count/geometry differs');
  for(const [index,pair]of value.pairs.entries()){qualityEvidenceValue(pair);const expected=value.sequence.pairs[index];if(canonicalJson(pair.result.metric.roi)!==canonicalJson(expected.roi)||pair.result.metric.bitDepth!==value.geometry.bitDepth||!!pair.result.ssim!==input.metrics.ssim)throw new VmafError('worker-result-invalid','Prepared metric recipe changed');for(const side of ['reference','distorted']as const){const p=pair.result.provenance[side],e=expected[side];for(const field of ['mediaId','mediaVersion','size','indexIdentity','indexBuildId','sourcePtsUs','picture','decode']as const)if(canonicalJson(p[field])!==canonicalJson(e[field]))throw new VmafError('worker-result-invalid','Prepared source/picture identity changed');}}
  const budget=snapshot.value.rangePlan!.input.budget;if(value.work.readBytes>budget.maxReadBytes||value.work.packets>budget.maxPackets||value.work.outputFrames>budget.maxOutputFrames||value.work.inputBytes>budget.maxInputBytes)throw new VmafError('worker-result-invalid','Prepared work exceeds frozen total budget');
  if(value.raw.bytes>input.budget.maxRawBytes||Buffer.byteLength(JSON.stringify(value))>VMAF_LIMITS.resultBytes)throw new VmafError('budget-exceeded','Prepared sequence result budget exceeded');
 }
 private async execute(id:string,signal:AbortSignal){
  let j=this.get(id,this.all().find(x=>x.id===id)!.actor.id);const snapshot=JSON.parse(String(this.db.prepare('SELECT snapshot FROM quality_vmaf_jobs WHERE id=?').get(id)!.snapshot)) as VmafPlanSnapshot;
  try{
   const value=await this.runner.run(j.input,snapshot,signal,{
    expectedExecutionContract:j.executionContract,
    contract:contract=>{j=this.get(id,j.actor.id);if(Buffer.byteLength(JSON.stringify(contract))>16*1024||j.executionContract&&!sameExecutionContract(j.executionContract,contract))throw new AdminError(409,'Frozen native execution contract changed.','execution-contract-conflict');if(!j.executionContract){j.executionContract=contract;this.save(j);}},
    admitted:()=>{j=this.get(id,j.actor.id);if(j.state!=='queued'||j.queueUntil<=now())throw new VmafError('queue-expired','VMAF queue changed before admission');j.state='preparing';j.phase='component';j.startedAt=now();j.attemptId=randomUUID();j.metrics.psnr.state='running';if(j.input.metrics.ssim)j.metrics.ssim.state='running';this.save(j);},
    phase:phase=>{j=this.get(id,j.actor.id);j.phase=phase;if(phase==='native'){j.state='running';j.metrics.vmaf.state='running';}this.save(j);},
    progress:(frames,total)=>{j=this.get(id,j.actor.id);j.progress={preparedFrames:frames,targetFrames:total};this.save(j);},
    prepared:value=>{this.validatePrepared(value,snapshot,j.input);j=this.get(id,j.actor.id);j.metrics.psnr={state:'completed',reason:null};if(j.input.metrics.ssim)j.metrics.ssim={state:'completed',reason:null};this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('UPDATE quality_vmaf_jobs SET prepared=? WHERE id=?').run(JSON.stringify(value),id);this.save(j);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}},
    process:process=>{j=this.get(id,j.actor.id);j.process=process;this.save(j);}
   });
   j=this.get(id,j.actor.id);j.metrics.vmaf={state:'completed',reason:null};j.state=j.state==='cancelling'?'cancelled':'completed';j.reason=null;j.phase='done';j.endedAt=now();this.finish(j,value.native);
  }catch(error){
   if(this.runner.stopUncertain)throw error;
   j=this.get(id,j.actor.id);if(terminalVmaf(j.state))return;if(!j.attemptId&&error instanceof AdminError&&error.code==='quality-busy')return;
   j.reason=reason(error);const cancelled=j.state==='cancelling'||signal.aborted;
   for(const m of Object.values(j.metrics))if(['waiting','running'].includes(m.state)){m.state=this.closed?'interrupted':cancelled?'cancelled':'failed';m.reason=j.reason;}
   j.state=this.closed?'interrupted':cancelled?'cancelled':this.prepared(j.id)?'partial':'failed';j.phase='done';j.process=null;j.endedAt=now();this.finish(j,null);
  }
 }
 private finish(job:VmafJob,native:VmafResult['vmaf']){
  const prepared=this.prepared(job.id);let result:VmafResult|null=null;
  if(prepared){result={schema:'voidplayer-native-vmaf-result',version:prepared.pairs[0].version,plan:{...job.input.plan},prepared,vmaf:native,metrics:structuredClone(job.metrics)};if(Buffer.byteLength(JSON.stringify(result))>VMAF_LIMITS.resultBytes)throw new VmafError('budget-exceeded','VMAF result history limit exceeded');job.resultDigest=digest(result);}
  this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('UPDATE quality_vmaf_jobs SET result=?,prepared=NULL WHERE id=?').run(result?JSON.stringify(result):null,job.id);this.save(job);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 cancel(id:string,actor:string){this.available();const j=this.get(id,actor);if(terminalVmaf(j.state))return j;
  if(j.state==='queued'){if(this.active?.id===id)this.active.controller.abort(new VmafError('cancelled','VMAF cancelled before admission'));j.state='cancelled';j.phase='done';j.endedAt=now();j.reason={code:'cancelled',message:'VMAF cancelled before execution'};for(const m of Object.values(j.metrics))if(m.state==='waiting'){m.state='cancelled';m.reason=j.reason;}this.finish(j,null);}
  else{j.state='cancelling';j.phase='stopping';this.save(j);if(this.active?.id===id)this.active.controller.abort(new VmafError('cancelled','VMAF explicitly cancelled'));}return this.get(id,actor);
 }
 result(id:string,actor:string){const j=this.get(id,actor);const row=this.db.prepare('SELECT result FROM quality_vmaf_jobs WHERE id=?').get(id);if(!row?.result||!j.resultDigest)throw new AdminError(409,'Immutable VMAF result is unavailable.','vmaf-result-unavailable');const value=JSON.parse(String(row.result)) as VmafResult;if(digest(value)!==j.resultDigest)throw new AdminError(500,'Stored VMAF result changed.','stored-vmaf-invalid');return value;}
 summary(id:string,actor:string){const j=this.get(id,actor),r=this.result(id,actor);return {job:j,plan:r.plan,geometry:r.prepared.geometry,sequence:{...r.prepared.sequence,pairs:undefined,clockPairs:r.prepared.sequence.pairs.map(p=>({referenceAu:p.reference.picture.au,distortedAu:p.distorted.picture.au,referencePtsUs:p.reference.sourcePtsUs,distortedPtsUs:p.distorted.sourcePtsUs,offsetUs:p.distorted.sourcePtsUs-p.reference.sourcePtsUs}))},coverage:{scope:'selected-continuous-clip-not-whole-file',targetFrames:r.prepared.pairs.length,preparedFrames:r.prepared.pairs.length,vmafScoredFrames:r.vmaf?.frames.length??0,vmaf:r.vmaf?'complete-selected-clip':'unscored'},raw:r.prepared.raw,work:r.prepared.work,metrics:r.metrics,vmaf:r.vmaf,companionPairs:r.prepared.pairs.length,framesUrl:`/api/quality/vmaf/jobs/${id}/frames`};}
 frames(id:string,actor:string,after=0,limit:number=VMAF_LIMITS.page){if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>VMAF_LIMITS.page)throw new AdminError(400,'Invalid VMAF frame page.','invalid-cursor');const r=this.result(id,actor),indices=r.prepared.pairs.map((_,i)=>i).filter(i=>i>=after);return {entries:indices.slice(0,limit).map(index=>({index,score:r.vmaf?.frames[index]?.score??null,pair:r.prepared.pairs[index],ref:this.ref(id,actor,index,'reference')})),next:indices.length>limit?indices[limit]:null};}
 private ref(id:string,actor:string,index:number,side:'reference'|'distorted'):QualityEvidenceRef{const j=this.get(id,actor);if(!j.attemptId||!j.resultDigest)throw new AdminError(409,'Completed companion unavailable.','vmaf-result-unavailable');return {jobId:`${id}-f${index}`,attemptId:j.attemptId,digest:j.resultDigest,side};}
 evidence(ref:QualityEvidenceRef,actor:string):QualityJobResult{
  const match=/^(vmaf-[a-f0-9-]{36})-f(\d{1,2})$/.exec(ref.jobId);if(!match)throw new AdminError(400,'Invalid VMAF companion reference.','invalid-evidence-reference');
  const j=this.get(match[1],actor);if(!terminalVmaf(j.state)||j.attemptId!==ref.attemptId||j.resultDigest!==ref.digest)throw new AdminError(409,'VMAF companion reference changed.','evidence-unavailable');
  const r=this.result(j.id,actor),index=Number(match[2]),value=structuredClone(r.prepared.pairs[index]);if(!value)throw new AdminError(404,'VMAF frame not found.','vmaf-frame-not-found');
  if(r.vmaf){const association:VmafAssociation={schema:'voidplayer-vmaf-sequence-association',version:value.version,jobId:j.id,attemptId:j.attemptId,resultDigest:j.resultDigest!,plan:r.plan,sequence:{cadenceUs:r.prepared.sequence.cadenceUs,referenceIntegrity:'not-certified',concealmentDetection:'unavailable',pairs:r.prepared.pairs.map(p=>({reference:vmafSequenceFrame(p.result.provenance.reference),distorted:vmafSequenceFrame(p.result.provenance.distorted)}))},index,frames:r.prepared.pairs.length,score:r.vmaf.frames[index].score,pooled:r.vmaf.pooled,component:r.vmaf.component,recipe:r.vmaf.recipe,raw:r.prepared.raw,spatial:'full-frame-temporal-score-not-localized'};(value as typeof value&{sequenceVmaf:VmafAssociation}).sequenceVmaf=association;}
  return {schema:'voidplayer-quality-job-result',version:1,jobId:ref.jobId,attemptId:ref.attemptId,completedAt:j.endedAt!,submitted:{actorId:j.actor.id,actorName:j.actor.name,client:j.input.client,requestId:j.requestId,idempotencyKey:j.key},value};
 }
 private policy(value:unknown):CandidatePolicy{
  const p=value as CandidatePolicy;if(!p||typeof p!=='object'||Object.keys(p).sort().join(',')!=='limit,maxScore,minFrameDistance,severity,side,space,text'||!/^[A-Za-z0-9_-]{1,200}$/.test(p.space)||!['reference','distorted'].includes(p.side)||!Number.isFinite(p.maxScore)||p.maxScore<0||p.maxScore>100||!Number.isInteger(p.limit)||p.limit<1||p.limit>8||!Number.isInteger(p.minFrameDistance)||p.minFrameDistance<1||p.minFrameDistance>32||!Number.isInteger(p.severity)||p.severity<1||p.severity>5||typeof p.text!=='string'||!p.text.trim()||p.text.length>2000)throw new AdminError(400,'Provide explicit VMAF candidate threshold, text, severity and spacing.','invalid-vmaf-policy');return structuredClone(p);
 }
 publication(id:string,actor:string){this.get(id,actor);const row=this.db.prepare('SELECT body FROM quality_vmaf_publications WHERE job_id=?').get(id);return row?JSON.parse(String(row.body)) as Publication:null;}
 publish(id:string,actor:Actor,value:unknown,origin:string,annotations:AnnotationStore,requestId:string){
  this.available();const j=this.get(id,actor.id),policy=this.policy(value);let publication=this.publication(id,actor.id);
  if(publication&&canonicalJson(publication.policy)!==canonicalJson(policy))throw new AdminError(409,'Candidate policy is already frozen.','candidate-policy-conflict');
  if(!publication){const r=this.result(id,actor.id);if(!r.vmaf||j.state!=='completed')throw new AdminError(409,'Completed VMAF result required.','vmaf-result-unavailable');const selected:number[]=[];
   for(const f of [...r.vmaf.frames].sort((a,b)=>a.score-b.score||a.index-b.index))if(f.score<=policy.maxScore&&selected.every(i=>Math.abs(i-f.index)>=policy.minFrameDistance)){selected.push(f.index);if(selected.length===policy.limit)break;}
   publication={policy,selected:selected.map(index=>({index,id:randomUUID(),operationId:randomUUID(),ref:this.ref(id,actor.id,index,policy.side)})),createdIds:[]};this.db.prepare('INSERT INTO quality_vmaf_publications VALUES(?,?)').run(id,JSON.stringify(publication));
  }
  for(const item of publication.selected){
   annotations.mutate(policy.space,{action:'create-quality-candidate',operationId:item.operationId,id:item.id,revision:0,client:{kind:j.input.client.kind==='browser'?'gui':j.input.client.kind==='agent'?'agent':'http',id:'vmaf_'+j.id},evidence:item.ref,candidate:{text:policy.text,severity:policy.severity}},actor,requestId,{origin,resolve:ref=>this.evidence(ref,actor.id)});
   if(!publication.createdIds.includes(item.id)){publication.createdIds.push(item.id);this.db.prepare('UPDATE quality_vmaf_publications SET body=? WHERE job_id=?').run(JSON.stringify(publication),id);}
  }
  return publication;
 }
 close(){return this.closing??=(async()=>{this.closed=true;clearTimeout(this.timer);this.active?.controller.abort(new VmafError('cancelled','VMAF service stopping'));const stop=this.runner.close();await this.active?.done;await stop;await this.ready;if(this.fatal)throw this.fatal;
  for(const j of this.all())if(!terminalVmaf(j.state)){j.state='interrupted';j.phase='done';j.endedAt=now();j.reason={code:'service-shutdown',message:'Service stopped; no automatic retry'};for(const m of Object.values(j.metrics))if(['waiting','running'].includes(m.state)){m.state='interrupted';m.reason=j.reason;}this.finish(j,null);}this.db.close();this.unlock();})();}
}
