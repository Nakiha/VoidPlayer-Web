import {test} from 'node:test';
import assert from 'node:assert/strict';
import {comparisonView,pinComparison,verifyComparison,comparisonLocation,comparisonFromUrl,comparisonDb,sortedComparison,verifyComparisonSummaries,verifyComparisonPages} from '../../shared/analysis/quality/xpsnr-comparison.ts';
import {readXpsnrComparison} from '../../src/services/xpsnr-comparison.ts';
import {frame} from '../helpers/quality-numeric-frame.ts';
import {measurePsnr} from '../../shared/analysis/quality/psnr.ts';
import {measureSsim,SSIM_VARIANT} from '../../shared/analysis/quality/ssim.ts';
const finite=(db:number)=>({kind:'finite' as const,db}),infinity={kind:'positive-infinity' as const,db:null};
function fixture(count=2){
  const recipe={cadenceUs:250000},reference={binding:{mediaId:'reference',mediaVersion:'v1'}},ids=Array.from({length:count},(_,i)=>`xpsnr-${String(i+1).repeat(8)}-1111-1111-1111-111111111111`);
  const items=ids.map((id,i)=>({id,attemptId:'11111111-1111-1111-1111-111111111111',resultDigest:String(i+1).repeat(64),distorted:{binding:{mediaId:'version'+i}},pooled:{planes:{y:finite(40+i),u:finite(50),v:finite(60)},minimum:finite(40+i)},statisticsSha256:'a'.repeat(64)}));
  const comparison:any={schema:'voidplayer-xpsnr-comparison',version:1,referenceIntegrity:'not-certified',perceptualSuperiority:'not-established',comparisonKey:'b'.repeat(64),reference,recipe,items};
  // Presentation order differs deliberately from decode-order AU.
  const aus=[0,2,1,3],summaries:any[]=items.map(item=>({job:{id:item.id,state:'completed',actor:{id:'owner'},attemptId:item.attemptId,resultDigest:item.resultDigest,input:{plan:{id:'plan'},metrics:{ssim:false}}},plan:{id:'plan'},comparisonKey:comparison.comparisonKey,sequence:{clockPairs:aus.map((au,i)=>({referenceAu:au,referencePtsUs:i*250000,distortedAu:10+au,distortedPtsUs:1000000+i*250000}))},companionPairs:4,xpsnr:{recipe,pooled:item.pooled,statistics:{sha256:item.statisticsSha256},frames:aus.map((_,index)=>({index,planes:item.pooled.planes,minimum:item.pooled.minimum}))}}));
  const pages:any[]=items.map((item,v)=>({entries:aus.map((au,index)=>({index,score:item.pooled.minimum,ref:{jobId:`${item.id}-f${index}`,attemptId:item.attemptId,digest:item.resultDigest,side:'reference'},pair:{sources:{reference,distorted:item.distorted},result:{provenance:{reference:{picture:{au},sourcePtsUs:index*250000},distorted:{picture:{au:10+au},sourcePtsUs:1000000+index*250000}},metric:{aggregate:{psnr:finite(35+v)}}}}})),next:null}));
  return {comparison,summaries,pages,ids};
}
test('immutable view roundtrip is bounded and contains no score or credentials',()=>{
  const {comparison}=fixture(),view=pinComparison(comparison,0,'minimum');
  assert.deepEqual(comparisonFromUrl(new URL(comparisonLocation(view),'http://localhost')),view);
  assert.deepEqual(Object.keys(view.items[0]),['id','attemptId','resultDigest']);
  for(const mutate of [(v:any)=>v.after=1,(v:any)=>v.sort='subjective',(v:any)=>v.items.push(...v.items,...v.items),(v:any)=>v.items[0].resultDigest='newest']){const bad=structuredClone(view);mutate(bad);assert.throws(()=>comparisonView(bad));}
});
test('pool sorting uses chosen official plane/minimum, extended infinity and stable caller ties',()=>{
  const {comparison:c}=fixture();assert.deepEqual(sortedComparison(c,'minimum').map(x=>x.id),[c.items[1].id,c.items[0].id]);
  assert.deepEqual(sortedComparison(c,'u').map(x=>x.id),c.items.map((x:any)=>x.id));
  c.items[0].pooled.minimum=infinity;assert.equal(sortedComparison(c,'minimum')[0].id,c.items[0].id);
  assert.equal(comparisonDb(infinity),'∞');assert.equal(comparisonDb(finite(0)),'0.0000');assert.throws(()=>comparisonDb({kind:'finite',db:Infinity}));
});
test('changed attempt, digest and domain reject saved pins; never follow latest result',()=>{
  for(const mutate of [(c:any)=>c.items[0].attemptId='22222222-2222-2222-2222-222222222222',(c:any)=>c.items[0].resultDigest='c'.repeat(64),(c:any)=>c.comparisonKey='d'.repeat(64)]){const {comparison:c}=fixture(),view=pinComparison(c);mutate(c);assert.throws(()=>verifyComparison(c,view),/changed/);}
});
test('reference presentation clocks and full frame coverage verified without sorting distorted AU',()=>{
  const {comparison,summaries,pages}=fixture();verifyComparisonSummaries(comparison,summaries,'owner');verifyComparisonPages(comparison,summaries,pages,0);
  assert.deepEqual(pages[0].entries.map((e:any)=>e.pair.result.provenance.reference.picture.au),[0,2,1,3]);
  for(const change of [(s:any)=>s[1].job.actor.id='other',(s:any)=>s[1].xpsnr.frames.pop(),(s:any)=>s[1].sequence.clockPairs[1].referencePtsUs++,(s:any)=>s[1].job.resultDigest='e'.repeat(64)]){const copy=structuredClone(summaries);change(copy);assert.throws(()=>verifyComparisonSummaries(comparison,copy,'owner'));}
});
test('missing, duplicated, wrong source/ref/digest companion frames and SSIM gaps reject',()=>{
  const {comparison,summaries,pages}=fixture();
  for(const change of [(p:any)=>p[1].entries.pop(),(p:any)=>p[1].entries[1]=p[1].entries[0],(p:any)=>p[1].entries[1].ref.digest='f'.repeat(64),(p:any)=>p[1].entries[0].pair.sources.reference={binding:{mediaId:'another'}},(p:any)=>p[1].entries[1].pair.result.provenance.reference.sourcePtsUs++,(p:any)=>p[1].next=4]){const copy=structuredClone(pages);change(copy);assert.throws(()=>verifyComparisonPages(comparison,summaries,copy,0));}
  summaries[1].job.input.metrics.ssim=true;assert.throws(()=>verifyComparisonPages(comparison,summaries,pages,0),/SSIM/);
});
test('read workflow is bounded GET only; unavailable result fails before companion reads',async()=>{
  const f=fixture(),calls:string[]=[];
  const api:any={async request(actor:string,url:string){assert.equal(actor,'owner');calls.push(url);if(url.includes('/compare?'))return f.comparison;const i=url.includes(f.ids[0])?0:1;return url.includes('/frames?')?f.pages[i]:f.summaries[i];}};
  const loaded=await readXpsnrComparison(api,'owner',f.ids,new AbortController().signal);assert.equal(loaded.pages.length,2);assert.equal(calls.length,5);
  calls.length=0;api.request=async(_actor:string,url:string)=>{calls.push(url);if(url.includes('/compare?'))return f.comparison;throw Error('immutable result unavailable');};
  await assert.rejects(readXpsnrComparison(api,'owner',f.ids,new AbortController().signal),/unavailable/);assert.ok(calls.every(url=>!url.includes('/frames?')));
});
test('comparison response must contain every requested version exactly once in order, before dependent reads',async()=>{
  const f=fixture(3),calls:string[]=[],signal=new AbortController().signal;
  const api:any={async request(_actor:string,url:string){calls.push(url);if(url.includes('/compare?'))return {...f.comparison,items:returned};const i=f.ids.findIndex(id=>url.includes(id));return url.includes('/frames?')?f.pages[i]:f.summaries[i];}};
  let returned=f.comparison.items.slice(0,2);
  await assert.rejects(readXpsnrComparison(api,'owner',f.ids,signal),/selection changed/);
  assert.equal(calls.length,1,'a missing version is rejected before summary/frame requests');
  for(const items of [[...f.comparison.items,f.comparison.items[0]],f.comparison.items.toReversed(),[f.comparison.items[0],f.comparison.items[2],f.comparison.items[1]]]){
    returned=items;calls.length=0;await assert.rejects(readXpsnrComparison(api,'owner',f.ids,signal));assert.equal(calls.length,1);
  }
  returned=f.comparison.items;const valid=await readXpsnrComparison(api,'owner',f.ids,signal);assert.deepEqual(valid.comparison.items.map(i=>i.id),f.ids);
});
test('requested SSIM uses existing numerical/domain validation; null/nonfinite/out-of-range facts reject',()=>{
  const f=fixture();f.summaries[0].job.input.metrics.ssim=true;
  const reference=frame(8,{width:32,height:32,value:(_c,x,y)=>(x+y)%2?255:0}),distorted=frame(8,{width:32,height:32,value:(_c,x,y)=>(x+y)%2?0:255});
  const request={domain:'source-yuv-code-values' as const,reference,distorted,roi:{x:0,y:0,width:32,height:32}};
  for(const e of f.pages[0].entries){e.pair.result.metric=measurePsnr(request);e.pair.result.ssim=measureSsim(request,{variant:SSIM_VARIANT});}
  assert.ok(f.pages[0].entries[0].pair.result.ssim.aggregate.score<0,'valid negative SSIM is retained');
  verifyComparisonPages(f.comparison,f.summaries,f.pages,0);
  for(const invalid of [null,undefined,'0',NaN,Infinity,-Infinity,1.01,-1.01]){
    const pages=structuredClone(f.pages);pages[0].entries[0].pair.result.ssim.aggregate.score=invalid;
    assert.throws(()=>verifyComparisonPages(f.comparison,f.summaries,pages,0),/SSIM/);
  }
  const malformed=structuredClone(f.pages);malformed[0].entries[0].pair.result.ssim.planes.y.score=null;
  assert.throws(()=>verifyComparisonPages(f.comparison,f.summaries,malformed,0),/SSIM/);
  for(const e of f.pages[0].entries){e.pair.result.metric=measurePsnr({...request,distorted:reference});e.pair.result.ssim=measureSsim({...request,distorted:reference},{variant:SSIM_VARIANT});}
  assert.equal(f.pages[0].entries[0].pair.result.ssim.aggregate.score,1);
  assert.equal(f.pages[0].entries[0].pair.result.metric.aggregate.psnr.kind,'positive-infinity');
  verifyComparisonPages(f.comparison,f.summaries,f.pages,0);
});
