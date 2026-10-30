import {replaceRunnerAnalysisDirectory} from '../helpers/analysis-component-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {xpsnrFixture,until} from '../helpers/native-xpsnr.mjs';
// @ts-ignore JavaScript Worker boundary helper
import {holdScoringWorker,controlledExecutionDeadline,holdFinalComponentVerification} from '../helpers/analysis-lifecycle.mjs';
import {analysisComponent} from '../../server/analysis/quality/analysis-component.ts';

test('pinned analysis component rejects tampered glue, WASM, model identity and provenance',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'vp-analysis-tampered-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await cp('public/vendor/voidplayer-analysis',directory,{recursive:true});
 for(const name of ['voidplayer-analysis.js','voidplayer-analysis.wasm','manifest.json','provenance.json']){
  const file=path.join(directory,name),saved=await readFile(file);
  await writeFile(file,Buffer.concat([saved,Buffer.from([0])]));
  assert.throws(()=>analysisComponent(directory,"xpsnr"),{code:'component-unavailable'});
  await writeFile(file,saved);
 }
 const file=path.join(directory,'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
 manifest.quality.xpsnr.filterSha256='0'.repeat(64);await writeFile(file,JSON.stringify(manifest));
 assert.throws(()=>analysisComponent(directory,"xpsnr"),{code:'component-unavailable'});
});

for(const containers of [['flv','flv'],['mp4','flv'],['flv','mp4']] as const)
for(const mode of ['cancel','deadline','crash'] as const)
test(`actual analysis Worker ${mode} ${containers.join('→')}: physical exit before capacity`,{timeout:120000},async t=>{
 const f=await xpsnrFixture({containers});t.after(()=>f.close());
 const service=f.service.library.qualityXpsnr,runner=(service as any).runner;
 const gate=holdScoringWorker(runner,'result');let expire:()=>void=()=>{};
 if(mode==='deadline'){
  const run=runner.run.bind(runner);
  runner.run=(...args:any[])=>{const clock=controlledExecutionDeadline(5000,()=>run(...args));expire=clock.expire;return clock.work;};
 }
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:mode==='deadline'?5000:120000}};
 const created=await f.json('/api/quality/xpsnr/jobs',input,'stop');
 await until(()=>gate.held,Boolean,'Actual scoring result boundary did not arrive');
 assert.ok(gate.workers.some((w:any)=>w.threadId!==-1));
 assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 assert.equal((await f.json('/api/quality/xpsnr/capability')).enabled,true);
 if(mode==='cancel'){
  const cancelling=await f.json('/api/quality/xpsnr/jobs/'+created.job.id+'/cancel',{});
  assert.equal(cancelling.state,'cancelling');assert.equal(cancelling.endedAt,null);
 }else if(mode==='deadline')expire();else await gate.crash();
 const final=await f.wait(created.job.id);
 assert.equal(final.state,mode==='cancel'?'cancelled':'failed',JSON.stringify(final));
 assert.notEqual(final.metrics.xpsnr.state,'completed');assert.equal(final.resultDigest,null);
 assert.ok(gate.workers.every((w:any)=>w.threadId===-1),'every actual Worker has exited');
 const release=f.service.library.qualityAdmission.acquire();release();
 if(mode==='deadline')assert.equal(final.reason.code,'budget-exceeded');
 assert.equal((await f.request('/api/quality/xpsnr/jobs/'+created.job.id+'/result')).status,409);
 assert.equal((await f.json('/api/quality/xpsnr/jobs',input,'stop')).job.attemptId,final.attemptId);
});

for(const containers of [['flv','flv'],['mp4','flv'],['flv','mp4']] as const)
test(`whole-execution deadline includes analysis preparation ${containers.join('→')}`,{timeout:120000},async t=>{
 const f=await xpsnrFixture({containers});t.after(()=>f.close());
 const runner=(f.service.library.qualityXpsnr as any).runner;let entered=false;
 runner.worker=async(_entry:any,_data:any,signal:AbortSignal)=>{entered=true;await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:1000}},created=await f.json('/api/quality/xpsnr/jobs',input,'prepare-deadline');
 await until(()=>entered,Boolean);assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 const final=await f.wait(created.job.id);assert.equal(final.state,'failed');assert.equal(final.reason.code,'budget-exceeded');assert.equal(final.process,null);assert.equal(final.resultDigest,null);
 const release=f.service.library.qualityAdmission.acquire();release();
});

test('shared admission queues without nested locks, bounded actor queue and explicit queued cancellation',{timeout:120000},async t=>{
 const f=await xpsnrFixture();t.after(()=>f.close());const release=f.service.library.qualityAdmission.acquire();try{
  const a=await f.json('/api/quality/xpsnr/jobs',f.input,'queue-a'),b=await f.json('/api/quality/xpsnr/jobs',f.input,'queue-b');assert.equal((await f.request('/api/quality/xpsnr/jobs',f.input,'over-actor')).status,429);await new Promise(r=>setTimeout(r,300));assert.equal((await f.json('/api/quality/xpsnr/jobs/'+a.job.id)).attemptId,null);for(const j of [a,b])assert.equal((await f.json('/api/quality/xpsnr/jobs/'+j.job.id+'/cancel',{})).state,'cancelled');
 }finally{release();}
});

for(const replacement of ['source-size','source-table','cache-table','cache-build','analysis-glue'] as const)
test(`final ${replacement} replacement refuses scoring publication and preserves completed companions`,{timeout:120000},async t=>{
 const f=await xpsnrFixture({containers:['mp4','flv']});t.after(()=>f.close());
 const runner=(f.service.library.qualityXpsnr as any).runner,run=runner.run.bind(runner);
 const analysisDir=path.join(f.directory,'analysis');await cp(runner.analysisDir,analysisDir,{recursive:true});await replaceRunnerAnalysisDirectory(runner,analysisDir);
 let prepared=false;let resume:()=>void=()=>{};const gate=new Promise<void>(r=>resume=r);
 const worker=runner.worker.bind(runner);
 runner.worker=async(entry:string,data:any,...args:any[])=>{if(data.mode==='verify'){await gate;}return worker(entry,data,...args);};
 runner.run=(input:any,snapshot:any,signal:any,hooks:any)=>run(input,snapshot,signal,{...hooks,prepared:(value:any)=>{hooks.prepared(value);prepared=true;}});
 const job=(await f.json('/api/quality/xpsnr/jobs',f.input,'final-source')).job;
 t.after(()=>resume());await until(()=>prepared,Boolean);
 assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 if(replacement==='analysis-glue'){
  const file=path.join(analysisDir,'voidplayer-analysis.js');await writeFile(file,Buffer.concat([await readFile(file),Buffer.from('\n// changed')]));
 }else if(replacement==='source-size'||replacement==='source-table'){
  const file=path.join(f.media,f.entries[0].name),bytes=await readFile(file);
  if(replacement==='source-size')await writeFile(file,Buffer.concat([bytes,Buffer.from([0])]));
  else {const at=bytes.indexOf(Buffer.from('mvhd'));assert.ok(at>0);bytes[at+16]^=1;await writeFile(file,bytes);}
 }else{
  const {openIndexDatabase}=await import('../../server/sqlite.ts');const db=openIndexDatabase(f.service.library.indexDatabase);
  try{db.prepare(replacement==='cache-table'?"UPDATE media_index_manifests SET producer_json=json_set(producer_json,'$.tableSha256',?) WHERE media_id=?":"UPDATE media_index_manifests SET build_id=? WHERE media_id=?").run('f'.repeat(64),f.entries[0].id);}finally{db.close();}
 }
 resume();const done=await f.wait(job.id);assert.equal(done.state,'partial',JSON.stringify(done));
 assert.equal(done.metrics.psnr.state,'completed');assert.equal(done.metrics.ssim.state,'completed');assert.equal(done.metrics.xpsnr.state,'failed');
 assert.ok(['source-changed','identity-mismatch','untrusted-cache','component-unavailable','execution-contract-conflict'].includes(done.reason.code),done.reason.code);
 const result=await f.json('/api/quality/xpsnr/jobs/'+job.id+'/result');assert.equal(result.xpsnr,null);assert.equal(result.companionPairs,8);
 const release=f.service.library.qualityAdmission.acquire();release();
});

test('analysis linear-memory budget fails before claiming a score',{timeout:120000},async t=>{
 const f=await xpsnrFixture();t.after(()=>f.close());const input={...f.input,budget:{...f.input.budget,nativeMemoryBytes:1024*1024}};
 const done=await f.wait((await f.json('/api/quality/xpsnr/jobs',input,'memory-limit')).job.id);
 assert.equal(done.state,'failed');assert.equal(done.reason.code,'budget-exceeded');assert.equal(done.resultDigest,null);assert.equal(done.process,null);
});

for(const containers of [['flv','flv'],['mp4','mp4']] as const)test(`SIGKILL owner restart ${containers.join('→')} stops owned analysis Workers, preserves companions, never retries`,{timeout:120000},async t=>{
 const {spawn}=await import('node:child_process');const f=await xpsnrFixture({containers});const children:any[]=[];t.after(async()=>{for(const c of children){if(c.child.exitCode===null&&c.child.signalCode===null){c.child.kill('SIGKILL');await c.closed;}}await f.close();});
 const settings=path.join(f.directory,'server-input.json');await writeFile(settings,JSON.stringify({dataDir:f.config.dataDir,mediaRoots:f.config.mediaRoots,nativeXpsnr:f.config.nativeXpsnr}));await f.stop();
 const launch=(mode:string)=>{const child=spawn(process.execPath,[path.resolve('test/helpers/native-xpsnr-server.mjs'),settings,mode],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']}),events:any[]=[];let buffer='',output='';child.stdout.on('data',b=>{buffer+=b;output=(output+b).slice(-65536);let i;while((i=buffer.indexOf('\n'))>=0){try{events.push(JSON.parse(buffer.slice(0,i)));}catch{}buffer=buffer.slice(i+1);}});child.stderr.on('data',b=>output=(output+b).slice(-65536));const closed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});const c={child,closed,events,output:()=>output};children.push(c);return c;};
 let c=launch('hold'),port=await until(()=>{if(c.child.exitCode!==null)throw Error(c.output());return c.events.find((e:any)=>e.event==='ready')?.port;},Boolean,'Child service not ready');
 const call=async(url:string,body?:unknown,key='restart')=>{const base=`http://127.0.0.1:${port}`,r=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...f.headers,origin:base,'idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json();};
 const created=await call('/api/quality/xpsnr/jobs',f.input),held:any=await until(()=>c.events.find((e:any)=>e.event==='analysis-held'),Boolean,'Analysis result not held'),before=await call('/api/quality/xpsnr/jobs/'+created.job.id);assert.equal(before.metrics.psnr.state,'completed');assert.equal(held.prepared,true);c.child.kill('SIGKILL');await c.closed;
 c=launch('normal');port=await until(()=>{if(c.child.exitCode!==null)throw Error(c.output());return c.events.find((e:any)=>e.event==='ready')?.port;},Boolean,'Restart did not recover analysis owner');
 const restored=await call('/api/quality/xpsnr/jobs/'+created.job.id);assert.equal(restored.state,'interrupted');assert.equal(restored.attemptId,before.attemptId);assert.equal(restored.metrics.psnr.state,'completed');assert.equal(restored.metrics.ssim.state,'completed');assert.equal(restored.metrics.xpsnr.state,'interrupted');assert.equal(restored.process,null);assert.equal((await call('/api/quality/xpsnr/jobs',f.input)).job.id,before.id);assert.equal(c.events.filter((e:any)=>e.event==='analysis-held').length,0);
 const result=await call('/api/quality/xpsnr/jobs/'+created.job.id+'/result');assert.equal(result.xpsnr,null);assert.equal(result.companionPairs,8);
 c.child.kill('SIGTERM');await c.closed;assert.equal(c.events.filter((e:any)=>e.event==='analysis-execution-start').length,0,'the entire restarted process lifetime performed no new execution');
});

test('XPSNR: deadline during final artifact verification cannot commit success',{timeout:120000},async t=>{
 const f=await xpsnrFixture();t.after(()=>f.close());const runner=(f.service.library.qualityXpsnr as any).runner;
 const verification=holdFinalComponentVerification(runner),workers=holdScoringWorker(runner,'never-hold');t.after(()=>verification.release());
 const run=runner.run.bind(runner);let expire:()=>void=()=>{};
 runner.run=(...args:any[])=>{const clock=controlledExecutionDeadline(5000,()=>run(...args));expire=clock.expire;return clock.work;};
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:5000}},created=await f.json('/api/quality/xpsnr/jobs',input,'final-deadline');
 await until(()=>verification.held,Boolean);
 assert.ok(workers.workers.length>=2);assert.ok(workers.workers.every((w:any)=>w.threadId===-1));
 assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 expire();verification.release();const final=await f.wait(created.job.id);
 assert.equal(final.state,'partial');assert.equal(final.reason.code,'budget-exceeded');assert.equal(final.metrics.xpsnr.state,'failed');assert.equal(final.metrics.psnr.state,'completed');
 assert.equal((await f.json('/api/quality/xpsnr/jobs/'+created.job.id+'/result')).xpsnr,null);
 const release=f.service.library.qualityAdmission.acquire();release();
});
