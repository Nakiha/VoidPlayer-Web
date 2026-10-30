import {assertJobReceipt} from './frozen-submission.ts';
import type {FrozenSubmission} from './frozen-submission.ts';
import {referenceRelationInput,correspondenceInput,normalizeCorrespondenceInput} from '../../shared/analysis/quality/correspondence.ts';
import type {ReferenceRelation,CorrespondencePlan} from '../../shared/analysis/quality/correspondence.ts';
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v);
const text=(v:unknown)=>typeof v==='string'&&v.length>0;
const time=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const fail=():never=>{throw Error('Incomplete correspondence acknowledgement; retain the original request');};
function relationReceipt(r:ReferenceRelation,owner:string){
 if(!r||!uuid(r.id)||r.actor?.id!==owner||!text(r.actor.name)||!text(r.key)||!text(r.requestId)||r.revision!==1||!time(r.createdAt)||r.assessment!=='caller-declared-not-content-certified')fail();
 referenceRelationInput(r.input);
}
/** Validate durable acceptance independently of whichever plan is on screen. */
export function assertCorrespondenceReceipt(value:unknown,owner:string,pending:FrozenSubmission<unknown>,kind:'relation'|'plan'){
 assertJobReceipt(value,owner,pending,kind==='plan'?normalizeCorrespondenceInput(pending.body):referenceRelationInput(pending.body),kind);
 const envelope=value as {relation?:ReferenceRelation;plan?:CorrespondencePlan};
 if(kind==='relation'){relationReceipt(envelope.relation!,owner);return;}
 const p=envelope.plan!;correspondenceInput(p.input);
 if(!uuid(p.id)||!text(p.actor?.name)||!text(p.requestId)||!time(p.createdAt)||!Number.isSafeInteger(p.revision)||p.revision<1||!['queued','running','cancelling','completed','blocked','failed','cancelled','interrupted'].includes(p.state)
  ||!(p.startedAt===null||time(p.startedAt))||!(p.endedAt===null||time(p.endedAt))||!(p.attemptId===null||uuid(p.attemptId))
  ||!(p.resultDigest===null||typeof p.resultDigest==='string'&&/^[a-f0-9]{64}$/.test(p.resultDigest))||!(p.reason===null||text(p.reason?.code)&&text(p.reason?.message)))fail();
 relationReceipt(p.relation,owner);
 if(p.relation.id!==p.input.relation.id||p.relation.revision!==p.input.relation.revision)fail();
}
