import {replaceRunnerAnalysisDirectory} from '../helpers/analysis-component-fixture.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {requirePacketOutputWitness} from '../../shared/analysis/quality/frame-pair.ts';
import {startService} from '../../server/runtime.ts';
import {writeFile,readFile,cp} from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';
import {cambiFixture} from '../helpers/native-cambi.mjs';import {until} from '../helpers/native-vmaf.mjs';
// @ts-ignore JavaScript Worker boundary helper
import {holdScoringWorker,controlledExecutionDeadline} from '../helpers/analysis-lifecycle.mjs';

for(const mode of ['cancel','deadline','crash'] as const)
test(`CAMBI actual analysis ${mode}, physical exit before shared admission`,{timeout:120000},async t=>{
 const f=await cambiFixture();t.after(()=>f.close());const runner=(f.service.library.qualityCambi as any).runner;
 const gate=holdScoringWorker(runner,'scoring-frame');let expire:()=>void=()=>{};
 if(mode==='deadline'){const run=runner.runCambi.bind(runner);runner.runCambi=(...args:any[])=>{const clock=controlledExecutionDeadline(3000,()=>run(...args));expire=clock.expire;return clock.work;};}
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:mode==='deadline'?3000:120000}},j=(await f.json('/api/quality/cambi/jobs',input,'stop')).job;
 await until(()=>gate.held,Boolean);assert.ok(gate.workers.some((w:any)=>w.threadId!==-1));
 assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 if(mode==='cancel'){const c=await f.json(`/api/tasks/cambi/${j.id}/cancel`,{});assert.equal(c.task.state,'cancelling');assert.equal(c.task.endedAt,null);}
 else if(mode==='deadline')expire();else await gate.crash();
 const done=await f.wait(j.id);assert.equal(done.state,mode==='cancel'?'cancelled':'failed',JSON.stringify(done));assert.equal(done.resultDigest,null);
 assert.ok(gate.workers.every((w:any)=>w.threadId===-1));const release=f.service.library.qualityAdmission.acquire();release();
 assert.equal((await f.json('/api/quality/cambi/jobs',input,'stop')).job.attemptId,done.attemptId);
 assert.equal((await f.request(`/api/quality/cambi/jobs/${j.id}/result`)).status,409);
});

for(const corruption of ['truncate','hash','duplicate-scale','nonfinite-score','final-witness'] as const)
test(`CAMBI ${corruption} stream never produces a score or retained heatmaps`,{timeout:120000},async t=>{
 const f=await cambiFixture({container:'mp4',codec:'hevc',depth:10,variant:'reordered'});t.after(()=>f.close());
 const service=f.service.library.qualityCambi as any,runner=service.runner,run=runner.runCambi.bind(runner);
 runner.runCambi=(id:any,input:any,signal:any,hooks:any)=>run(id,input,signal,{...hooks,
  streamFrame:async(frame:any,header:any,score:any,maps:any[])=>{
   if(corruption==='truncate')maps[0].bytes=maps[0].bytes.subarray(0,1);
   if(corruption==='hash')maps[0].sha256='0'.repeat(64);
   if(corruption==='duplicate-scale')maps[1].scale=maps[0].scale;
   if(corruption==='nonfinite-score')score=NaN;
   return hooks.streamFrame(frame,header,score,maps);
  },prepared:(p:any)=>{if(corruption==='final-witness')p.frames[0].provenance.dependency.outputIdentity.outputs.pop();hooks.prepared(p);}});
 const done=await f.wait((await f.json('/api/quality/cambi/jobs',f.input,corruption)).job.id);
 assert.equal(done.state,'failed',JSON.stringify(done));assert.equal(done.resultDigest,null);
 assert.equal(service.db.prepare('SELECT count(*) AS n FROM cambi_heat WHERE job=?').get(done.id).n,0);
 assert.equal((await f.request(`/api/quality/cambi/jobs/${done.id}/frames`)).status,409);
 const release=f.service.library.qualityAdmission.acquire();release();
});

test('CAMBI shared queue labels bounded provisional frames without publishing and supports explicit queued cancellation',{timeout:120000},async t=>{
 const f=await cambiFixture();t.after(()=>f.close());const release=f.service.library.qualityAdmission.acquire();
 const a=await f.json('/api/quality/cambi/jobs',f.input,'queue1'),b=await f.json('/api/quality/cambi/jobs',f.input,'queue2');
 assert.equal((await f.request('/api/quality/cambi/jobs',f.input,'queue3')).status,429);
 assert.equal((await f.json('/api/quality/cambi/jobs/'+a.job.id)).attemptId,null);
 assert.equal((await f.json('/api/quality/cambi/jobs/'+b.job.id+'/cancel',{})).state,'cancelled');
 const runner=(f.service.library.qualityCambi as any).runner,run=runner.runCambi.bind(runner);
 let resume:()=>void=()=>{},seen=false;const gate=new Promise<void>(r=>resume=r);t.after(()=>resume());
 runner.runCambi=(id:any,input:any,signal:any,hooks:any)=>run(id,input,signal,{...hooks,streamFrame:async(...args:any[])=>{await hooks.streamFrame(...args);if(!seen){seen=true;await gate;}}});release();
 await until(()=>seen,Boolean);const page=await f.json(`/api/quality/cambi/jobs/${a.job.id}/frames`);assert.equal(page.state,'provisional-uncommitted-attempt');assert.equal(page.publishable,false);assert.equal(page.entries.length,1);
 const heat=await f.request(`/api/quality/cambi/jobs/${a.job.id}/heatmap?index=0&scale=0`);assert.equal(heat.status,200);assert.equal(heat.headers.get('x-voidplayer-evidence-state'),'provisional-uncommitted-attempt');
 assert.equal((await f.request(`/api/quality/cambi/jobs/${a.job.id}/picture?index=0`)).status,409);
 const task=await f.json(`/api/tasks/cambi/${a.job.id}`);assert.equal(task.task.result.available,false);assert.equal(task.task.progress.scored,1);assert.equal(task.task.progress.prepared,1);
 const summary=await f.json(`/api/quality/cambi/jobs/${a.job.id}/result`);assert.equal(summary.publishable,false);assert.equal(summary.pooled,null);resume();assert.equal((await f.wait(a.job.id)).state,'completed');
});

for(const [codec,depth] of [['h264',8],['hevc',8],['hevc',10]] as const)
test(`CAMBI ${codec}/${depth} stop-and-keep drains a real GOP and reuses validated partial evidence`,{timeout:120000},async t=>{
 const f=await cambiFixture({codec,depth,sequence:true});let restored:Awaited<ReturnType<typeof startService>>|undefined;
 const service=f.service.library.qualityCambi as any,runner=service.runner,run=runner.runCambi.bind(runner);
 let release:()=>void=()=>{},seen=false;const hold=new Promise<void>(r=>release=r);t.after(async()=>{release();await restored?.close();await f.close();});
 runner.runCambi=(id:any,input:any,signal:any,hooks:any)=>run(id,input,signal,{...hooks,streamFrame:async(...args:any[])=>{await hooks.streamFrame(...args);if(!seen){seen=true;await hold;}}});
 const job=(await f.json('/api/quality/cambi/jobs',f.input,'partial')).job,url='/api/quality/cambi/jobs/'+job.id;
 await until(()=>seen,Boolean);const provisional=await f.json(url+'/frames');assert.equal(provisional.publishable,false);assert.equal(provisional.entries[0].index,0);
 const requestPolicy={space:'default',minScore:0,limit:1,scale:0,cellThreshold:1,text:'Inspect this validated partial banding candidate',severity:2};
 assert.equal((await f.request(url+'/candidates',requestPolicy)).status,409);
 assert.equal((await f.json(url+'/stop-and-keep',{})).stopRequested,true);
 assert.equal((await f.json(url+'/stop-and-keep',{})).attemptId,provisional.attemptId);
 assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});release();
 const done=await f.wait(job.id);assert.equal(done.state,'partial',JSON.stringify(done));assert.ok(done.resultDigest);assert.equal(done.attemptId,provisional.attemptId);
 const result=await f.json(url+'/result');assert.equal(result.validation,'committed');assert.equal(result.publishable,true);
 assert.ok(result.coverage.scored>0&&result.coverage.scored<result.coverage.selected);assert.equal(result.coverage.scored+result.coverage.unscored,result.coverage.selected);
 const frames=await f.json(url+'/frames');assert.equal(frames.state,'immutable-partial');assert.equal(frames.entries[0].score,provisional.entries[0].score);
 for(const frame of frames.entries)requirePacketOutputWitness(frame.provenance);
 for(const frame of frames.entries)assert.ok(Math.abs(frame.score-f.sample.cambi.frames[frame.index])<=0.000001,'partial frame retains the independent official sequence oracle');
 assert.equal(service.db.prepare('SELECT count(*) n FROM cambi_frames WHERE job=?').get(job.id).n,0);
 const task=(await f.json('/api/tasks/cambi/'+job.id)).task;assert.equal(task.state,'partial');assert.equal(task.result.available,true);
 const before=f.service.library.qualityAdmission.resources();assert.equal(before.running,0);
 assert.equal((await f.request(url+'/picture?index=0')).status,200);
 const pub=await f.json(url+'/candidates',requestPolicy);assert.ok(pub.createdIds.length<=1);
 if(codec==='hevc'&&depth===8){
  assert.equal(pub.createdIds.length,1);const attachment=await f.json('/api/annotations/spaces/default/'+pub.createdIds[0]);assert.equal(attachment.document.mark.cambiEvidence[0].value.coverage.unscored,result.coverage.unscored);
 }else{assert.equal(pub.createdIds.length,0);assert.equal(result.pooled.max,0,'zero heatmaps must never invent a spatial candidate');}
 assert.deepEqual((await f.json(url+'/candidates',requestPolicy)).createdIds,pub.createdIds);
 assert.equal((await f.json(url+'/stop-and-keep',{})).resultDigest,done.resultDigest);
 assert.equal((await f.json('/api/quality/cambi/jobs',f.input,'partial')).job.id,job.id);
 if(codec==='hevc'&&depth===8){
  const before=JSON.stringify(await f.json('/api/annotations/spaces/default/'+pub.createdIds[0]));
  const plan=await f.json(url+'/reexecution-plan',{reason:'Explicit full rerun after keeping partial evidence'});assert.equal(plan.eligible,true,JSON.stringify(plan));
  const successor=await f.json(url+'/reexecutions',{schema:'voidplayer-quality-reexecution',version:1,reason:plan.reason,planDigest:plan.digest,confirm:plan.cost},'rerun-partial');
  assert.equal((await f.wait(successor.job.id)).state,'completed');assert.equal((await f.json('/api/quality/cambi/jobs/'+successor.job.id+'/result')).coverage.scored,192);
  assert.equal((await f.json(url)).resultDigest,done.resultDigest);assert.equal(JSON.stringify(await f.json('/api/annotations/spaces/default/'+pub.createdIds[0])),before);
  await f.stop();restored=await startService(f.config,false);
  const base=`http://127.0.0.1:${(restored.server.address() as any).port}`,get=async(p:string)=>(await fetch(base+p,{headers:{cookie:f.headers.cookie,'x-voidplayer-actor':f.actor}})).json();
  assert.equal((await get(url)).state,'partial');assert.equal((await get(url)).resultDigest,done.resultDigest);assert.equal((await get(url+'/result')).coverage.unscored,128);
  assert.equal(JSON.stringify(await get('/api/annotations/spaces/default/'+pub.createdIds[0])),before);
 }
});

test('stop-and-keep never preserves provisional scores when the final source identity changes',{timeout:120000},async t=>{
 const f=await cambiFixture({codec:'hevc',depth:8,sequence:true});t.after(()=>f.close());
 const runner=(f.service.library.qualityCambi as any).runner,run=runner.runCambi.bind(runner);let release:()=>void=()=>{},seen=false;
 const hold=new Promise<void>(r=>release=r);t.after(()=>release());runner.runCambi=(id:any,input:any,signal:any,hooks:any)=>run(id,input,signal,{...hooks,streamFrame:async(...args:any[])=>{await hooks.streamFrame(...args);if(!seen){seen=true;await hold;}}});
 const job=(await f.json('/api/quality/cambi/jobs',f.input,'bad-partial')).job,url='/api/quality/cambi/jobs/'+job.id;await until(()=>seen,Boolean);
 await f.json(url+'/stop-and-keep',{});const file=path.join(f.media,f.fileName);await writeFile(file,Buffer.concat([await readFile(file),Buffer.from([0])]));release();
 const done=await f.wait(job.id);assert.equal(done.state,'failed');assert.equal(done.resultDigest,null);
 for(const suffix of ['/result','/frames','/heatmap?index=0&scale=0'])assert.equal((await f.request(url+suffix)).status,409);
 const service=f.service.library.qualityCambi as any;for(const table of ['cambi_heat','cambi_frames','cambi_progress'])assert.equal(service.db.prepare(`SELECT count(*) n FROM ${table} WHERE job=?`).get(job.id).n,0);
});

test('CAMBI final source check rejects changed bytes and cleans provisional maps',{timeout:120000},async t=>{
 const f=await cambiFixture();t.after(()=>f.close());const runner=(f.service.library.qualityCambi as any).runner,run=runner.runCambi.bind(runner);let changed=false;
 runner.runCambi=(id:any,input:any,signal:any,hooks:any)=>run(id,input,signal,{...hooks,streamFrame:async(...args:any[])=>{await hooks.streamFrame(...args);if(!changed){changed=true;const file=path.join(f.media,f.fileName);await writeFile(file,Buffer.concat([await readFile(file),Buffer.from([0])]));}}});
 const done=await f.wait((await f.json('/api/quality/cambi/jobs',f.input,'source-change')).job.id);
 assert.equal(done.state,'failed');assert.equal(done.reason.code,'source-changed');assert.equal(done.resultDigest,null);
});

test('CAMBI SIGKILL owner recovery: interrupted, owned Workers stopped, no retry',{timeout:120000},async t=>{const f=await cambiFixture(),children:any[]=[];t.after(async()=>{for(const c of children){if(c.child.exitCode===null&&c.child.signalCode===null)c.child.kill('SIGKILL');await c.closed;}await f.close();});const settings=path.join(f.directory,'server.json');await writeFile(settings,JSON.stringify({dataDir:f.config.dataDir,mediaRoots:f.config.mediaRoots,nativeVmaf:f.config.nativeVmaf}));await f.stop();
 const launch=(mode:string)=>{const child=spawn(process.execPath,[path.resolve('test/helpers/native-cambi-server.mjs'),settings,mode],{stdio:['ignore','pipe','pipe']}),events:any[]=[];let buffer='',output='';child.stdout.on('data',b=>{buffer+=b;output=(output+b).slice(-65536);let i;while((i=buffer.indexOf('\n'))>=0){try{events.push(JSON.parse(buffer.slice(0,i)));}catch{}buffer=buffer.slice(i+1);}});child.stderr.on('data',b=>output=(output+b).slice(-65536));const closed=new Promise<void>((r,j)=>{child.once('error',j);child.once('close',()=>r());});const c={child,events,closed,output:()=>output};children.push(c);return c;};let c=launch('hold'),port=await until(()=>{if(c.child.exitCode!==null)throw Error(c.output());return c.events.find(e=>e.event==='ready')?.port;},Boolean);
 const call=async(url:string,body?:unknown)=>{const base=`http://127.0.0.1:${port}`,r=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...f.headers,origin:base,'idempotency-key':'restart'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json();};const j=(await call('/api/quality/cambi/jobs',f.input)).job,held:any=await until(()=>c.events.find(e=>e.event==='analysis-held'),Boolean),before=await call('/api/quality/cambi/jobs/'+j.id);c.child.kill('SIGKILL');await c.closed;c=launch('normal');port=await until(()=>{if(c.child.exitCode!==null)throw Error(c.output());return c.events.find(e=>e.event==='ready')?.port;},Boolean);const done=await call('/api/quality/cambi/jobs/'+j.id);assert.equal((await call('/api/tasks/cambi/'+j.id)).task.state,'interrupted');assert.equal(done.state,'interrupted');assert.equal(done.attemptId,before.attemptId);assert.equal(done.resultDigest,null);assert.equal(held.streaming,true);assert.equal((await call('/api/quality/cambi/jobs',f.input)).job.id,j.id);assert.equal((await call('/api/quality/cambi/jobs/'+j.id)).revision,done.revision);assert.deepEqual(done.executionContract,before.executionContract);assert.ok(done.executionContract?.analysis);const prefix='/api/quality/cambi/jobs/'+j.id,plan=await call(prefix+'/reexecution-plan',{reason:'Explicitly recompute recovered CAMBI'});assert.equal(plan.eligible,true,JSON.stringify(plan));const accepted=await call(prefix+'/reexecutions',{schema:'voidplayer-quality-reexecution',version:1,reason:plan.reason,planDigest:plan.digest,confirm:plan.cost});assert.equal((await until(()=>call('/api/quality/cambi/jobs/'+accepted.job.id),v=>!['queued','preparing','running','cancelling'].includes(v.state))).state,'completed');assert.equal((await call(prefix)).state,'interrupted');c.child.kill('SIGTERM');await c.closed;});

test('CAMBI final verification rejects a changed analysis artifact and discards all maps',{timeout:120000},async t=>{
 const f=await cambiFixture();t.after(()=>f.close());const service=f.service.library.qualityCambi as any,runner=service.runner;
 const directory=path.join(f.directory,'analysis');await cp(runner.analysisDir,directory,{recursive:true});await replaceRunnerAnalysisDirectory(runner,directory);
 const worker=runner.worker.bind(runner);runner.worker=async(entry:string,data:any,...args:any[])=>{if(data.mode==='verify'){const file=path.join(directory,'voidplayer-analysis.js');await writeFile(file,Buffer.concat([await readFile(file),Buffer.from('\n// changed')]));}return worker(entry,data,...args);};
 const done=await f.wait((await f.json('/api/quality/cambi/jobs',f.input,'changed-artifact')).job.id);
 assert.equal(done.state,'failed');assert.equal(done.reason.code,'component-unavailable');assert.equal(done.resultDigest,null);
 assert.equal(service.db.prepare('SELECT count(*) AS n FROM cambi_heat WHERE job=?').get(done.id).n,0);
});
