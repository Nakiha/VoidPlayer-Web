import type {LibraryPairBinding} from './library-pair.ts';
import {canonicalJson} from './correspondence.ts';

export const REEXECUTION_LIMITS=Object.freeze({requestBytes:8192,reason:500,chain:32,page:8,maxElapsedMs:30000,maxReadBytes:64*1024*1024,maxIndexBytes:64*1024*1024,maxIndexPackets:1000000});
export type ReexecutionKind='single'|'range'|'vmaf';
/** Each job still owns at most one attempt. Generation counts new jobs, not
 * restarts of an attempt. No old result or annotation is replaced. */
export type ReexecutionLineage={schema:'voidplayer-quality-reexecution-lineage';version:1;retryOf:string;rootJobId:string;generation:number;reason:string;planDigest:string;requestedAt:number};
export type ExecutionEnvironment={schema:'voidplayer-quality-execution-environment';version:1;runtime:'node'|'bun';runtimeVersion:string;recipe:'source-yuv-psnr-ssim-packet-identity-v1';assets:{file:string;sha256:string;bytes:number}[]};
export type QualityExecutionContract={schema:'voidplayer-quality-execution-contract';version:1;environment:ExecutionEnvironment;sources:LibraryPairBinding[];native?:{manifestSha256:string;binarySha256:string;modelSha256:string;supervisorSha256:string;sourceRevision:string;model:string;recipe:'official-vmaf-one-thread-no-preprocessing-v1'}};
export type ReexecutionMetadata={executionContract?:QualityExecutionContract;retryOf?:ReexecutionLineage};
export type ReexecutionPreflight={schema:'voidplayer-quality-reexecution-preflight';version:1;contract:QualityExecutionContract;indexBytes:number;indexPackets:number;assetBytes:number};
export function canonicalExecutionSources(sources:LibraryPairBinding[]){return [...new Map(sources.map(s=>[canonicalJson(s),s])).entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,s])=>s);}
export type ReexecutionCost={scope:'entire-frozen-input-from-start';selectedPairs:number;reusesPreviousScores:false;budget:Record<string,number>;reservation:Record<string,unknown>};
export type ReexecutionPlan={schema:'voidplayer-quality-reexecution-plan';version:1;kind:ReexecutionKind;jobId:string;state:string;revision:number;reason:string;eligible:boolean;blocks:{code:string;message:string;next:'wait-and-replan'|'new-intent'|'observe-original'}[];digest:string|null;cost:ReexecutionCost;previous:{reason:unknown;result:unknown};lineage:ReexecutionLineage|null;contract:QualityExecutionContract|null;inputDigest:string;next:{plan:string;execute:string;chain:string}};
export type ReexecutionRequest={schema:'voidplayer-quality-reexecution';version:1;reason:string;planDigest:string;confirm:ReexecutionCost};
export function reexecutionReason(value:unknown){
  if(typeof value!=='string'||!value.trim()||value.length>REEXECUTION_LIMITS.reason)throw Error('Provide an explicit bounded reason for new computation');
  return value.trim();
}
export function reexecutionRequest(value:unknown):ReexecutionRequest{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['schema','version','reason','planDigest','confirm'].includes(k)))throw Error('Invalid reexecution fields');
  const v=value as ReexecutionRequest;
  if(v.schema!=='voidplayer-quality-reexecution'||v.version!==1||typeof v.planDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.planDigest)||!v.confirm||v.confirm.scope!=='entire-frozen-input-from-start'||v.confirm.reusesPreviousScores!==false)throw Error('Confirm the exact full recomputation plan and cost');
  return structuredClone({...v,reason:reexecutionReason(v.reason)});
}
export const sameExecutionContract=(a:QualityExecutionContract,b:QualityExecutionContract)=>canonicalJson(a)===canonicalJson(b);
export function reexecutionPath(kind:ReexecutionKind,id:string){return kind==='single'?`/api/quality/jobs/${id}`:kind==='range'?`/api/quality/ranges/${id}`:`/api/quality/vmaf/jobs/${id}`;}
export function nextReexecutionLineage(id:string,old:ReexecutionLineage|undefined,reason:string,planDigest:string,requestedAt:number):ReexecutionLineage{
  const generation=(old?.generation??1)+1;
  if(generation>REEXECUTION_LIMITS.chain)throw Error('Explicit execution chain budget is full; use a new intent');
  return {schema:'voidplayer-quality-reexecution-lineage',version:1,retryOf:id,rootJobId:old?.rootJobId??id,generation,reason,planDigest,requestedAt};
}
