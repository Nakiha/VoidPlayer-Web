import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {cambiFixture,cambiOracle,sha} from '../helpers/native-cambi.mjs';
import {cambiEvidenceList} from '../../shared/review/cambi-evidence.ts';
import {annotationWorkspace} from '../../shared/review/annotation-record.ts';

for(const [codec,depth]of [['h264',8],['hevc',8],['hevc',10]] as const)test(`strict MP4 CAMBI ${codec}/${depth}: official score/map bytes and complete source witness`,{timeout:120000},async t=>{
 const f=await cambiFixture({container:'mp4',codec,depth});t.after(()=>f.close());
 const {job}=await f.json('/api/quality/cambi/jobs',f.input,'mp4');const done=await f.wait(job.id);assert.equal(done.state,'completed',JSON.stringify(done));
 const result=await f.json(`/api/quality/cambi/jobs/${job.id}/result`),page=await f.json(`/api/quality/cambi/jobs/${job.id}/frames`),oracle=await cambiOracle(f,depth);
 assert.equal(result.version,2);assert.deepEqual(result.pooled,oracle.result.pooled_metrics.cambi);assert.equal(result.coverage.scored,4);
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
