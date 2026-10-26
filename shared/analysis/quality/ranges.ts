import { pairPacketCount, pairBudget } from './frame-pair.ts';
import type { FramePairRequest, PairTarget } from './frame-pair.ts';
import type { QualityJobInput, QualityJobReason, QualityJobResult } from './jobs.ts';
import type { PsnrStatistics } from './psnr.ts';

export const QUALITY_RANGE_LIMITS = Object.freeze({
  universe:256, samples:64, requestBytes:128*1024,
  historyRows:100, reservedBytes:16*1024*1024, queued:4,
  actorOutstanding:2, page:4,
  maxReadBytes:64*1024*1024, maxPackets:4096,
  maxOutputFrames:4096, maxInputBytes:512*1024*1024,
  maxElapsedMs:120000
});

export type QualityRangeInput = {
  schema:'voidplayer-quality-range'; version:1;
  client:QualityJobInput['client'];
  interval:{startAu:number;endAu:number};
  correspondence:
    | {mode:'explicit-au-table'}
    | {mode:'constant-source-pts-offset';offsetUs:number};
  sampling:{mode:'all'}|{mode:'stride';every:number;offset:number};
  pairs:FramePairRequest[];
  budget:{
    maxReadBytes:number;maxPackets:number;maxOutputFrames:number;
    maxInputBytes:number;maxElapsedMs:number;
  };
};
export type QualityRangePlan = {
  schema:'voidplayer-quality-range-plan';version:1;input:QualityRangeInput;
  correspondence:'caller-declared-content-relation-exact-au-identities-verified-during-execution';
  coverageDomain:'inclusive-reference-decode-order-au-interval';
  selectedAus:number[];unmappedAus:number[];unsampledAus:number[];
  targets:number;
  preRollAndDrain:{packets:number;outputFrames:number};
  reservation:{
    readBytes:number;inputBytes:number;indexBytes:number;resultBytes:number;
    heapBytes:number;retainedFrameBytes:number;workers:1;
  };
};
export type RangeState =
  | 'queued'|'running'|'cancelling'|'completed'|'partial'
  | 'failed'|'cancelled'|'interrupted';
export const terminalRange=(state:RangeState)=>
  !['queued','running','cancelling'].includes(state);
export type RangeSample = {
  au:number;jobId:string;state:string;reason:QualityJobReason|null;
  result?:{attemptId:string;digest:string};
};
export type QualityRangeJob = {
  id:string;actor:{id:string;name:string};requestId:string;key:string;
  plan:QualityRangePlan;state:RangeState;
  createdAt:number;startedAt:number|null;endedAt:number|null;
  reason:QualityJobReason|null;samples:RangeSample[];
  summary:ReturnType<typeof aggregateRange>;
  cancelRequestedAt:number|null;revision:number;
};
const fail=(message:string):never=>{throw new Error(message);};
function keys(value:unknown,allowed:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).some(k=>!allowed.includes(k)))
    fail('Unknown range fields');
}
function binding(t:PairTarget){
  return JSON.stringify([
    t.mediaId,t.mediaVersion,t.size,t.indexIdentity,t.indexBuildId,
    t.picture.sourceVersion,t.picture.stream,t.picture.configuration
  ]);
}

/** Pure structural planning; no IO, preparation or content alignment. */
export function planQualityRange(value:unknown):QualityRangePlan {
  keys(value,[
    'schema','version','client','interval','correspondence',
    'sampling','pairs','budget'
  ]);
  const input=structuredClone(value) as QualityRangeInput;
  keys(input.client,['id','kind']);
  keys(input.interval,['startAu','endAu']);
  if(input.schema!=='voidplayer-quality-range'||input.version!==1
    ||!input.client||!/^[A-Za-z0-9._:-]{1,80}$/.test(input.client.id)
    ||!['agent','browser','other'].includes(input.client.kind))
    fail('Invalid range identity');

  const {startAu,endAu}=input.interval;
  if(!Number.isSafeInteger(startAu)||!Number.isSafeInteger(endAu)
    ||startAu<0||endAu<startAu
    ||endAu-startAu+1>QUALITY_RANGE_LIMITS.universe)
    fail('Range must contain 1..256 explicit reference AU positions');

  keys(input.correspondence,
    input.correspondence?.mode==='constant-source-pts-offset'
      ?['mode','offsetUs']:['mode']);
  if(!['explicit-au-table','constant-source-pts-offset']
      .includes(input.correspondence?.mode)
    ||input.correspondence.mode==='constant-source-pts-offset'
      &&!Number.isSafeInteger(input.correspondence.offsetUs))
    fail('Explicit correspondence required');

  keys(input.sampling,
    input.sampling?.mode==='stride'?['mode','every','offset']:['mode']);
  if(input.sampling?.mode!=='all'
    &&(input.sampling?.mode!=='stride'
      ||!Number.isSafeInteger(input.sampling.every)
      ||input.sampling.every<2||input.sampling.every>256
      ||!Number.isSafeInteger(input.sampling.offset)
      ||input.sampling.offset<0
      ||input.sampling.offset>=input.sampling.every))
    fail('Invalid deterministic sampling');

  keys(input.budget,[
    'maxReadBytes','maxPackets','maxOutputFrames',
    'maxInputBytes','maxElapsedMs'
  ]);
  for(const k of [
    'maxReadBytes','maxPackets','maxOutputFrames',
    'maxInputBytes','maxElapsedMs'
  ] as const)
    if(!Number.isSafeInteger(input.budget[k])
      ||input.budget[k]<1||input.budget[k]>QUALITY_RANGE_LIMITS[k])
      fail(`Invalid range budget.${k}`);

  if(!Array.isArray(input.pairs)||!input.pairs.length
    ||input.pairs.length>256)
    fail('Provide an explicit bounded pair table');

  const mapped=new Map<number,FramePairRequest>();
  const other=new Set<number>();
  let source='';
  for(const pair of input.pairs){
    const budget=pairBudget(pair);
    const packets=pairPacketCount(pair.reference)
      +pairPacketCount(pair.distorted);
    if(budget.maxPackets<packets||budget.maxOutputFrames<packets)
      fail('Pair budget cannot cover every dependency input and output');
    // A child cannot spend an unrelated 64-output default against a
    // parent reservation for this explicit two-output window.
    pair.budget={
      ...pair.budget,maxPackets:packets,maxOutputFrames:packets
    };
    const au=pair.reference.picture.au;
    const sources=binding(pair.reference)+'|'+binding(pair.distorted);
    if(au<startAu||au>endAu||mapped.has(au)
      ||other.has(pair.distorted.picture.au)
      ||source&&source!==sources)
      fail('Correspondence must be one-to-one with fixed source versions, streams and cache builds');
    source=sources;
    other.add(pair.distorted.picture.au);
    mapped.set(au,pair);
    if(input.correspondence.mode==='constant-source-pts-offset'
      &&pair.distorted.sourcePtsUs-pair.reference.sourcePtsUs
        !==input.correspondence.offsetUs)
      fail('Pair clocks do not satisfy the declared exact offset');
  }
  input.pairs.sort((a,b)=>a.reference.picture.au-b.reference.picture.au);

  const selectedAus:number[]=[],unmappedAus:number[]=[],unsampledAus:number[]=[];
  for(let au=startAu;au<=endAu;au++){
    if(!mapped.has(au))unmappedAus.push(au);
    if(input.sampling.mode==='stride'
      &&(au-startAu)%input.sampling.every!==input.sampling.offset)
      unsampledAus.push(au);
    else selectedAus.push(au);
  }
  const pairs=input.pairs.filter(p=>
    selectedAus.includes(p.reference.picture.au));
  if(!pairs.length||selectedAus.length>QUALITY_RANGE_LIMITS.samples)
    fail('Plan needs 1..64 selected positions and at least one mapped target');

  const work=pairs.reduce((w,p)=>{
    const b=pairBudget(p);
    w.packets+=pairPacketCount(p.reference)+pairPacketCount(p.distorted);
    w.readBytes+=b.maxReadBytes;
    w.inputBytes+=p.budget?.maxInputBytes??128*1024*1024;
    w.indexBytes+=2*b.maxIndexBytes;
    return w;
  },{packets:0,readBytes:0,inputBytes:0,indexBytes:0});
  if(work.packets>input.budget.maxPackets
    ||work.packets>input.budget.maxOutputFrames
    ||work.readBytes>input.budget.maxReadBytes
    ||work.inputBytes>input.budget.maxInputBytes)
    fail('All pair budgets, pre-roll and drain must fit the total range budget');

  return {
    schema:'voidplayer-quality-range-plan',version:1,input,
    correspondence:'caller-declared-content-relation-exact-au-identities-verified-during-execution',
    coverageDomain:'inclusive-reference-decode-order-au-interval',
    selectedAus,unmappedAus,unsampledAus,targets:selectedAus.length,
    preRollAndDrain:{packets:work.packets,outputFrames:work.packets},
    reservation:{
      readBytes:work.readBytes,inputBytes:work.inputBytes,
      indexBytes:work.indexBytes,resultBytes:pairs.length*128*1024,
      heapBytes:256*1024*1024,retainedFrameBytes:32*1024*1024,workers:1
    }
  };
}

/** SSE/count pooling, no dB average or temporal extrapolation.
 * Mixed pixel domains remain separate. */
export function aggregateRange(results:QualityJobResult[]){
  const groups=new Map<string,{
    domain:string;pairs:number;peak:number;sse:number;samples:number;
    ssim:{
      pairs:number;y:number;u:number;v:number;
      yWindows:number;uWindows:number;vWindows:number;
    };
  }>();
  let readBytes=0,packets=0,outputFrames=0,elapsedMs=0;
  for(const {value} of results){
    const r=value.result,m=r.metric;
    const domain=JSON.stringify([
      m.implementation,m.domain,m.bitDepth,m.peak,m.color,m.roi
    ]);
    let g=groups.get(domain);
    if(!g){
      g={
        domain,pairs:0,peak:m.peak,sse:0,samples:0,
        ssim:{pairs:0,y:0,u:0,v:0,yWindows:0,uWindows:0,vWindows:0}
      };
      groups.set(domain,g);
    }
    g.pairs++;
    g.sse+=m.aggregate.sse;
    g.samples+=m.aggregate.samples;
    if(!Number.isSafeInteger(g.sse)||!Number.isSafeInteger(g.samples))
      fail('Range SSE/count exceeds exact integer budget');
    if(r.ssim){
      g.ssim.pairs++;
      for(const p of ['y','u','v'] as const){
        g.ssim[p]+=r.ssim.planes[p].score*r.ssim.planes[p].windows;
        g.ssim[`${p}Windows`]+=r.ssim.planes[p].windows;
      }
    }
    readBytes+=r.work.readBytes;
    packets+=r.work.packets;
    outputFrames+=r.work.outputFrames;
    elapsedMs+=r.work.elapsedMs;
  }
  return {
    pooling:'source-sample-sse-count-by-identical-pixel-domain' as const,
    scope:'scored-pairs-only-no-temporal-extrapolation' as const,
    scoredPairs:results.length,
    work:{readBytes,packets,outputFrames,elapsedMs},
    groups:[...groups.values()].map(g=>{
      const metric:PsnrStatistics={
        sse:g.sse,samples:g.samples,mse:g.sse/g.samples,
        psnr:g.sse===0
          ?{kind:'positive-infinity',db:null}
          :{kind:'finite',db:10*Math.log10(g.peak*g.peak/(g.sse/g.samples))}
      };
      return {
        domain:JSON.parse(g.domain) as unknown[],pairs:g.pairs,metric,
        ssim:g.ssim.pairs?{
          pairs:g.ssim.pairs,
          weighting:'per-plane-valid-window-weighted-then-y4-u1-v1',
          windows:{
            y:g.ssim.yWindows,u:g.ssim.uWindows,v:g.ssim.vWindows
          },
          score:(
            4*g.ssim.y/g.ssim.yWindows
            +g.ssim.u/g.ssim.uWindows
            +g.ssim.v/g.ssim.vWindows
          )/6
        }:null
      };
    })
  };
}

export type RangeCandidatePolicy={
  space:string;side:'reference'|'distorted';metric:'psnr';maxDb:number;
  limit:number;minAuDistance:number;text:string;severity:number;
};
export function rangeCandidatePolicy(value:unknown):RangeCandidatePolicy{
  keys(value,[
    'space','side','metric','maxDb','limit','minAuDistance','text','severity'
  ]);
  const p=value as RangeCandidatePolicy;
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(p.space)
    ||!['reference','distorted'].includes(p.side)||p.metric!=='psnr'
    ||!Number.isFinite(p.maxDb)||p.maxDb<0||p.maxDb>120
    ||!Number.isInteger(p.limit)||p.limit<1||p.limit>8
    ||!Number.isInteger(p.minAuDistance)
    ||p.minAuDistance<0||p.minAuDistance>256
    ||typeof p.text!=='string'||!p.text.trim()||p.text.length>2000
    ||!Number.isInteger(p.severity)||p.severity<1||p.severity>5)
    fail('Invalid explicit candidate policy');
  return {
    space:p.space,side:p.side,metric:'psnr',maxDb:p.maxDb,
    limit:p.limit,minAuDistance:p.minAuDistance,
    text:p.text.trim(),severity:p.severity
  };
}
export function selectRangeCandidates(
  results:{au:number;result:QualityJobResult}[],
  policy:RangeCandidatePolicy
){
  const selected:typeof results=[];
  for(const item of [...results]
    .filter(x=>{
      const p=x.result.value.result.metric.aggregate.psnr;
      return p.kind==='finite'&&p.db<=policy.maxDb;
    })
    .sort((a,b)=>
      (a.result.value.result.metric.aggregate.psnr.db??Infinity)
      -(b.result.value.result.metric.aggregate.psnr.db??Infinity)
      ||a.au-b.au
    )){
    if(selected.every(x=>Math.abs(x.au-item.au)>=policy.minAuDistance)){
      selected.push(item);
      if(selected.length===policy.limit)break;
    }
  }
  return selected;
}
