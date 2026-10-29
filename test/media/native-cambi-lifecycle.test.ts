import test from 'node:test';import assert from 'node:assert/strict';
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

test('CAMBI shared queue hides provisional frames and supports explicit queued cancellation',{timeout:120000},async t=>{
 const f=await cambiFixture();t.after(()=>f.close());const release=f.service.library.qualityAdmission.acquire();
 const a=await f.json('/api/quality/cambi/jobs',f.input,'queue1'),b=await f.json('/api/quality/cambi/jobs',f.input,'queue2');
 assert.equal((await f.request('/api/quality/cambi/jobs',f.input,'queue3')).status,429);
 assert.equal((await f.json('/api/quality/cambi/jobs/'+a.job.id)).attemptId,null);
 assert.equal((await f.json('/api/quality/cambi/jobs/'+b.job.id+'/cancel',{})).state,'cancelled');
 const runner=(f.service.library.qualityCambi as any).runner,run=runner.runCambi.bind(runner);
 let resume:()=>void=()=>{},seen=false;const gate=new Promise<void>(r=>resume=r);t.after(()=>resume());
 runner.runCambi=(id:any,input:any,signal:any,hooks:any)=>run(id,input,signal,{...hooks,streamFrame:async(...args:any[])=>{await hooks.streamFrame(...args);if(!seen){seen=true;await gate;}}});release();
 await until(()=>seen,Boolean);assert.equal((await f.request(`/api/quality/cambi/jobs/${a.job.id}/frames`)).status,409);
 const task=await f.json(`/api/tasks/cambi/${a.job.id}`);assert.equal(task.task.result.available,false);assert.equal(task.task.progress.scored,1);assert.equal(task.task.progress.prepared,1);
 assert.equal((await f.request(`/api/quality/cambi/jobs/${a.job.id}/result`)).status,409);resume();assert.equal((await f.wait(a.job.id)).state,'completed');
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
 const directory=path.join(f.directory,'analysis');await cp(runner.analysisDir,directory,{recursive:true});runner.analysisDir=directory;
 const worker=runner.worker.bind(runner);runner.worker=async(entry:string,data:any,...args:any[])=>{if(data.mode==='verify'){const file=path.join(directory,'voidplayer-analysis.js');await writeFile(file,Buffer.concat([await readFile(file),Buffer.from('\n// changed')]));}return worker(entry,data,...args);};
 const done=await f.wait((await f.json('/api/quality/cambi/jobs',f.input,'changed-artifact')).job.id);
 assert.equal(done.state,'failed');assert.equal(done.reason.code,'component-unavailable');assert.equal(done.resultDigest,null);
 assert.equal(service.db.prepare('SELECT count(*) AS n FROM cambi_heat WHERE job=?').get(done.id).n,0);
});
