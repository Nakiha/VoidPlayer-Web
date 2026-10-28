import type {LibraryPairBinding} from './library-pair.ts';
import {canonicalJson} from './correspondence.ts';

export const REEXECUTION_LIMITS=Object.freeze({requestBytes:8192,planBytes:64*1024,reason:500,chain:32,page:8,maxElapsedMs:30000,maxReadBytes:64*1024*1024,maxProducerBytes:8*1024*1024,maxIndexBytes:64*1024*1024,maxIndexPackets:1000000});
export const REEXECUTION_KINDS=['single','range','vmaf','xpsnr','cambi'] as const;
export type ReexecutionKind=typeof REEXECUTION_KINDS[number];
export const reexecutionKind=(value:string):value is ReexecutionKind=>(REEXECUTION_KINDS as readonly string[]).includes(value);
export const reexecutionId=(kind:ReexecutionKind,id:string)=>new RegExp('^'+(['vmaf','xpsnr','cambi'].includes(kind)?kind+'-':'')+'[a-f0-9-]{36}$').test(id);
export function executionWitnessReservation(kind:ReexecutionKind,pairs:number){const count=kind==='range'?pairs:1,stages=[{stage:'source-contract',passes:count},{stage:'before-core-load',passes:count},...(['vmaf','xpsnr','cambi'].includes(kind)?[{stage:'source-final',passes:1}]:[])];return {passes:stages.reduce((n,s)=>n+s.passes,0),stages,maxCoreAssetBytesPerPass:REEXECUTION_LIMITS.maxReadBytes,maxProducerBytesPerPass:REEXECUTION_LIMITS.maxProducerBytes};}

/** Each job still owns at most one attempt. Generation counts new jobs, not
 * restarts of an attempt. No old result or annotation is replaced. */
export type ReexecutionLineage={schema:'voidplayer-quality-reexecution-lineage';version:1;retryOf:string;rootJobId:string;generation:number;reason:string;planDigest:string;requestedAt:number};
export type ExecutionEnvironment={schema:'voidplayer-quality-execution-environment';version:1;runtime:'node'|'bun';runtimeVersion:string;recipe:'source-yuv-psnr-ssim-packet-identity-v1';producerBuild:{kind:'source-content'|'compiled-content';sha256:string;bytes:number};assets:{file:string;sha256:string;bytes:number}[]};
export type XpsnrExecutionComponent={manifestSha256:string;binarySha256:string;filterSha256:string;supervisorSha256:string;sourceRevision:string;recipe:'ffmpeg-xpsnr-reference-first-temporal-v1'};
export type CambiExecutionComponent={manifestSha256:string;binarySha256:string;supervisorSha256:string;sourceRevision:string;recipe:typeof import('./cambi.ts').CAMBI_RECIPE;selection:{pictures:{au:number;configuration:number;sourcePtsUs:number;decode?:import('./frame-pair.ts').PairTarget['decode']}[];geometry:{width:number;height:number};frameOrder:'source-pts-after-decode-au-selection'|'decode-au-selection';intervalAus:number;unsampled:number;unsupported:number;unsupportedSha256:string}};
export type QualityExecutionContract={schema:'voidplayer-quality-execution-contract';version:1;environment:ExecutionEnvironment;sources:LibraryPairBinding[];native?:{manifestSha256:string;binarySha256:string;modelSha256:string;supervisorSha256:string;sourceRevision:string;model:string;recipe:'official-vmaf-one-thread-no-preprocessing-v1'};nativeXpsnr?:XpsnrExecutionComponent;nativeCambi?:CambiExecutionComponent};
export type ReexecutionMetadata={executionContract?:QualityExecutionContract;retryOf?:ReexecutionLineage};
export type ReexecutionPreflight={schema:'voidplayer-quality-reexecution-preflight';version:1;contract:QualityExecutionContract;indexBytes:number;indexPackets:number;assetBytes:number};
export function canonicalExecutionSources(sources:LibraryPairBinding[]){return [...new Map(sources.map(s=>[canonicalJson(s),s])).entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,s])=>s);}
export type ReexecutionCost={scope:'entire-frozen-input-from-start';selectedPairs:number;selectedPictures?:number;reusesPreviousScores:false;budget:Record<string,number>;reservation:Record<string,unknown>};
export type ReexecutionPlan={schema:'voidplayer-quality-reexecution-plan';version:1;kind:ReexecutionKind;jobId:string;state:string;revision:number;reason:string;eligible:boolean;blocks:{code:string;message:string;next:'wait-and-replan'|'new-intent'|'observe-original'}[];digest:string|null;cost:ReexecutionCost;previous:{reason:unknown;result:unknown};lineage:Omit<ReexecutionLineage,'requestedAt'>|null;correspondence?:{id:string;attemptId:string;digest:string}|null;contract:QualityExecutionContract|null;inputDigest:string;next:{plan:string;execute:string;chain:string}};
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
export function reexecutionPath(kind:ReexecutionKind,id:string){return kind==='single'?`/api/quality/jobs/${id}`:kind==='range'?`/api/quality/ranges/${id}`:`/api/quality/${kind}/jobs/${id}`;}
export function nextReexecutionLineage(id:string,old:ReexecutionLineage|undefined,reason:string,planDigest:string,requestedAt:number):ReexecutionLineage{
  if(old&&(!Number.isSafeInteger(old.generation)||old.generation<2||old.generation>REEXECUTION_LIMITS.chain||!old.rootJobId))throw Error('Stored execution lineage is invalid');
  const generation=(old?.generation??1)+1;
  if(generation>REEXECUTION_LIMITS.chain)throw Error('Explicit execution chain budget is full; use a new intent');
  return {schema:'voidplayer-quality-reexecution-lineage',version:1,retryOf:id,rootJobId:old?.rootJobId??id,generation,reason,planDigest,requestedAt};
}
