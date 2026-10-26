import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {nativeFixture,officialOracle,nativeComponent} from '../helpers/native-vmaf.mjs';
import {qualityEvidenceValue,qualityEvidenceList} from '../../shared/review/quality-evidence.ts';
for(const [depth,distorted,model]of [[8,false,'vmaf_v0_6_1'],[8,true,'vmaf_v0_6_1neg'],[10,true,'vmaf_v0_6_1']] as const)test(`real native VMAF HTTP ${depth} ${distorted?'distorted':'same'} ${model}`,{timeout:120000},async t=>{
 const f=await nativeFixture({depth,distorted});t.after(()=>f.close());const input={...f.input,model};
 const pre=await f.json('/api/quality/vmaf/preflight',input);assert.equal(pre.nativeExecution,false);assert.equal(pre.rawColorVerification,'required-at-execution');
 const r=await f.request('/api/quality/vmaf/jobs',input,'one-job');assert.equal(r.status,202);const j=(await r.json()).job;
 assert.equal((await f.request('/api/quality/vmaf/jobs',input,'one-job',{'x-voidplayer-actor':'wrong'})).status,409);
 const other='guest-'+randomUUID();assert.equal((await f.request('/api/quality/vmaf/jobs/'+j.id,undefined,undefined,{cookie:'voidplayer-user='+other,'x-voidplayer-actor':other})).status,404);
 const final=await f.wait(j.id);assert.equal(final.state,'completed',JSON.stringify(final));assert.equal(final.metrics.psnr.state,'completed');assert.equal(final.metrics.ssim.state,'completed');assert.equal(final.metrics.vmaf.state,'completed');assert.equal(final.process,null);
 const result=await f.json(`/api/quality/vmaf/jobs/${j.id}/result`),oracle=await officialOracle(f,depth,model);
 assert.equal(result.vmaf.frames.length,8);assert.equal(result.raw.referenceSha256,oracle.hashes[0]);assert.equal(result.raw.distortedSha256,oracle.hashes[1]);assert.deepEqual(result.vmaf.frames,oracle.result.frames.map((v:any)=>({index:v.frameNum,score:v.metrics.vmaf})));assert.deepEqual(result.vmaf.pooled,oracle.result.pooled_metrics.vmaf);
 assert.ok(result.work.outputFrames>16,'all repeated decode/drain output is charged');assert.ok(result.vmaf.resources.cpuMs>0);assert.ok(result.vmaf.resources.peakRssBytes>0);
 const replay=await f.json('/api/quality/vmaf/jobs',input,'one-job');assert.equal(replay.job.id,j.id);assert.equal(replay.replayed,true);assert.equal(replay.job.attemptId,final.attemptId);
 assert.equal((await f.request('/api/quality/vmaf/jobs',{...input,cadenceUs:1},'one-job')).status,409);
 const page=await f.json(`/api/quality/vmaf/jobs/${j.id}/frames?limit=4`);assert.equal(page.entries.length,4);assert.equal(page.next,4);
 const policy={space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'Explicit temporal full-frame measurement candidate, not a defect judgment',severity:3};
 const p=await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`,policy);assert.equal(p.createdIds.length,1);const a=await f.json('/api/annotations/spaces/default/'+p.createdIds[0]),e=a.document.mark.qualityEvidence[0];assert.equal(e.verification,'server-verified');assert.equal(e.value.sequenceVmaf.spatial,'full-frame-temporal-score-not-localized');assert.equal(e.value.sequenceVmaf.score,oracle.result.frames[e.value.sequenceVmaf.index].metrics.vmaf);assert.doesNotThrow(()=>qualityEvidenceValue(e.value));
 const forged=structuredClone(e.value);forged.sequenceVmaf.recipe.preprocessing='resize';assert.throws(()=>qualityEvidenceValue(forged));
 assert.deepEqual((await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`,policy)).createdIds,p.createdIds);
 assert.equal((await f.request(`/api/quality/vmaf/jobs/${j.id}/candidates`,{...policy,severity:4})).status,409);
 console.log(JSON.stringify({depth,model,frames:result.vmaf.frames.length,rawBytes:result.raw.bytes,work:result.work,native:result.vmaf.resources,pooled:result.vmaf.pooled}));
});
test('uninstalled native component remains explicitly unavailable',{timeout:120000},async t=>{
 const f=await nativeFixture({component:false});t.after(()=>f.close());const c=await f.json('/api/quality/vmaf/capability');assert.equal(c.enabled,false);assert.equal((await f.request('/api/quality/vmaf/jobs',f.input)).status,503);
});

test('raw budgets, cadence, changed source and stride refuse without a fabricated sequence result',{timeout:120000},async t=>{
 const f=await nativeFixture();t.after(()=>f.close());
 assert.equal((await f.request('/api/quality/vmaf/preflight',{...f.input,cadenceUs:1})).status,400);
 const input={...f.input,budget:{...f.input.budget,maxRawBytes:1024}},created=await f.json('/api/quality/vmaf/jobs',input,'raw-limit'),failed=await f.wait(created.job.id);assert.equal(failed.state,'failed');assert.equal(failed.reason.code,'budget-exceeded');assert.equal(failed.resultDigest,null);assert.notEqual(failed.metrics.vmaf.state,'completed');
 const p=(await f.json('/api/quality/correspondence-plans',{...f.planInput,sampling:{mode:'stride',every:2,offset:0}},'stride')).plan;let done;for(let n=0;n<500;n++){done=(await f.json('/api/quality/correspondence-plans/'+p.id)).plan;if(!['queued','running'].includes(done.state))break;await new Promise(r=>setTimeout(r,10));}assert.equal(done.state,'completed');assert.equal((await f.request('/api/quality/vmaf/preflight',{...f.input,plan:{id:p.id,attemptId:done.attemptId,digest:done.resultDigest}})).status,400);
 await writeFile(path.join(f.media,'reference.flv'),Buffer.concat([await readFile(path.join(f.media,'reference.flv')),Buffer.from([0])]));assert.equal((await f.request('/api/quality/vmaf/preflight',f.input)).status,400);
 // Receipt lookup is independent of an already changed source and private C result.
 assert.equal((await f.json('/api/quality/vmaf/jobs',input,'raw-limit')).job.id,created.job.id);
});

test('actual untagged encoded source is not relabelled as SDR to pass VMAF',{timeout:120000},async t=>{const f=await nativeFixture({tagged:false});t.after(()=>f.close());const created=await f.json('/api/quality/vmaf/jobs',f.input,'missing-color'),j=await f.wait(created.job.id);assert.equal(j.state,'failed');assert.equal(j.resultDigest,null);assert.equal(j.metrics.vmaf.state,'failed');assert.match(j.reason.message,/color|colour|BT.709|chroma/i);});
