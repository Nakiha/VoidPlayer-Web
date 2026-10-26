import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {vmafInput,vmafSequence,VMAF_LIMITS,VMAF_CAPABILITY} from '../../shared/analysis/quality/vmaf.ts';
import {verifyVmafComponent} from '../../server/analysis/vmaf/component.ts';
import {agentManifest,serviceCapabilities} from '../../shared/service/agent.ts';
const input=()=>({schema:'voidplayer-native-vmaf-job',version:1,client:{id:'test',kind:'agent'},plan:{id:randomUUID(),attemptId:randomUUID(),digest:'a'.repeat(64)},model:'vmaf_v0_6_1',cadenceUs:250000,metrics:{psnr:true,ssim:false},budget:{maxRawBytes:1048576,maxElapsedMs:30000,nativeCpuSeconds:1,nativeMemoryBytes:536870912}});
test('native recipe normalizes exact trusted references; arbitrary executable/model paths and budget escape reject',()=>{
 const v=input();assert.deepEqual(vmafInput(v),v);
 for(const alter of [(v:any)=>v.binary='/tmp/anything',(v:any)=>v.model='latest',(v:any)=>v.model='toString',(v:any)=>v.plan.path='/private',(v:any)=>v.metrics.psnr=false,(v:any)=>v.cadenceUs=0,(v:any)=>v.budget.nativeCpuSeconds=61,(v:any)=>v.budget.maxRawBytes=Infinity,(v:any)=>v.budget.nativeMemoryBytes=-1]){const x=structuredClone(v);alter(x);assert.throws(()=>vmafInput(x));}
});
test('sequence order is presentation order, rejects holes/stride/duplicates/negative/VFR/mismatched clocks',()=>{
 const make=()=>{const pairs=[0,2,1,3].map(au=>({reference:{sourcePtsUs:[0,500000,250000,750000][au],picture:{au}},distorted:{sourcePtsUs:[0,500000,250000,750000][au],picture:{au}}}));const value={sources:{reference:{binding:{indexIdentity:{kind:'flv'}},producer:{producer:'server-flv-scan-v1'}},distorted:{binding:{indexIdentity:{kind:'flv'}},producer:{producer:'server-flv-scan-v1'}}},rows:pairs.map(()=>({selected:true,status:'mapped'})),rangePlan:{input:{pairs}},executionBlock:null,sourceIssues:{reference:null,distorted:null},request:{sampling:{mode:'all'}}};const snapshot={id:randomUUID(),attemptId:randomUUID(),digest:'a'.repeat(64),value},indexes=[0,1].map(()=>({packets:[0,500000,250000,750000].map(pts=>({pts}))}));return {snapshot,indexes};};
 let f=make();const s=vmafSequence(f.snapshot as any,f.indexes as any,250000);assert.deepEqual(s.pairs.map(p=>p.reference.picture.au),[0,2,1,3]);assert.equal(s.referenceIntegrity,'not-certified');assert.equal(s.concealmentDetection,'unavailable');
 for(const alter of [(f:any)=>f.snapshot.value.rows[1].status='unmapped',(f:any)=>f.snapshot.value.request.sampling.mode='stride',(f:any)=>f.indexes[0].packets.push({pts:250000}),(f:any)=>f.snapshot.value.rangePlan.input.pairs[0].reference.sourcePtsUs=-1,(f:any)=>f.snapshot.value.rangePlan.input.pairs[1].reference.sourcePtsUs=260000,(f:any)=>f.snapshot.value.rangePlan.input.pairs[0].distorted.sourcePtsUs=1]){f=make();alter(f);assert.throws(()=>vmafSequence(f.snapshot as any,f.indexes as any,250000));}
 f=make();assert.throws(()=>vmafSequence(f.snapshot as any,f.indexes as any,100000));
 for(const side of ['reference','distorted']as const){f=make();f.snapshot.value.sources[side].binding.indexIdentity.kind='mp4';assert.throws(()=>vmafSequence(f.snapshot as any,f.indexes as any,250000),/FLV-only/);}
});
test('optional native capability never claims installed platform by code presence; existing single-frame capabilities stay separate',()=>{
 const common={capabilities:serviceCapabilities(true,false),libraryReady:true,qualityJobsEnabled:true,actor:{id:'owner',name:'Owner'}};
 const missing=agentManifest(common);assert.equal(missing.capabilities.find(c=>c.id==='quality.vmaf')?.enabled,false);assert.deepEqual(missing.qualityVmaf.models,VMAF_CAPABILITY.models);
 const enabled=agentManifest({...common,nativeVmaf:{enabled:true,reason:null}});assert.equal(enabled.capabilities.find(c=>c.id==='quality.vmaf')?.readiness,'per-source');assert.equal(enabled.qualityVmaf.buildsIndexes,false);assert.equal(enabled.qualityVmaf.observerDisconnectCancels,false);assert.equal(enabled.qualityVmaf.spatial,'no-VMAF-heatmap-or-localized-defect');assert.deepEqual(enabled.qualityJobs.metrics,['psnr','ssim']);
});
test('unconfigured component fails closed without PATH fallback',async()=>{await assert.rejects(verifyVmafComponent(undefined,'vmaf_v0_6_1'),{code:'component-unavailable'});});

test('invalid durable native process witnesses never authorize a process signal',async()=>{if(process.platform!=='linux')return;const {stopOwnedNative}=await import('../../server/analysis/vmaf/runner.ts');for(const pid of [0,-1,1.5,NaN])await assert.rejects(stopOwnedNative({pid,startTicks:'1',bootId:'a'.repeat(36)}),{code:'stop-uncertain'});await assert.rejects(stopOwnedNative({pid:1,startTicks:'1',bootId:''}),{code:'stop-uncertain'});});
