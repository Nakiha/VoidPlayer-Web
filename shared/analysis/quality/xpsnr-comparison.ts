import {clockDeltaEquals,clockKey} from '../../media/indexing/rational-clock.ts';
import type {RationalClock} from '../../media/indexing/rational-clock.ts';
import {canonicalJson,validateXpsnrDb,xpsnrMinimum,xpsnrSequenceFrame,XPSNR_LIMITS} from './xpsnr.ts';
import type {XpsnrDb,XpsnrJob,XpsnrNativeResult,XpsnrResult} from './xpsnr.ts';
import type {LibraryPairResult} from './library-pair.ts';
import type {QualityEvidenceRef} from '../../review/quality-evidence.ts';
import {validateSsim} from './ssim-evidence.ts';

export type XpsnrComparison = {
  schema:'voidplayer-xpsnr-comparison';version:1;comparisonKey:string;
  referenceIntegrity:'not-certified';perceptualSuperiority:'not-established';ranking:string;
  reference:LibraryPairResult['sources']['reference'];recipe:XpsnrNativeResult['recipe'];
  items:{id:string;attemptId:string;resultDigest:string;label?:string;distorted:LibraryPairResult['sources']['distorted'];
    raw:XpsnrResult['prepared']['raw'];pooled:XpsnrNativeResult['pooled'];statisticsSha256:string;result:string}[];
};
export type ComparisonSort='caller'|'minimum'|'y'|'u'|'v';
export const COMPARISON_SORTS=['caller','minimum','y','u','v'] as const;
export type ComparisonView={version:1;comparisonKey:string;items:Pick<XpsnrComparison['items'][number],'id'|'attemptId'|'resultDigest'>[];after:number;sort:ComparisonSort};
export type ComparisonSummary={job:XpsnrJob;comparisonKey:string|null;plan:XpsnrResult['plan'];
  sequence:{clockPairs:{referenceAu:number;distortedAu:number;referencePtsUs:number;distortedPtsUs:number;offsetUs:number;referenceClock?:RationalClock;distortedClock?:RationalClock}[]};
  companionPairs:number;metrics:XpsnrResult['metrics'];xpsnr:XpsnrNativeResult|null};
export type ComparisonFramePage={entries:{index:number;score:XpsnrDb|null;pair:LibraryPairResult;ref:QualityEvidenceRef}[];next:number|null};
const fail=(message:string):never=>{throw new Error(message);};
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown)=>typeof v==='string'&&/^xpsnr-[a-f0-9-]{36}$/.test(v);
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);

/** Local navigation/preferences contain immutable identities, never scores or credentials. */
export function comparisonView(value:unknown):ComparisonView {
  const v=value as ComparisonView;
  if(!v||v.version!==1||!hex(v.comparisonKey)||!Array.isArray(v.items)||v.items.length<2||v.items.length>4
    ||new Set(v.items.map(i=>i.id)).size!==v.items.length||!Number.isInteger(v.after)||v.after<0||v.after>=XPSNR_LIMITS.frames
    ||v.after%XPSNR_LIMITS.page!==0||!COMPARISON_SORTS.includes(v.sort))return fail('Invalid frozen comparison view');
  for(const i of v.items)if(!i||!id(i.id)||!hex(i.resultDigest)||typeof i.attemptId!=='string'||!/^[a-f0-9-]{36}$/.test(i.attemptId))fail('Invalid comparison result identity');
  return {version:1,comparisonKey:v.comparisonKey,items:v.items.map(i=>({id:i.id,attemptId:i.attemptId,resultDigest:i.resultDigest})),after:v.after,sort:v.sort};
}
export function pinComparison(c:XpsnrComparison,after=0,sort:ComparisonSort='caller'):ComparisonView {
  if(c.schema!=='voidplayer-xpsnr-comparison'||c.version!==1||c.referenceIntegrity!=='not-certified'||c.perceptualSuperiority!=='not-established')fail('Invalid comparison contract');
  return comparisonView({version:1,comparisonKey:c.comparisonKey,items:c.items,after,sort});
}
export function verifyComparison(c:XpsnrComparison,expected:ComparisonView){
  const actual=pinComparison(c,expected.after,expected.sort);
  if(!same(actual,comparisonView(expected)))fail('Frozen comparison changed; declare a new selection explicitly');
}
/** Pure location; opening it still requires the current actor's owned HTTP reads. */
export function comparisonLocation(view:ComparisonView){return '/admin/?qualityView=xpsnr&xpsnrComparison='+encodeURIComponent(JSON.stringify(comparisonView(view)))+'#quality';}
export function comparisonFromUrl(url:URL):ComparisonView|null {
  const raw=url.searchParams.get('xpsnrComparison');if(raw===null)return null;
  if(raw.length>4096)fail('Comparison location exceeds budget');return comparisonView(JSON.parse(raw));
}
export function comparisonDb(v:XpsnrDb):string {validateXpsnrDb(v);return v.kind==='positive-infinity'?'∞':v.db.toFixed(4);}
export function sortedComparison(c:XpsnrComparison,sort:ComparisonSort){
  return c.items.map((item,index)=>({item,index})).sort((a,b)=>{
    if(sort==='caller')return a.index-b.index;
    const score=(i:typeof a)=>sort==='minimum'?i.item.pooled.minimum:i.item.pooled.planes[sort];
    const x=validateXpsnrDb(score(a)),y=validateXpsnrDb(score(b));
    return (x.kind==='positive-infinity'?y.kind==='positive-infinity'?0:-1:y.kind==='positive-infinity'?1:y.db-x.db)||a.index-b.index;
  }).map(v=>v.item);
}
export function verifyComparisonSummaries(c:XpsnrComparison,summaries:ComparisonSummary[],actor:string){
  if(summaries.length!==c.items.length)fail('Missing comparison version');
  let reference:unknown;
  for(const [ordinal,s]of summaries.entries()){
    const item=c.items[ordinal],n=s.xpsnr??fail('Completed XPSNR unavailable'),clocks=s.sequence.clockPairs;
    if(!n||s.job.actor.id!==actor||s.job.state!=='completed'||s.job.id!==item.id||s.job.attemptId!==item.attemptId
      ||s.job.resultDigest!==item.resultDigest||s.comparisonKey!==c.comparisonKey||!same(n.recipe,c.recipe)
      ||!same(n.pooled,item.pooled)||n.statistics.sha256!==item.statisticsSha256||n.frames.length<2||n.frames.length>XPSNR_LIMITS.frames
      ||s.companionPairs!==n.frames.length||clocks.length!==n.frames.length||!same(s.plan,s.job.input.plan))fail('Comparison result identity, domain or coverage changed');
    if(!same(n.pooled.minimum,xpsnrMinimum(n.pooled.planes)))fail('Official pooled plane minimum differs');
    for(const plane of Object.values(n.pooled.planes))validateXpsnrDb(plane);
    const seen=new Set<number>();
    for(const [i,f]of n.frames.entries()){
      const clock=clocks[i];for(const plane of Object.values(f.planes))validateXpsnrDb(plane);
      if(f.index!==i||!same(f.minimum,xpsnrMinimum(f.planes))||!Number.isSafeInteger(clock.referenceAu)||clock.referenceAu<0
        ||seen.has(clock.referenceAu)||!Number.isSafeInteger(clock.referencePtsUs)||i>0&&!clockDeltaEquals(clock.referenceClock??{ticks:clock.referencePtsUs,timescale:1000000},clocks[i-1].referenceClock??{ticks:clocks[i-1].referencePtsUs,timescale:1000000},c.recipe.cadence??{ticks:c.recipe.cadenceUs,timescale:1000000}))fail('Missing or reordered reference presentation frame');
      seen.add(clock.referenceAu);
    }
    const domain=clocks.map(p=>({au:p.referenceAu,pts:p.referencePtsUs,...(p.referenceClock?{clock:p.referenceClock}:{})}));
    if(ordinal&& !same(reference,domain))fail('Reference presentation clocks differ');reference=domain;
  }
}
/** Bounded page joins only exact reference presentation ordinals and witnesses. */
export function verifyComparisonPages(c:XpsnrComparison,summaries:ComparisonSummary[],pages:ComparisonFramePage[],after:number){
  const total=summaries[0].companionPairs,end=Math.min(total,after+XPSNR_LIMITS.page),expectedNext=end<total?end:null;
  if(after>=total||pages.length!==c.items.length)fail('Comparison frame page unavailable');
  for(const [version,page]of pages.entries()){
    const item=c.items[version],s=summaries[version];
    if(page.entries.length!==end-after||page.next!==expectedNext)fail('Missing comparison companion frame');
    for(const [offset,e]of page.entries.entries()){
      const index=after+offset,clock=s.sequence.clockPairs[index],p=e.pair.result.provenance;
      if(e.index!==index||e.ref.jobId!==`${item.id}-f${index}`||e.ref.attemptId!==item.attemptId||e.ref.digest!==item.resultDigest||e.ref.side!=='reference'
        ||!same(e.pair.sources.reference,c.reference)||!same(e.pair.sources.distorted,item.distorted)
        ||p.reference.picture.au!==clock.referenceAu||p.reference.sourcePtsUs!==clock.referencePtsUs
        ||p.distorted.picture.au!==clock.distortedAu||p.distorted.sourcePtsUs!==clock.distortedPtsUs
        ||!same(e.score,s.xpsnr!.frames[index].minimum)
        ||version>0&&!same(xpsnrSequenceFrame(p.reference),xpsnrSequenceFrame(pages[0].entries[offset].pair.result.provenance.reference)))fail('Frame witness differs from frozen reference presentation order');
      for(const side of ['reference','distorted'] as const){const witness=p[side],actual=witness.container?{ticks:witness.container.sample.dtsTicks+witness.container.sample.ctsTicks,timescale:witness.container.timescale}:{ticks:witness.sourcePtsUs,timescale:1000000};const reported=clock[side==='reference'?'referenceClock':'distortedClock'];if(reported&&clockKey(reported)!==clockKey(actual))fail('Exact comparison source clock differs');}
      const ssim=e.pair.result.ssim;
      if(s.job.input.metrics.ssim!==!!ssim)fail('Requested SSIM companion is unavailable');
      if(ssim)validateSsim(ssim,e.pair.result.metric);
      validateXpsnrDb(e.pair.result.metric.aggregate.psnr);
    }
  }
}
