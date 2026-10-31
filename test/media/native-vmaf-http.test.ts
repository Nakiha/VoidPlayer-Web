import {replaceRunnerAnalysisDirectory} from '../helpers/analysis-component-fixture.ts';
import {assertVmafOfficial as assertOfficial} from '../helpers/official-quality-oracle.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {nativeFixture,officialOracle,until} from '../helpers/native-vmaf.mjs';
import {qualityEvidenceValue,qualityEvidenceList} from '../../shared/review/quality-evidence.ts';
import {AnnotationStore} from '../../server/annotations.ts';
import {startService} from '../../server/runtime.ts';
const existing=[[8,false,'vmaf_v0_6_1','h264'],[8,true,'vmaf_v0_6_1neg','h264'],[10,true,'vmaf_v0_6_1','hevc'],[8,true,'vmaf_v0_6_1','hevc'],[10,true,'vmaf_v0_6_1','h264']] as const;
const mixed=([['h264',8],['hevc',8],['hevc',10]] as const).flatMap(([codec,depth])=>([['mp4','mp4'],['mp4','flv'],['flv','mp4']] as const).map(containers=>({depth,distorted:true,model:'vmaf_v0_6_1neg' as const,codec,containers})));
for(const {depth,distorted,model,codec,containers}of [...existing.map(([depth,distorted,model,codec])=>({depth,distorted,model,codec,containers:undefined})),...mixed])test(`real native VMAF HTTP ${codec}/${depth} ${(containers??['flv','flv']).join('→')} ${distorted?'distorted':'same'} ${model}`,{timeout:120000},async t=>{
 const f=await nativeFixture({depth,distorted,codec,containers});t.after(()=>f.close());const input={...f.input,model};
 const pre=await f.json('/api/quality/vmaf/preflight',input);assert.equal(pre.nativeExecution,false);assert.equal(pre.rawColorVerification,'required-at-execution');
 const r=await f.request('/api/quality/vmaf/jobs',input,'one-job');assert.equal(r.status,202);const j=(await r.json()).job;
 assert.equal((await f.request('/api/quality/vmaf/jobs',input,'one-job',{'x-voidplayer-actor':'wrong'})).status,409);
 const other='guest-'+randomUUID();assert.equal((await f.request('/api/quality/vmaf/jobs/'+j.id,undefined,undefined,{cookie:'voidplayer-user='+other,'x-voidplayer-actor':other})).status,404);
 const final=await f.wait(j.id);assert.equal(final.state,'completed',JSON.stringify(final));assert.equal(final.metrics.psnr.state,'completed');assert.equal(final.metrics.ssim.state,'completed');assert.equal(final.metrics.vmaf.state,'completed');assert.equal(final.process,null);
 const result=await f.json(`/api/quality/vmaf/jobs/${j.id}/result`),oracle=await officialOracle(f,depth,model);
 assert.equal(result.vmaf.frames.length,8);assert.equal(result.raw.referenceSha256,oracle.hashes[0]);assert.equal(result.raw.distortedSha256,oracle.hashes[1]);assertOfficial(result.vmaf.frames,oracle.result.frames.map((v:any)=>({index:v.frameNum,score:v.metrics.vmaf})));assertOfficial(result.vmaf.pooled,oracle.result.pooled_metrics.vmaf);
 assert.ok(result.work.outputFrames>=16,'actual decoded outputs are charged');assert.equal(result.vmaf.resources.executor,'analysis-wasm');assert.ok(result.vmaf.resources.heapBytes>0);assert.ok(result.vmaf.resources.wallMs>0);
 const replay=await f.json('/api/quality/vmaf/jobs',input,'one-job');assert.equal(replay.job.id,j.id);assert.equal(replay.replayed,true);assert.equal(replay.job.attemptId,final.attemptId);
 assert.equal((await f.request('/api/quality/vmaf/jobs',{...input,cadenceUs:1},'one-job')).status,409);
 const page=await f.json(`/api/quality/vmaf/jobs/${j.id}/frames?limit=4`);assert.equal(page.entries.length,4);assert.equal(page.next,4);
 const tail=await f.json(`/api/quality/vmaf/jobs/${j.id}/frames?after=4&limit=4`);assert.equal(tail.next,null);
 for(const {index,pair}of [...page.entries,...tail.entries]){
  const unit=depth===10?2:1,frameBytes=128*96*3/2*unit;let offset=index*frameBytes,total=0;
  for(const [plane,count]of [['y',128*96],['u',64*48],['v',64*48]]as const){let sse=0;for(let n=0;n<count;n++){const at=offset+n*unit,a=unit===1?f.oracles.reference[at]:f.oracles.reference.readUInt16LE(at),b=unit===1?f.oracles.distorted[at]:f.oracles.distorted.readUInt16LE(at);sse+=(a-b)**2;}assert.equal(pair.result.metric.planes[plane].sse,sse);assert.equal(pair.result.metric.planes[plane].samples,count);offset+=count*unit;total+=sse;}
  assert.equal(pair.result.metric.aggregate.sse,total);assert.equal(pair.result.ssim.variant,'ffmpeg-uniform-8x8-step4-v1');
 }
 const policy={space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'Explicit temporal full-frame measurement candidate, not a defect judgment',severity:3};
 const p=await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`,policy);assert.equal(p.createdIds.length,1);const a=await f.json('/api/annotations/spaces/default/'+p.createdIds[0]),e=a.document.mark.qualityEvidence[0];assert.equal(e.verification,'server-verified');assert.equal(e.value.sequenceVmaf.spatial,'full-frame-temporal-score-not-localized');assertOfficial(e.value.sequenceVmaf.score,oracle.result.frames[e.value.sequenceVmaf.index].metrics.vmaf);assert.doesNotThrow(()=>qualityEvidenceValue(e.value));
 const expectedVersion=containers?.includes('mp4')?2:1;assert.equal(f.service.library.qualityVmaf.result(j.id,f.actor).version,expectedVersion);assert.equal(e.value.version,expectedVersion);assert.equal(e.value.sequenceVmaf.version,expectedVersion);
 for(const side of ['reference','distorted'] as const){const mp4=e.value.sources[side].binding.indexIdentity.kind==='mp4';for(const frame of e.value.sequenceVmaf.sequence.pairs){assert.equal(!!frame[side].container,mp4);if(mp4){assert.equal(frame[side].container.sample.ordinal,frame[side].au);assert.equal(frame[side].container.sample.ptsUs,frame[side].sourcePtsUs);}else assert.deepEqual(Object.keys(frame[side]).sort(),['au','decode','sourcePtsUs'],'FLV temporal evidence retains its v1 fields');}}
 if(expectedVersion===2){const old=structuredClone(e.value);old.sequenceVmaf.version=1;assert.throws(()=>qualityEvidenceValue(old));const bad=structuredClone(e.value),side=bad.sources.reference.binding.indexIdentity.kind==='mp4'?'reference':'distorted';bad.sequenceVmaf.sequence.pairs.at(-1)[side].container.sample.ctsTicks++;assert.throws(()=>qualityEvidenceValue(bad));}

 const forged=structuredClone(e.value);forged.sequenceVmaf.recipe.preprocessing='resize';assert.throws(()=>qualityEvidenceValue(forged));
 assert.deepEqual((await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`,policy)).createdIds,p.createdIds);
 const historical=qualityEvidenceList([e]);assert.equal(historical[0].verification,'historical');assert.deepEqual(historical[0].value.sequenceVmaf,e.value.sequenceVmaf);
 const edited=structuredClone(a.document);edited.mark.text='Ordinary text edit retains attached temporal evidence';delete edited.mark.qualityEvidence;delete edited.mark.qualityCandidate;
 const changed=await f.json('/api/annotations/spaces/default',{action:'put',operationId:randomUUID(),id:a.id,revision:a.revision,document:edited},'edit',{'x-voidplayer-action':'annotation'});assert.deepEqual(changed.document.mark.qualityEvidence[0].value.sequenceVmaf,e.value.sequenceVmaf);
 const fake=structuredClone(changed.document);fake.mark.qualityEvidence[0].value.sequenceVmaf.component.binarySha256='f'.repeat(64);assert.equal((await f.request('/api/annotations/spaces/default',{action:'put',operationId:randomUUID(),id:a.id,revision:changed.revision,document:fake},'forge',{'x-voidplayer-action':'annotation'})).status,409);
 // Simulated result reclamation must not make either frozen receipt execute again.
 f.service.library.qualityVmaf.db.prepare('UPDATE quality_vmaf_jobs SET result=NULL WHERE id=?').run(j.id);
 assert.equal((await f.json('/api/quality/vmaf/jobs',input,'one-job')).job.id,j.id);
 assert.deepEqual((await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`,policy)).createdIds,p.createdIds);
 assert.equal((await f.request(`/api/quality/vmaf/jobs/${j.id}/candidates`,{...policy,severity:4})).status,409);
 console.log(JSON.stringify({codec,depth,model,frames:result.vmaf.frames.length,rawBytes:result.raw.bytes,work:result.work,native:result.vmaf.resources,executionWallMs:final.endedAt-final.startedAt,preparedFramesPerSecond:8000/(final.endedAt-final.startedAt),pooled:result.vmaf.pooled}));
});
test('missing analysis component remains explicitly unavailable',{timeout:120000},async t=>{
 const f=await nativeFixture();t.after(()=>f.close());await replaceRunnerAnalysisDirectory((f.service.library.qualityVmaf as any).runner,path.join(f.directory,'missing-analysis'));const c=await f.json('/api/quality/vmaf/capability');assert.equal(c.enabled,false);assert.equal((await f.request('/api/quality/vmaf/jobs',f.input)).status,503);
});

test('MP4 decode/input/index budgets reject before reporting a fabricated native score',{timeout:120000},async t=>{
 const f=await nativeFixture({containers:['mp4','mp4']});t.after(()=>f.close());
 for(const budget of ['maxReadBytes','maxInputBytes'] as const){
  const request=structuredClone(f.planInput);request.recipe.budget[budget]=512;
  const p=(await f.json('/api/quality/correspondence-plans',request,'small-'+budget)).plan,ready=await until(()=>f.json('/api/quality/correspondence-plans/'+p.id),(r:any)=>r.plan.state==='completed','Budget plan');
  const input={...f.input,plan:{id:p.id,attemptId:ready.plan.attemptId,digest:ready.plan.resultDigest}},j=(await f.json('/api/quality/vmaf/jobs',input,'small-'+budget)).job,done=await f.wait(j.id);
  assert.equal(done.state,'failed',JSON.stringify(done));assert.equal(done.reason.code,'budget-exceeded');assert.equal(done.resultDigest,null);assert.equal((await f.request(`/api/quality/vmaf/jobs/${j.id}/result`)).status,409);const release=f.service.library.qualityAdmission.acquire();release();
 }
 const {openIndexDatabase}=await import('../../server/sqlite.ts');const db=openIndexDatabase(f.service.library.indexDatabase);
 try{const original=Number(db.prepare('SELECT bytes FROM media_index_manifests WHERE media_id=?').get(f.entries[0].id)!.bytes);db.prepare('UPDATE media_index_manifests SET bytes=? WHERE media_id=?').run(67108865,f.entries[0].id);
  const response=await f.request('/api/quality/vmaf/preflight',f.input);assert.equal(response.status,400);assert.equal((await response.json()).code,'budget-exceeded');db.prepare('UPDATE media_index_manifests SET bytes=? WHERE media_id=?').run(original,f.entries[0].id);
 }finally{db.close();}
});

test('MP4 unknown annotation commit, restart and reclaimed result replay the frozen receipt without new execution',{timeout:120000},async t=>{
 const f=await nativeFixture({containers:['flv','mp4']});let restarted:Awaited<ReturnType<typeof startService>>|undefined;t.after(async()=>{await restarted?.close();await f.close();});
 const j=(await f.json('/api/quality/vmaf/jobs',f.input,'unknown-mp4')).job,done=await f.wait(j.id);assert.equal(done.state,'completed');assert.equal(await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`),null);
 const policy={space:'default',side:'distorted',maxScore:100,limit:1,minFrameDistance:1,text:'Explicit MP4 temporal candidate with uncertain transaction response',severity:2};
 const original=AnnotationStore.prototype.mutate;let injected=false;
 AnnotationStore.prototype.mutate=function(...args:Parameters<typeof original>){const result=original.apply(this,args);if(!injected&&(args[1] as {action?:string})?.action==='create-quality-candidate'&&args[2].id===f.actor){injected=true;throw Error('Injected after the real annotation transaction committed');}return result;};
 try{const response=await f.request(`/api/quality/vmaf/jobs/${j.id}/candidates`,policy),body=await response.json();assert.equal(injected,true,JSON.stringify(body));assert.equal(response.status,500,JSON.stringify(body));}finally{AnnotationStore.prototype.mutate=original;}
 assert.equal(injected,true);const frozen=await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`);assert.equal(frozen.selected.length,1);assert.deepEqual(frozen.createdIds,[]);
 const id=frozen.selected[0].id,record=await f.json('/api/annotations/spaces/default/'+id);assert.equal(record.revision,1);assert.equal(record.document.mark.qualityEvidence[0].value.sequenceVmaf.version,2);
 f.service.library.qualityVmaf.db.prepare('UPDATE quality_vmaf_jobs SET result=NULL WHERE id=?').run(j.id);const port=Number(new URL(f.base).port);await f.stop();f.config.port=port;restarted=await startService(f.config,false);
 let executions=0;const runner=(restarted.library.qualityVmaf as any).runner,run=runner.run.bind(runner);runner.run=(...args:any[])=>{executions++;return run(...args);};
 assert.equal((await f.request(`/api/quality/vmaf/jobs/${j.id}/result`)).status,409);assert.equal((await f.json('/api/quality/vmaf/jobs',f.input,'unknown-mp4')).job.attemptId,done.attemptId);
 const recovered=await f.json(`/api/quality/vmaf/jobs/${j.id}/candidates`,policy);assert.deepEqual(recovered.createdIds,[id]);assert.deepEqual(recovered.selected,frozen.selected);assert.equal((await f.json('/api/annotations/spaces/default/'+id)).revision,1);assert.equal(executions,0);
 assert.equal((await f.request(`/api/quality/vmaf/jobs/${j.id}/candidates`,{...policy,severity:3})).status,409);
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
