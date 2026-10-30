import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {startService} from '../../server/runtime.ts';
// @ts-ignore reusable real public-HTTP fixture
import {nativeFixture,until} from '../helpers/native-vmaf.mjs';

test('no-frontend task center: real preparations/C/single/range, exact filters, immutable pages, actor isolation, restart and original candidate receipts', {timeout:90000},async t=>{
 const f=await nativeFixture({component:false,containers:['mp4','flv']});let restarted:Awaited<ReturnType<typeof startService>>|undefined;t.after(async()=>{await restarted?.close();await f.close();});
 const rangeInput=await f.json(`/api/quality/correspondence-plans/${f.input.plan.id}/range-input`),singleInput={schema:'voidplayer-psnr-frame-job',version:1,client:{id:'task-center-http',kind:'agent'},request:rangeInput.pairs[0]};
 const single=(await f.json('/api/quality/jobs',singleInput,'single')).job;
 const range=(await f.json(`/api/quality/correspondence-plans/${f.input.plan.id}/execute`,{digest:f.input.plan.digest})).job;
 const wait=async(kind:string,id:string)=>until(()=>f.json(`/api/tasks/${kind}/${id}`),(d:any)=>!['queued','preparing','running','cancelling'].includes(d.task.state));
 assert.equal((await wait('single',single.id)).task.state,'completed');assert.equal((await wait('range',range.id)).task.state,'completed');
 let page=await f.json(`/api/tasks?mediaId=${f.entries[0].id}&mediaVersion=${f.entries[0].version}&limit=2`);const first=page,all=[...page.entries];
 while(page.nextCursor){page=await f.json(`/api/tasks?mediaId=${f.entries[0].id}&mediaVersion=${f.entries[0].version}&limit=2&cursor=${page.nextCursor}`);all.push(...page.entries);}
 assert.deepEqual(new Set(all.map((r:any)=>r.kind)),new Set(['preparation','correspondence','single','range']));assert.equal(new Set(all.map((r:any)=>r.id)).size,first.total);assert.ok(all.every((r:any)=>r.sources.some((s:any)=>s.mediaId===f.entries[0].id&&s.mediaVersion===f.entries[0].version)));
 assert.ok(!JSON.stringify(all).includes('index.packets'));assert.ok(!JSON.stringify(all).includes('value.result'));assert.equal((await f.json('/api/tasks?kind=vmaf')).total,0,'history works without native component');
 const detail=await f.json(`/api/tasks/range/${range.id}`);assert.equal(detail.task.result.retained,8);assert.ok(detail.related.some((r:any)=>r.kind==='correspondence'&&r.id===f.input.plan.id));assert.ok(detail.related.some((r:any)=>r.kind==='single'));
 const policy={space:'default',side:'reference',metric:'psnr',maxDb:120,limit:1,minAuDistance:0,text:'Task center explicit candidate',severity:2};
 // Equal content can yield infinity: retain the explicit receipt even if it selects no candidate.
 const publication=await f.json(`/api/quality/ranges/${range.id}/candidates`,policy);
 const receiptLink=detail.links.find((l:any)=>l.rel==='candidate-receipt');assert.deepEqual((await f.json(receiptLink.href)).createdIds,publication.createdIds);
 const before=await f.json(`/api/quality/ranges/${range.id}`);assert.equal((await f.json(`/api/tasks/range/${range.id}/cancel`,{})).task.state,'completed');assert.deepEqual(await f.json(`/api/quality/ranges/${range.id}`),before,'terminal cancel preserves old job/results');
 const other='guest-'+randomUUID(),otherHeaders={cookie:'voidplayer-user='+other,'x-voidplayer-actor':other};
 assert.equal((await f.json('/api/tasks',undefined,undefined,otherHeaders)).total,0);
 assert.equal((await f.request(`/api/tasks/range/${range.id}`,undefined,undefined,otherHeaders)).status,404);
 assert.equal((await f.request(`/api/tasks/range/${range.id}/cancel`,{},undefined,otherHeaders)).status,404);
 assert.equal((await f.request('/api/tasks?cursor='+first.nextCursor,undefined,undefined,otherHeaders)).status,409);
 assert.equal((await f.request('/api/tasks',undefined,undefined,{'x-voidplayer-actor':other})).status,409);
 assert.equal((await f.request(`/api/tasks/single/${single.id}/cancel`,{},undefined,{origin:'http://cross.invalid'})).status,403);
 assert.equal((await f.request(`/api/tasks/single/${single.id}/cancel`,{anything:true})).status,400);
 for(const path of ['/api/tasks?limit=51','/api/tasks?kind=nr','/api/tasks?kind=single&kind=range','/api/tasks?unknown=1'])assert.equal((await f.request(path)).status,400,path);
 const beforeReads=await f.json('/api/quality/jobs');let reads=0;const create=f.service.library.quality.createWorker;f.service.library.quality.createWorker=(data:any)=>{reads++;return create(data);};
 for(const method of ['GET','HEAD']){const r=await fetch(f.base+'/api/tasks?limit=1',{method,headers:f.headers});assert.equal(r.status,200);if(method==='HEAD')assert.equal(await r.text(),'');}
 assert.equal(reads,0);assert.deepEqual(await f.json('/api/quality/jobs'),beforeReads,'summary reads do not schedule or mutate jobs');
 const rangeLimits=(await f.json('/api/quality/ranges')).limits;assert.equal(rangeLimits.historyRetention.policy,'logical-byte-budget');assert.equal(rangeLimits.historyRetention.legacyHistoryRows,'deprecated-not-enforced');assert.equal((await f.json('/api/agent/operations/tasks.query')).request.limits.rows,2240);
 const catalog=await f.json('/api/agent/tasks/tasks');assert.deepEqual(catalog.operations.map((operation:any)=>operation.id).sort(),['tasks.query','tasks.get','tasks.cancel.preparation','tasks.cancel.correspondence','tasks.cancel.single','tasks.cancel.range','tasks.cancel.vmaf','tasks.cancel.xpsnr','tasks.cancel.cambi','tasks.release.single','tasks.release.range','tasks.release.vmaf','tasks.release.xpsnr','tasks.release.cambi'].sort());const releaseOperation=await f.json('/api/agent/operations/tasks.release.range');assert.equal(releaseOperation.execution.sideEffects,'release');assert.equal(releaseOperation.write.action,'quality-job');assert.match(releaseOperation.recovery.unknownPost,/same explicit release target/);assert.match(await fetch(f.base+'/agent/quality/tasks.md').then(r=>r.text()),/task-cursor-expired/);
 await f.stop();restarted=await startService(f.config,false);const base=`http://127.0.0.1:${(restarted.server.address() as any).port}`;
 assert.equal((await fetch(base+'/api/tasks?cursor='+first.nextCursor,{headers:f.headers})).status,409);
 const fresh=await fetch(base+`/api/tasks?mediaId=${f.entries[0].id}`,{headers:f.headers}).then(r=>r.json());assert.ok(fresh.entries.some((r:any)=>r.id===range.id&&r.result.available));
 const r=await fetch(base+receiptLink.href,{headers:f.headers}).then(r=>r.json());assert.deepEqual(r.createdIds,publication.createdIds,'restart retains original candidate receipt');
});

test('unified cancel retains the real Worker permit until physical exit; observer disconnect is read-only',{timeout:60000},async t=>{
 const f=await nativeFixture({component:false});const runner=f.service.library.quality,create=runner.createWorker,gate=new Int32Array(new SharedArrayBuffer(8));
 let worker:Worker|undefined,terminateCalled=false,release:()=>void=()=>{},exits=0,physicalStop:(()=>Promise<number>)|undefined;
 t.after(async()=>{release();if(worker&&exits===0)await physicalStop?.();await f.close();});
 runner.createWorker=(data:any)=>{worker=new Worker(new URL('../helpers/quality-workflow-worker.ts',import.meta.url),{workerData:{...data,gate:gate.buffer}});worker.once('exit',()=>exits++);const stop=worker.terminate.bind(worker);physicalStop=stop;worker.terminate=()=>{terminateCalled=true;return new Promise<number>((resolve,reject)=>{release=()=>{void stop().then(resolve,reject);};});};return worker;};
 const input=await f.json(`/api/quality/correspondence-plans/${f.input.plan.id}/range-input`),job=(await f.json('/api/quality/jobs',{schema:'voidplayer-psnr-frame-job',version:1,client:{id:'task-cancel',kind:'agent'},request:input.pairs[0]},'cancel')).job;
 await until(()=>Atomics.load(gate,1),Boolean,'real decode gate');
 // The same held real permit keeps other original services queued. Cancel
 // through the unified route without transferring or releasing that permit.
 const prepared=(await f.json('/api/library/preparations',{source:{id:f.entries[0].id,version:f.entries[0].version},operation:'quality-index',client:{id:'task-cancel-preparation',name:'Explicit cancellation'}},'queued-prep',{'x-voidplayer-action':'library-preparation'})).job;
 assert.equal((await f.request(`/api/tasks/preparation/${prepared.id}/cancel`,{})).status,403,'original preparation action still required');
 await f.json(`/api/tasks/preparation/${prepared.id}/cancel`,{},undefined,{'x-voidplayer-action':'library-preparation'});await until(()=>f.json(`/api/library/preparations/${prepared.id}`),(j:any)=>j.state==='cancelled');
 const planned=(await f.json('/api/quality/correspondence-plans',f.planInput,'queued-plan')).plan;await f.json(`/api/tasks/correspondence/${planned.id}/cancel`,{});await until(()=>f.json(`/api/quality/correspondence-plans/${planned.id}`),(d:any)=>d.plan.state==='cancelled');
 const ranged=(await f.json('/api/quality/ranges',input,'queued-range')).job;await f.json(`/api/tasks/range/${ranged.id}/cancel`,{});await until(()=>f.json(`/api/quality/ranges/${ranged.id}`),(d:any)=>d.job.state==='cancelled');
 assert.equal(exits,0);assert.throws(()=>f.service.library.qualityAdmission.acquire(),(e:any)=>e.code==='quality-busy','cancelling other tasks cannot release the active single permit');
 const controller=new AbortController();const observed=fetch(f.base+`/api/tasks/single/${job.id}`,{headers:f.headers,signal:controller.signal});controller.abort();await observed.catch(()=>{});
 assert.equal((await f.json(`/api/tasks/single/${job.id}`)).task.state,'running');
 const cancelled=await f.json(`/api/tasks/single/${job.id}/cancel`,{});assert.equal(cancelled.task.state,'cancelling');assert.equal(cancelled.task.endedAt,null);
 await until(()=>terminateCalled,Boolean,'real terminate requested');assert.equal(exits,0);assert.throws(()=>f.service.library.qualityAdmission.acquire(),(e:any)=>e.code==='quality-busy');
 assert.equal((await f.json(`/api/tasks/single/${job.id}/cancel`,{})).task.state,'cancelling');release();
 const done=await until(()=>f.json(`/api/tasks/single/${job.id}`),(d:any)=>d.task.state==='cancelled');assert.equal(exits,1);assert.ok(done.task.endedAt);const permit=f.service.library.qualityAdmission.acquire();permit();runner.createWorker=create;
});
