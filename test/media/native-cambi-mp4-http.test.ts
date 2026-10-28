import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {cambiFixture,cambiOracle,sha} from '../helpers/native-cambi.mjs';
import {cambiEvidenceList} from '../../shared/review/cambi-evidence.ts';
import {until} from '../helpers/native-vmaf.mjs';
import {processStartTicks} from '../../server/analysis/vmaf/runner.ts';
import {annotationWorkspace} from '../../shared/review/annotation-record.ts';

for(const [codec,depth,variant='forward']of [['h264',8],['hevc',8],['hevc',10],['hevc',10,'reordered']] as const)test(`strict MP4 CAMBI ${codec}/${depth}/${variant}: official score/map bytes and complete source witness`,{timeout:120000},async t=>{
 const f=await cambiFixture({container:'mp4',codec,depth,variant});t.after(()=>f.close());
 const {job}=await f.json('/api/quality/cambi/jobs',f.input,'mp4');const done=await f.wait(job.id);assert.equal(done.state,'completed',JSON.stringify(done));
 const result=await f.json(`/api/quality/cambi/jobs/${job.id}/result`),page=await f.json(`/api/quality/cambi/jobs/${job.id}/frames`),oracle=await cambiOracle(f,depth);
 assert.equal(result.version,2);assert.deepEqual(result.pooled,oracle.result.pooled_metrics.cambi);assert.equal(result.coverage.scored,4);if(variant==='reordered'){assert.ok(page.entries[0].target.sourcePtsUs>0);assert.ok(page.entries.some((f:any)=>f.provenance.dependency.outputIdentity.outputs.some((o:any)=>o.phase==='drain')));assert.ok(page.entries.every((f:any,i:number)=>i===0||f.target.sourcePtsUs>page.entries[i-1].target.sourcePtsUs));}
 const frameBytes=f.sample.width*f.sample.height*3/2*(depth===8?1:2);
 for(const row of page.entries){
  const p=row.provenance,c=p.container;assert.equal(c.kind,'mp4');assert.equal(c.tableSha256,f.sample.tableSha256);assert.equal(c.sample.ordinal,row.target.picture.au);assert.equal(c.sample.ptsUs,row.target.sourcePtsUs);assert.equal(c.sample.offset,p.packet.offset);assert.equal(row.context.basis,'complete-mp4-index-derived-v1');assert.equal(row.proof.producer.producer,'server-mp4-scan-v1');assert.equal(row.proof.producer.tableSha256,c.tableSha256);
  assert.equal(row.rawSha256,sha(f.raw.subarray(row.index*frameBytes,(row.index+1)*frameBytes)));assert.equal(row.score,oracle.result.frames[row.index].metrics.cambi);
  for(const scale of result.output.scales){const actual=Buffer.from(await(await f.request(`/api/quality/cambi/jobs/${job.id}/heatmap?index=${row.index}&scale=${scale.scale}`)).arrayBuffer()),expected=(await readFile(path.join(oracle.directory,'heat',scale.file))).subarray(row.index*scale.bytes,(row.index+1)*scale.bytes);assert.deepEqual(actual,expected);assert.equal(sha(actual),row.heatmaps[scale.scale].sha256);}
 }
 const policy={space:'default',minScore:0,limit:1,scale:1,cellThreshold:1,text:'Exact MP4 official banding evidence',severity:2};
 const pub=await f.json(`/api/quality/cambi/jobs/${job.id}/candidates`,policy);assert.equal(pub.createdIds.length,1);
 const annotation=await f.json('/api/annotations/spaces/default/'+pub.createdIds[0]),e=annotation.document.mark.cambiEvidence[0];assert.equal(e.version,2);assert.doesNotThrow(()=>cambiEvidenceList([e],true));
 const peer='guest-'+randomUUID(),extra={cookie:'voidplayer-user='+peer,'x-voidplayer-actor':peer};assert.equal((await f.request('/api/quality/cambi/jobs/'+job.id,undefined,undefined,extra)).status,404);
 const picture=await f.json(`/api/quality/cambi/shared/default/${annotation.id}/${e.id}/picture`,undefined,undefined,extra);assert.equal(picture.rawSha256,e.value.frame.rawSha256);assert.equal(picture.source.indexIdentity.kind,'mp4');
 for(const scale of result.output.scales){const response=await f.request(`/api/quality/cambi/shared/default/${annotation.id}/${e.id}?scale=${scale.scale}`,undefined,undefined,extra);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),e.value.frame.heatmaps[scale.scale].sha256);}
 for(const mutate of [(v:any)=>v.version=1,(v:any)=>v.value.frame.provenance.container.trackId++,(v:any)=>v.value.frame.provenance.container.timescale++,(v:any)=>v.value.frame.provenance.container.sample.ctsTicks++,(v:any)=>v.value.frame.proof.producer.tableSha256='0'.repeat(64),(v:any)=>v.value.frame.context.basis='complete-flv-index-derived-v1']){const invalid=structuredClone(e);mutate(invalid);assert.throws(()=>cambiEvidenceList([invalid],true));}
 const workspace=annotationWorkspace([annotation.document],f.base);assert.equal(workspace.marks[0].cambiEvidence![0].version,2);assert.equal(workspace.marks[0].cambiEvidence![0].verification,'historical');
 const task=await f.json(`/api/tasks/cambi/${job.id}`);assert.equal(task.task.sources[0].mediaId,f.input.source.mediaId);assert.equal(task.task.resultDigest,done.resultDigest);
 assert.equal((await f.json('/api/quality/cambi/jobs',f.input,'mp4')).job.id,job.id);assert.equal((await f.request('/api/quality/cambi/jobs',{...f.input,source:{...f.input.source,indexBuildId:'changed'}},'changed')).status,202);const failed=await f.wait((await f.json('/api/quality/cambi/jobs',{...f.input,source:{...f.input.source,indexBuildId:'changed'}},'changed')).job.id);assert.equal(failed.state,'failed');
 await writeFile(path.join(f.media,f.fileName),Buffer.concat([Buffer.from(f.sample.mp4,'base64'),Buffer.from([0])]));assert.equal((await f.request(`/api/quality/cambi/shared/default/${annotation.id}/${e.id}/picture`,undefined,undefined,extra)).status,400);
});


test('strict MP4 CAMBI distinguishes a missing component without substituting another metric',{timeout:120000},async t=>{
 const missing=await cambiFixture({container:'mp4',component:false});t.after(()=>missing.close());const response=await missing.request('/api/quality/cambi/jobs',missing.input,'missing');assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,'component-unavailable');assert.ok(body.recovery.operations.includes('/api/agent/operations/cambi.capability'));assert.equal((await missing.json('/api/quality/cambi/jobs')).entries.length,0);
});

for(const mode of ['cancel','deadline'] as const)test(`strict MP4 CAMBI native ${mode} retains admission until physical exit`,{timeout:120000},async t=>{
 const f=await cambiFixture({container:'mp4',codec:'hevc',depth:10,variant:'reordered'});t.after(()=>f.close());const runner=(f.service.library.qualityCambi as any).runner,run=runner.runCambi.bind(runner);let pid=0;
 runner.runCambi=(id:any,input:any,signal:any,hooks:any)=>run(id,input,signal,{...hooks,process:(p:any)=>{hooks.process(p);if(p){pid=p.pid;process.kill(pid,'SIGSTOP');}}});
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:mode==='deadline'?3000:120000}},job=(await f.json('/api/quality/cambi/jobs',input,mode)).job;await until(()=>pid,Boolean);assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 if(mode==='cancel'){const stopped=await f.json(`/api/tasks/cambi/${job.id}/cancel`,{});assert.equal(stopped.task.state,'cancelling');assert.equal(stopped.task.endedAt,null);assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});}
 const done=await f.wait(job.id);assert.equal(done.state,mode==='cancel'?'cancelled':'failed',JSON.stringify(done));assert.equal(done.resultDigest,null);assert.equal(processStartTicks(pid),null);const release=f.service.library.qualityAdmission.acquire();release();assert.equal((await f.request(`/api/quality/cambi/jobs/${job.id}/result`)).status,409);assert.equal((await f.json('/api/quality/cambi/jobs',input,mode)).job.attemptId,done.attemptId);
});
