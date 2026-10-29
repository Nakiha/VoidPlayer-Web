import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {vmafInput,vmafSequence,VMAF_LIMITS,VMAF_CAPABILITY} from '../../shared/analysis/quality/vmaf.ts';
import {agentManifest,serviceCapabilities} from '../../shared/service/agent.ts';
const input=()=>({schema:'voidplayer-native-vmaf-job',version:1,client:{id:'test',kind:'agent'},plan:{id:randomUUID(),attemptId:randomUUID(),digest:'a'.repeat(64)},model:'vmaf_v0_6_1',cadenceUs:250000,metrics:{psnr:true,ssim:false},budget:{maxRawBytes:1048576,maxElapsedMs:30000,nativeCpuSeconds:1,nativeMemoryBytes:536870912}});
test('native recipe normalizes exact trusted references; arbitrary executable/model paths and budget escape reject',()=>{
 const v=input();assert.deepEqual(vmafInput(v),v);
 for(const alter of [(v:any)=>v.binary='/tmp/anything',(v:any)=>v.model='latest',(v:any)=>v.model='toString',(v:any)=>v.plan.path='/private',(v:any)=>v.metrics.psnr=false,(v:any)=>v.cadenceUs=0,(v:any)=>v.budget.nativeCpuSeconds=61,(v:any)=>v.budget.maxRawBytes=Infinity,(v:any)=>v.budget.nativeMemoryBytes=-1]){const x=structuredClone(v);alter(x);assert.throws(()=>vmafInput(x));}
});
test('sequence order is presentation order, rejects holes/stride/duplicates/negative/VFR/mismatched clocks',()=>{
 const make=()=>{const pairs=[0,2,1,3].map(au=>({reference:{indexIdentity:{kind:'flv'},sourcePtsUs:[0,500000,250000,750000][au],picture:{au}},distorted:{indexIdentity:{kind:'flv'},sourcePtsUs:[0,500000,250000,750000][au],picture:{au}}}));const value={sources:{reference:{binding:{indexIdentity:{kind:'flv'}},producer:{producer:'server-flv-scan-v1'}},distorted:{binding:{indexIdentity:{kind:'flv'}},producer:{producer:'server-flv-scan-v1'}}},rows:pairs.map(()=>({selected:true,status:'mapped'})),rangePlan:{input:{pairs}},executionBlock:null,sourceIssues:{reference:null,distorted:null},request:{sampling:{mode:'all'}}};const snapshot={id:randomUUID(),attemptId:randomUUID(),digest:'a'.repeat(64),value},indexes=[0,1].map(()=>({packets:[0,500000,250000,750000].map(pts=>({pts}))}));return {snapshot,indexes};};
 let f=make();const s=vmafSequence(f.snapshot as any,f.indexes as any,250000);assert.deepEqual(s.pairs.map(p=>p.reference.picture.au),[0,2,1,3]);assert.equal(s.referenceIntegrity,'not-certified');assert.equal(s.concealmentDetection,'unavailable');
 for(const alter of [(f:any)=>f.snapshot.value.rows[1].status='unmapped',(f:any)=>f.snapshot.value.request.sampling.mode='stride',(f:any)=>f.indexes[0].packets.push({pts:250000}),(f:any)=>f.snapshot.value.rangePlan.input.pairs[0].reference.sourcePtsUs=-1,(f:any)=>f.snapshot.value.rangePlan.input.pairs[1].reference.sourcePtsUs=260000,(f:any)=>f.snapshot.value.rangePlan.input.pairs[0].distorted.sourcePtsUs=1]){f=make();alter(f);assert.throws(()=>vmafSequence(f.snapshot as any,f.indexes as any,250000));}
 f=make();assert.throws(()=>vmafSequence(f.snapshot as any,f.indexes as any,100000));
 for(const side of ['reference','distorted']as const){f=make();f.snapshot.value.sources[side].binding.indexIdentity.kind='mp4';assert.throws(()=>vmafSequence(f.snapshot as any,f.indexes as any,250000),/matching server producer/);}
});
test('optional native capability never claims installed platform by code presence; existing single-frame capabilities stay separate',()=>{
 const common={capabilities:serviceCapabilities(true,false),libraryReady:true,qualityJobsEnabled:true,actor:{id:'owner',name:'Owner'}};
 const missing=agentManifest(common);assert.equal(missing.capabilities.find(c=>c.id==='quality.vmaf')?.enabled,false);assert.deepEqual(missing.qualityVmaf.models,VMAF_CAPABILITY.models);
 const enabled=agentManifest({...common,nativeVmaf:{enabled:true,reason:null}});assert.equal(enabled.capabilities.find(c=>c.id==='quality.vmaf')?.readiness,'per-source');assert.equal(enabled.qualityVmaf.buildsIndexes,false);assert.equal(enabled.qualityVmaf.observerDisconnectCancels,false);assert.equal(enabled.qualityVmaf.spatial,'no-VMAF-heatmap-or-localized-defect');assert.deepEqual(enabled.qualityJobs.metrics,['psnr','ssim']);
});

test('invalid durable native process witnesses never authorize a process signal',async()=>{if(process.platform!=='linux')return;const {stopOwnedNative}=await import('../../server/analysis/quality/legacy-process.ts');for(const pid of [0,-1,1.5,NaN])await assert.rejects(stopOwnedNative({pid,startTicks:'1',bootId:'a'.repeat(36)}),{code:'stop-uncertain'});await assert.rejects(stopOwnedNative({pid:1,startTicks:'1',bootId:''}),{code:'stop-uncertain'});});

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
  let f=make();const sequence=vmafSequence(f.snapshot as any,f.indexes as any,250000);
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
  ]){f=make();alter(f);assert.throws(()=>vmafSequence(f.snapshot as any,f.indexes as any,250000),`${row.codec}/${row.depth}: raw source substitution must refuse`);}
 }
});
