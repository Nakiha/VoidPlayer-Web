import {PAIR_LIMITS,FORWARD_PAIR_LIMITS} from './frame-pair.ts';
import {PSNR_LIMITS} from './psnr.ts';
import {clockKey,compareClocks,compareClockSums,clockToUs,normalizeClock} from '../../media/indexing/rational-clock.ts';
import {qualitySourceIndex,qualitySourceClock} from './source-index.ts';
import type {QualityIndexDocument} from './source-index.ts';
import {qualityFrameCandidates,qualityTargetForAu} from './selection.ts';
import {planQualityRange,QUALITY_RANGE_LIMITS} from './ranges.ts';
import type {QualityRangeInput,QualityRangePlan} from './ranges.ts';
import type {FramePairRequest} from './frame-pair.ts';
import type {LibraryPairBinding} from './library-pair.ts';

export const CORRESPONDENCE_LIMITS=Object.freeze({segments:32,requestBytes:128*1024,resultBytes:8*1024*1024,page:32,historyRows:100,reservedBytes:256*1024*1024,planReservation:8*1024*1024,queued:4,actorOutstanding:2,maxIndexBytes:64*1024*1024,maxIndexPackets:500000,maxElapsedMs:30000});
export type RelationSource={mediaId:string;mediaVersion:string;stream:'video';configuration:0};
export type ClockSegment={id:string;referenceStartUs:number;referenceEndUs:number;offsetUs:number;offset?:{ticks:number;timescale:number}};
export const segmentOffset=(segment:ClockSegment)=>segment.offset??{ticks:segment.offsetUs,timescale:1000000};
const microseconds=(ticks:number)=>({ticks,timescale:1000000});
export type ReferenceRelationInput={schema:'voidplayer-quality-reference-relation';version:1;client:QualityRangeInput['client'];reference:RelationSource;distorted:RelationSource;declaration:string;clock:{mode:'piecewise-exact-source-pts-offset';segments:ClockSegment[]}};
export type ReferenceRelation={id:string;actor:{id:string;name:string};requestId:string;key:string;revision:1;createdAt:number;input:ReferenceRelationInput;assessment:'caller-declared-not-content-certified'};
export type CorrespondenceInput={schema:'voidplayer-quality-correspondence-plan';version:1;client:QualityRangeInput['client'];relation:{id:string;revision:1};referenceBuildId:string;distortedBuildId:string;interval:QualityRangeInput['interval'];sampling:QualityRangeInput['sampling'];recipe:Pick<FramePairRequest,'roi'|'spatial'|'ssim'|'budget'>;budget:QualityRangeInput['budget'];planningBudget:{maxIndexBytes:number;maxIndexPackets:number;maxElapsedMs:number}};
export type AuFact={clock?:{basis:'mp4-sample-ticks-v1';trackId:number;timescale:number;sampleOrdinal:number;description:1;dtsTicks:number;ctsTicks:number;durationTicks:number};au:number;ptsUs:number;dtsUs:number;offset:number;bytes:number;key:boolean;configuration:number};
export type CorrespondenceReason='reference-au-missing'|'clock-unmapped'|'reference-pts-ambiguous'|'target-pts-missing'|'target-pts-ambiguous'|'target-au-conflict'|'unsupported-reference'|'unsupported-distorted';
export type CorrespondenceRow={au:number;selected:boolean;reference:AuFact|null;segmentId:string|null;offsetUs:number|null;offset?:{ticks:number;timescale:number};expectedDistortedClock?:string;expectedDistortedPtsUs:number|null;distorted:AuFact|null;status:'mapped'|'unmapped'|'ambiguous'|'unsupported';reason:CorrespondenceReason|null;detail:string|null;matches:number;candidateAus:number[]};
export type CorrespondenceResult={schema:'voidplayer-quality-correspondence-result';version:1;relation:ReferenceRelation;request:CorrespondenceInput;sources:{reference:LibraryPairBinding;distorted:LibraryPairBinding};sourceIssues:{reference:string|null;distorted:string|null};rows:CorrespondenceRow[];rangePlan:QualityRangePlan|null;executionBlock:{code:string;message:string}|null;work:{indexBytes:number;indexPackets:number;sourceReadBytes:0;decodedFrames:0;elapsedMs:number};assessment:'exact-clock-match-not-content-certified'};
export type CorrespondencePlan={id:string;actor:{id:string;name:string};requestId:string;key:string;relation:ReferenceRelation;input:CorrespondenceInput;createdAt:number;startedAt:number|null;endedAt:number|null;attemptId:string|null;state:'queued'|'running'|'cancelling'|'completed'|'blocked'|'failed'|'cancelled'|'interrupted';reason:{code:string;message:string}|null;resultDigest:string|null;revision:number};
export const terminalCorrespondence=(state:CorrespondencePlan['state'])=>!['queued','running','cancelling'].includes(state);
export const canonicalJson=(value:unknown):string=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=(text:string):never=>{throw new Error(text);};
export function correspondenceKeys(value:unknown,allowed:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('Unknown correspondence fields');}
const integer=(n:unknown)=>Number.isSafeInteger(n);
function client(value:ReferenceRelationInput['client']){correspondenceKeys(value,['id','kind']);if(typeof value.id!=='string'||!/^[A-Za-z0-9._:-]{1,80}$/.test(value.id)||!['agent','browser','other'].includes(value.kind))fail('Invalid correspondence client');return {id:value.id,kind:value.kind};}
export function referenceRelationInput(value:unknown):ReferenceRelationInput{
  correspondenceKeys(value,['schema','version','client','reference','distorted','declaration','clock']);const v=structuredClone(value) as ReferenceRelationInput;
  if(v.schema!=='voidplayer-quality-reference-relation'||v.version!==1)fail('Invalid reference relation schema');
  const source=(s:RelationSource)=>{correspondenceKeys(s,['mediaId','mediaVersion','stream','configuration']);if(typeof s.mediaId!=='string'||typeof s.mediaVersion!=='string'||!/^[a-f0-9]{24}$/.test(s.mediaId)||!/^[a-f0-9]{24}$/.test(s.mediaVersion)||s.stream!=='video'||s.configuration!==0)fail('Explicit versioned FLV video sources required');return {mediaId:s.mediaId,mediaVersion:s.mediaVersion,stream:s.stream,configuration:0 as const};};
  correspondenceKeys(v.clock,['mode','segments']);
  if(typeof v.declaration!=='string'||!v.declaration.trim()||v.declaration.length>2000||v.clock.mode!=='piecewise-exact-source-pts-offset'||!Array.isArray(v.clock.segments)||!v.clock.segments.length||v.clock.segments.length>CORRESPONDENCE_LIMITS.segments)fail('Provide a declaration and 1..32 explicit clock segments');
  const ids=new Set<string>(),segments=v.clock.segments.map(s=>{
    correspondenceKeys(s,['id','referenceStartUs','referenceEndUs','offsetUs','offset']);
    if(typeof s.id!=='string'||!/^[A-Za-z0-9._:-]{1,80}$/.test(s.id)||ids.has(s.id)||![s.referenceStartUs,s.referenceEndUs,s.offsetUs].every(integer)||s.referenceEndUs<=s.referenceStartUs)fail('Invalid half-open clock segment');
    const offset=s.offset===undefined?undefined:normalizeClock(s.offset),delta=offset??microseconds(s.offsetUs);
    if(offset&&clockToUs(offset)!==s.offsetUs)fail('Offset microseconds must be the projection of its exact clock');
    clockToUs(microseconds(s.referenceStartUs),delta);clockToUs(microseconds(s.referenceEndUs),delta);
    ids.add(s.id);return {id:s.id,referenceStartUs:s.referenceStartUs,referenceEndUs:s.referenceEndUs,offsetUs:s.offsetUs,...(offset?{offset}:{})};
  }).sort((a,b)=>a.referenceStartUs-b.referenceStartUs||a.id.localeCompare(b.id));
  for(let i=0;i<segments.length;i++)for(let j=0;j<i;j++){
    const a=segments[i],b=segments[j];if(a.referenceStartUs<b.referenceEndUs)fail(`Overlapping reference clock segments: ${b.id}, ${a.id}`);
    if(compareClockSums(microseconds(a.referenceStartUs),segmentOffset(a),microseconds(b.referenceEndUs),segmentOffset(b))<0
      &&compareClockSums(microseconds(b.referenceStartUs),segmentOffset(b),microseconds(a.referenceEndUs),segmentOffset(a))<0)fail(`Overlapping distorted clock segments: ${b.id}, ${a.id}`);
  }
  return {schema:v.schema,version:1,client:client(v.client),reference:source(v.reference),distorted:source(v.distorted),declaration:v.declaration.trim(),clock:{mode:v.clock.mode,segments}};
}
export function correspondenceInput(value:unknown):CorrespondenceInput{
  correspondenceKeys(value,['schema','version','client','relation','referenceBuildId','distortedBuildId','interval','sampling','recipe','budget','planningBudget']);const v=structuredClone(value) as CorrespondenceInput;
  if(v.schema!=='voidplayer-quality-correspondence-plan'||v.version!==1)fail('Invalid correspondence plan schema');
  correspondenceKeys(v.relation,['id','revision']);if(typeof v.relation.id!=='string'||!/^[a-f0-9-]{36}$/.test(v.relation.id)||v.relation.revision!==1)fail('Pin an immutable reference relation revision');
  for(const id of [v.referenceBuildId,v.distortedBuildId])if(typeof id!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/.test(id))fail('Pin both cache builds');
  correspondenceKeys(v.interval,['startAu','endAu']);const {startAu,endAu}=v.interval;if(!integer(startAu)||!integer(endAu)||startAu<0||endAu<startAu||endAu-startAu+1>QUALITY_RANGE_LIMITS.universe)fail('Plan needs 1..4096 reference decode-order AU positions');
  correspondenceKeys(v.sampling,v.sampling?.mode==='stride'?['mode','every','offset']:['mode']);if(v.sampling.mode!=='all'&&(v.sampling.mode!=='stride'||!integer(v.sampling.every)||v.sampling.every<2||v.sampling.every>256||!integer(v.sampling.offset)||v.sampling.offset<0||v.sampling.offset>=v.sampling.every))fail('Invalid deterministic sampling');
  const selected=Array.from({length:endAu-startAu+1},(_,i)=>i).filter(i=>v.sampling.mode==='all'||i%v.sampling.every===v.sampling.offset).length;if(!selected||selected>QUALITY_RANGE_LIMITS.samples)fail('Plan needs 1..1024 selected positions');
  correspondenceKeys(v.recipe,['roi','spatial','ssim','budget']);correspondenceKeys(v.recipe.roi,['x','y','width','height']);const r=v.recipe.roi;if(![r.x,r.y,r.width,r.height].every(n=>integer(n)&&n>=0&&n%2===0)||r.width<2||r.height<2||r.x+r.width>16384||r.y+r.height>16384)fail('Invalid chroma-aligned ROI');
  if(v.recipe.spatial!==undefined)correspondenceKeys(v.recipe.spatial,['blockWidth','blockHeight']);if(v.recipe.ssim!==undefined)correspondenceKeys(v.recipe.ssim,['variant']);
  correspondenceKeys(v.budget,Object.keys(QUALITY_RANGE_LIMITS).filter(k=>k.startsWith('max')));for(const k of ['maxReadBytes','maxPackets','maxOutputFrames','maxInputBytes','maxElapsedMs'] as const)if(!integer(v.budget[k])||v.budget[k]<1||v.budget[k]>QUALITY_RANGE_LIMITS[k])fail(`Invalid range budget.${k}`);
  correspondenceKeys(v.planningBudget,['maxIndexBytes','maxIndexPackets','maxElapsedMs']);for(const k of ['maxIndexBytes','maxIndexPackets','maxElapsedMs'] as const)if(!integer(v.planningBudget[k])||v.planningBudget[k]<1||v.planningBudget[k]>CORRESPONDENCE_LIMITS[k])fail(`Invalid planning budget.${k}`);
  return JSON.parse(canonicalJson({...v,client:client(v.client)}));
}

/** v1 receipt defaults match durable acceptance, without rewriting the frozen wire body. */
export function normalizeCorrespondenceInput(value:unknown):CorrespondenceInput{
 const input=correspondenceInput(value);
 input.recipe.budget={...PAIR_LIMITS,maxPackets:FORWARD_PAIR_LIMITS.maxPackets,maxOutputFrames:FORWARD_PAIR_LIMITS.maxOutputFrames,maxSamples:PSNR_LIMITS.maxSamples,maxInputBytes:PSNR_LIMITS.maxInputBytes,...input.recipe.budget};
 return JSON.parse(canonicalJson(input));
}

/** Exact clock joins over raw cache records; no nearest-frame or content inference. */
export function buildCorrespondence(relation:ReferenceRelation,request:CorrespondenceInput,sources:[LibraryPairBinding&{index:QualityIndexDocument},LibraryPairBinding&{index:QualityIndexDocument}],work:CorrespondenceResult['work']):CorrespondenceResult{
  const admissions:(string|null)[]=[];
  const indexes=sources.map((s,i)=>{const expected=i?relation.input.distorted:relation.input.reference,build=i?request.distortedBuildId:request.referenceBuildId;if(s.binding.mediaId!==expected.mediaId||s.binding.mediaVersion!==expected.mediaVersion||s.binding.indexBuildId!==build)fail('Pinned correspondence source/cache changed');
    const index=qualitySourceIndex(s.index,s.binding.size);let issue:string|null=null;
    try{const page=qualityFrameCandidates(s,s.index,{afterAu:0,limit:1}),roi=request.recipe.roi;if(!page.inspection.supported)issue=page.inspection.reason;if(roi.x+roi.width>page.geometry.width||roi.y+roi.height>page.geometry.height)issue='ROI exceeds admitted visible source geometry';}
    catch(e){if(['unsupported-source','budget-exceeded'].includes((e as {code?:string}).code??''))issue=(e as Error).message;else throw e;}
    admissions.push(issue);return index;});
  const counts=indexes.map(index=>{const m=new Map<number,number[]>();index.packets.forEach((p,au)=>{const list=m.get(p.pts);if(list)list.push(au);else m.set(p.pts,[au]);});return m;});
  const fact=(side:number,au:number):AuFact|null=>{const index=indexes[side],p=index.packets[au],mp4=index.mp4,sample=mp4?.samples[au];return p?{au,ptsUs:p.pts,dtsUs:p.dts,offset:p.offset,bytes:p.size,key:p.key,configuration:p.configuration??0,...(mp4&&sample?{clock:{basis:'mp4-sample-ticks-v1' as const,trackId:mp4.trackId,timescale:mp4.timescale,sampleOrdinal:sample.ordinal,description:sample.description,dtsTicks:sample.dtsTicks,ctsTicks:sample.ctsTicks,durationTicks:sample.durationTicks}}:{})}:null;};
  const exactCounts=indexes.map(index=>{const m=new Map<string,number[]>();index.packets.forEach((_,au)=>{const key=clockKey(qualitySourceClock(index,au));const list=m.get(key)??[];list.push(au);m.set(key,list);});return m;});
  const numberCounts=counts.map(m=>new Map([...m].map(([pts,aus])=>[pts,aus.length])));
  const rows:CorrespondenceRow[]=[],pairs:FramePairRequest[]=[];
  for(let au=request.interval.startAu;au<=request.interval.endAu;au++){
    const reference=fact(0,au),row:CorrespondenceRow={au,selected:request.sampling.mode==='all'||(au-request.interval.startAu)%request.sampling.every===request.sampling.offset,reference,segmentId:null,offsetUs:null,expectedDistortedPtsUs:null,distorted:null,status:'unmapped',reason:null,detail:null,matches:0,candidateAus:[]};rows.push(row);
    if(!reference){row.reason='reference-au-missing';continue;}
    const time=qualitySourceClock(indexes[0],au);
    const segment=relation.input.clock.segments.find(s=>compareClocks(time,{ticks:s.referenceStartUs,timescale:1000000})>=0&&compareClocks(time,{ticks:s.referenceEndUs,timescale:1000000})<0);
    if(!segment){row.reason='clock-unmapped';continue;}row.segmentId=segment.id;row.offsetUs=segment.offsetUs;row.expectedDistortedPtsUs=segment.offset?clockToUs(time,segment.offset):reference.ptsUs+segment.offsetUs;if(segment.offset){row.offset=segment.offset;row.expectedDistortedClock=clockKey(time,segment.offset);}
    if(exactCounts[0].get(clockKey(time))!.length!==1){row.status='ambiguous';row.reason='reference-pts-ambiguous';continue;}
    const matches=exactCounts[1].get(clockKey(time,segmentOffset(segment)))??[];row.matches=matches.length;row.candidateAus=matches.slice(0,4);
    if(!matches.length){row.reason='target-pts-missing';continue;}if(matches.length>1){row.status='ambiguous';row.reason='target-pts-ambiguous';continue;}
    const other=matches[0];row.distorted=fact(1,other);
    if(admissions[0]||admissions[1]){row.status='unsupported';row.reason=admissions[0]?'unsupported-reference':'unsupported-distorted';row.detail=admissions[0]??admissions[1];continue;}
    const a=qualityTargetForAu(sources[0],indexes[0],au,numberCounts[0]),b=qualityTargetForAu(sources[1],indexes[1],other,numberCounts[1]);
    if(!a.target||!b.target){row.status='unsupported';row.reason=!a.target?'unsupported-reference':'unsupported-distorted';row.detail=(!a.target?a.reason:b.reason)??'Unsupported decode window';continue;}
    row.status='mapped';pairs.push({pairing:'caller-specified',reference:a.target,distorted:b.target,...structuredClone(request.recipe)});
  }
  const used=new Map<number,CorrespondenceRow[]>();for(const row of rows)if(row.status==='mapped'){const au=row.distorted!.au,list=used.get(au)??[];list.push(row);used.set(au,list);}for(const list of used.values())if(list.length>1)for(const row of list){row.status='ambiguous';row.reason='target-au-conflict';}
  let rangePlan:QualityRangePlan|null=null,executionBlock:CorrespondenceResult['executionBlock']=null;
  try{rangePlan=planQualityRange({schema:'voidplayer-quality-range',version:1,client:request.client,interval:request.interval,correspondence:{mode:'explicit-au-table'},sampling:request.sampling,pairs:pairs.filter(p=>rows.find(r=>r.au===p.reference.picture.au)!.status==='mapped'),budget:request.budget});}
  catch(e){executionBlock={code:'range-plan-blocked',message:(e as Error).message.slice(0,300)};}
  const {index:ri,...reference}=sources[0],{index:di,...distorted}=sources[1];
  return {schema:'voidplayer-quality-correspondence-result',version:1,relation,request,sources:{reference,distorted},sourceIssues:{reference:admissions[0],distorted:admissions[1]},rows,rangePlan,executionBlock,work,assessment:'exact-clock-match-not-content-certified'};
}
