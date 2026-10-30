import {randomUUID} from 'node:crypto';import test from 'node:test';import assert from 'node:assert/strict';
import {xpsnrSequence,xpsnrInput,parseXpsnrStatistics,xpsnrMinimum,XPSNR_RECIPE,XPSNR_LIMITS} from '../../shared/analysis/quality/xpsnr.ts';
const body={schema:'voidplayer-native-xpsnr-job',version:1,client:{id:'xpsnr',kind:'agent'},plan:{id:'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12),attemptId:'b'.repeat(8)+'-bbbb-bbbb-bbbb-'+'b'.repeat(12),digest:'c'.repeat(64)},recipe:XPSNR_RECIPE,cadenceUs:250000,metrics:{psnr:true,ssim:false},budget:{maxRawBytes:1048576,maxElapsedMs:30000,nativeCpuSeconds:10,nativeMemoryBytes:536870912}};
test('XPSNR explicit recipe/identity/budget validator never accepts a model, cadence rounding or sparse sampling',()=>{assert.deepEqual(xpsnrInput(body),body);for(const change of [{model:'vmaf_v0_6_1'},{cadenceUs:1000000/30},{cadenceUs:0},{recipe:'psnr'},{sampling:{mode:'stride',every:2,offset:0}},{metrics:{psnr:false,ssim:false}},{budget:{...body.budget,maxRawBytes:XPSNR_LIMITS.maxRawBytes+1}}])assert.throws(()=>xpsnrInput({...body,...change}));});
test('official pool retained, never average frame dB; infinities remain explicit JSON values',()=>{const r=parseXpsnrStatistics('n:    1  XPSNR y: 20.0000  XPSNR u: inf  XPSNR v: 40.0000\nn:    2  XPSNR y: 40.0000  XPSNR u: inf  XPSNR v: 40.0000\n\nXPSNR average, 2 frames  y: 25.1927  u: inf  v: 40.0000  (minimum: 25.1927)\n',2);assert.equal(r.pooled.minimum.db,25.1927);assert.notEqual(r.pooled.minimum.db,30);assert.deepEqual(r.frames[0].planes.u,{kind:'positive-infinity',db:null});assert.equal(JSON.parse(JSON.stringify(r)).pooled.planes.u.kind,'positive-infinity');assert.deepEqual(xpsnrMinimum({y:{kind:'positive-infinity',db:null},u:{kind:'positive-infinity',db:null},v:{kind:'positive-infinity',db:null}}),{kind:'positive-infinity',db:null});});
test('stats rejects truncated/duplicate/out-of-order/count mismatch/NaN/no pool rather than filling a hole',()=>{const lines='n:    1  XPSNR y: 20.0000  XPSNR u: 30.0000  XPSNR v: 40.0000\nn:    2  XPSNR y: 20.0000  XPSNR u: 30.0000  XPSNR v: 40.0000\nXPSNR average, 2 frames  y: 20.0000  u: 30.0000  v: 40.0000  (minimum: 20.0000)';for(const v of [lines.replace('n:    2','n:    1'),lines.replace('2 frames','3 frames'),lines.replace('20.0000','NaN'),lines.split('\n').slice(0,2).join('\n'),lines.replace('(minimum: 20.0000)','(minimum: 30.0000)')])assert.throws(()=>parseXpsnrStatistics(v,2));});

test('sequence order is presentation order, rejects holes/stride/duplicates/negative/VFR/mismatched clocks',()=>{
 const make=()=>{const pairs=[0,2,1,3].map(au=>({reference:{indexIdentity:{kind:'flv'},sourcePtsUs:[0,500000,250000,750000][au],picture:{au}},distorted:{indexIdentity:{kind:'flv'},sourcePtsUs:[0,500000,250000,750000][au],picture:{au}}}));const value={sources:{reference:{binding:{indexIdentity:{kind:'flv'}},producer:{producer:'server-flv-scan-v1'}},distorted:{binding:{indexIdentity:{kind:'flv'}},producer:{producer:'server-flv-scan-v1'}}},rows:pairs.map(()=>({selected:true,status:'mapped'})),rangePlan:{input:{pairs}},executionBlock:null,sourceIssues:{reference:null,distorted:null},request:{sampling:{mode:'all'}}};const snapshot={id:randomUUID(),attemptId:randomUUID(),digest:'a'.repeat(64),value},indexes=[0,1].map(()=>({packets:[0,500000,250000,750000].map(pts=>({pts}))}));return {snapshot,indexes};};
 let f=make();const s=xpsnrSequence(f.snapshot as any,f.indexes as any,250000);assert.deepEqual(s.pairs.map(p=>p.reference.picture.au),[0,2,1,3]);assert.equal(s.referenceIntegrity,'not-certified');assert.equal(s.concealmentDetection,'unavailable');
 for(const alter of [(f:any)=>f.snapshot.value.rows[1].status='unmapped',(f:any)=>f.snapshot.value.request.sampling.mode='stride',(f:any)=>f.indexes[0].packets.push({pts:250000}),(f:any)=>f.snapshot.value.rangePlan.input.pairs[0].reference.sourcePtsUs=-1,(f:any)=>f.snapshot.value.rangePlan.input.pairs[1].reference.sourcePtsUs=260000,(f:any)=>f.snapshot.value.rangePlan.input.pairs[0].distorted.sourcePtsUs=1]){f=make();alter(f);assert.throws(()=>xpsnrSequence(f.snapshot as any,f.indexes as any,250000));}
 f=make();assert.throws(()=>xpsnrSequence(f.snapshot as any,f.indexes as any,100000));
 for(const side of ['reference','distorted']as const){f=make();f.snapshot.value.sources[side].binding.indexIdentity.kind='mp4';assert.throws(()=>xpsnrSequence(f.snapshot as any,f.indexes as any,250000),/matching server producer/);}
});
test('strict MP4 presentation eligibility retains raw clocks/table/producer and refuses substituted or inexact facts',async()=>{
 const {readFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
 const {readMp4QualityIndex}=await import('../../shared/media/indexing/mp4-quality-index.ts');
 const {qualitySourceIndex}=await import('../../shared/analysis/quality/source-index.ts');
 const fixed=JSON.parse(await readFile(new URL('../helpers/native-vmaf-mp4-samples.json',import.meta.url),'utf8'));
 for(const row of fixed.samples){
  const bytes=Buffer.from(row.reference.mp4,'base64'),{document}=await readMp4QualityIndex({size:bytes.length,read:async(at,n)=>bytes.subarray(at,at+n)},{digest:async b=>createHash('sha256').update(b).digest('hex')});
  const index=qualitySourceIndex(document,bytes.length),keys=index.packets.flatMap((p,i)=>p.key?[i]:[]);
  const targets=index.packets.map((p,au)=>({size:bytes.length,indexIdentity:{kind:'mp4'},sourcePtsUs:p.pts,picture:{au},decode:{mode:'packet-identity-gop-v1',startAu:keys.filter(k=>k<=au).at(-1)!,endAu:(keys.find(k=>k>au)??index.packets.length)-1}}));
  const source={binding:{indexIdentity:{kind:'mp4'},size:bytes.length},producer:{producer:'server-mp4-scan-v1',trackId:document.trackId,timescale:document.timescale,tableSha256:document.moov.sha256}};
  const make=()=>({snapshot:{id:randomUUID(),attemptId:randomUUID(),digest:'a'.repeat(64),value:{sources:{reference:structuredClone(source),distorted:structuredClone(source)},rows:targets.map(()=>({selected:true,status:'mapped'})),rangePlan:{input:{pairs:targets.map(p=>({reference:structuredClone(p),distorted:structuredClone(p)}))}},executionBlock:null,sourceIssues:{reference:null,distorted:null},request:{sampling:{mode:'all'}}}},indexes:[structuredClone(index),structuredClone(index)]});
  let f=make();const sequence=xpsnrSequence(f.snapshot as any,f.indexes as any,250000);
  assert.deepEqual(sequence.pairs.map(p=>p.reference.picture.au),index.order);
  for(const alter of [
   (f:any)=>f.snapshot.value.sources.reference.binding.mediaVersion='substituted',
   (f:any)=>f.snapshot.value.rangePlan.input.pairs[1].reference.indexIdentity.indexerBuild='substituted',
   (f:any)=>f.snapshot.value.sources.reference.producer.trackId++,
   (f:any)=>f.snapshot.value.sources.distorted.producer.timescale++,
   (f:any)=>f.snapshot.value.sources.reference.producer.tableSha256='f'.repeat(64),
   (f:any)=>f.snapshot.value.sources.reference.producer.producer='server-flv-scan-v1',
   (f:any)=>f.indexes[0].mp4.samples[1].ctsTicks++,
   (f:any)=>f.indexes[1].mp4.samples[1].offset++,
   (f:any)=>f.indexes[0].mp4.samples[1].durationTicks++,
   (f:any)=>{f.indexes[0].mp4.timescale=7;f.snapshot.value.sources.reference.producer.timescale=7;},
   (f:any)=>f.indexes[0].packets.pop(),
   (f:any)=>f.indexes[1].packets[1].pts=f.indexes[1].packets[0].pts,
   (f:any)=>f.snapshot.value.rangePlan.input.pairs[1].reference.decode.mode='forward-one-output-per-au-v1',
  ]){f=make();alter(f);assert.throws(()=>xpsnrSequence(f.snapshot as any,f.indexes as any,250000),`${row.codec}/${row.depth}: raw source substitution must refuse`);}
 }
});
