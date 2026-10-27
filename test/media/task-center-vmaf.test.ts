import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore fixed official native component and public HTTP fixture
import {nativeFixture,until} from '../helpers/native-vmaf.mjs';

test('five-store task center preserves real mixed MP4/FLV native VMAF result, plan, range and published viewer links',{timeout:90000},async t=>{
 const f=await nativeFixture({containers:['mp4','flv'],distorted:true});t.after(()=>f.close());
 const submitted=await f.json('/api/quality/vmaf/jobs',f.input,'task-center-native'),job=await f.wait(submitted.job.id);assert.equal(job.state,'completed',JSON.stringify(job));
 const input=await f.json(`/api/quality/correspondence-plans/${f.input.plan.id}/range-input`),single=(await f.json('/api/quality/jobs',{schema:'voidplayer-psnr-frame-job',version:1,client:{id:'task-native-single',kind:'agent'},request:input.pairs[0]},'single')).job;
 await until(()=>f.json(`/api/tasks/single/${single.id}`),(d:any)=>d.task.state==='completed');
 const range=(await f.json(`/api/quality/correspondence-plans/${f.input.plan.id}/execute`,{digest:f.input.plan.digest})).job;await until(()=>f.json(`/api/tasks/range/${range.id}`),(d:any)=>d.task.state==='completed');
 const task=await f.json(`/api/tasks/vmaf/${job.id}`),result=await f.json(`/api/quality/vmaf/jobs/${job.id}/result`);
 assert.equal(task.task.result.available,true);assert.equal(task.task.progress.metrics.vmaf.state,'completed');assert.equal(task.task.phase,'done');assert.ok(task.related.some((r:any)=>r.id===f.input.plan.id));assert.deepEqual(task.task.sources.map((s:any)=>s.mediaId),f.entries.map((e:any)=>e.id));
 const selected=await f.json(`/api/tasks?mediaId=${f.entries[0].id}&metric=vmaf&state=completed`);assert.deepEqual(selected.entries.map((e:any)=>e.id),[job.id]);
 const all=await f.json(`/api/tasks?mediaId=${f.entries[0].id}&limit=50`);assert.deepEqual(new Set(all.entries.map((e:any)=>e.kind)),new Set(['preparation','correspondence','single','range','vmaf']));
 const publication=await f.json(`/api/quality/vmaf/jobs/${job.id}/candidates`,{space:'default',side:'reference',maxScore:100,limit:1,minFrameDistance:1,text:'Explicit task center sequence candidate',severity:2});assert.equal(publication.createdIds.length,1);
 const receipt=await f.json(task.links.find((l:any)=>l.rel==='candidate-receipt').href);assert.deepEqual(receipt,publication);
 const record=await f.json(`/api/annotations/spaces/default/${publication.createdIds[0]}`);assert.equal(record.document.mark.qualityEvidence[0].value.sequenceVmaf.jobId,job.id);
 await f.json(`/api/tasks/vmaf/${job.id}/cancel`,{});assert.deepEqual(await f.json(`/api/quality/vmaf/jobs/${job.id}/result`),result);assert.deepEqual(await f.json(task.links.find((l:any)=>l.rel==='candidate-receipt').href),receipt);
});
