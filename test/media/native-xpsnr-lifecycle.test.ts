import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,copyFile,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {xpsnrFixture,xpsnrComponent,until} from '../helpers/native-xpsnr.mjs';
import {verifyXpsnrComponent} from '../../server/analysis/xpsnr/component.ts';import {processStartTicks} from '../../server/analysis/vmaf/runner.ts';
/** Capture only the real whole-execution timer armed synchronously by run().
 * Its original callback/budget remain intact; this test advances that clock at
 * a witnessed native boundary, independently of host decode throughput. Other
 * timers (including the real physical-stop escalation) keep their real clock. */
function controlledExecutionDeadline<T>(milliseconds:number,run:()=>Promise<T>){
 const schedule=globalThis.setTimeout;let expire:(()=>void)|undefined,armed=0,fired=false;
 try{
  globalThis.setTimeout=((...args:Parameters<typeof setTimeout>)=>{const timer=Reflect.apply(schedule,globalThis,args);if(args[1]===milliseconds){armed++;clearTimeout(timer);expire=()=>{assert.equal(fired,false);fired=true;args[0](...args.slice(2));};}return timer;})as typeof setTimeout;
  const work=run();assert.equal(armed,1,'the unchanged whole-execution deadline must be armed before preparation');return {work,expire(){assert.ok(expire);expire();}};
 }finally{globalThis.setTimeout=schedule;}
}
test('pinned component rejects tampered model, binary, supervisor and manifest',{timeout:30000},async t=>{
 const c=await xpsnrComponent(),directory=await mkdtemp(path.join(tmpdir(),'vp-xpsnr-tampered-'));t.after(()=>rm(directory,{recursive:true,force:true}));await cp(c.directory,directory,{recursive:true,filter:p=>!p.includes('/build')});
 for(const name of ['ffmpeg-source.tar.gz','ffmpeg-xpsnr','native-limit','manifest.json']){const file=path.join(directory,name),saved=await readFile(file);await writeFile(file,Buffer.concat([saved,Buffer.from([0])]));await assert.rejects(verifyXpsnrComponent({...c,directory}),{code:'component-unavailable'});await writeFile(file,saved);}
 assert.equal((await verifyXpsnrComponent({...c,directory})).sourceRevision,'8998a1a670c81a04d144c36f9e2d3aa680c10720');
});
for(const containers of [['flv','flv'],['mp4','flv'],['flv','mp4']] as const)for(const mode of ['cancel','deadline','native-crash'] as const)test(`actual native supervisor ${mode} ${containers.join('→')}: physical stop before capacity, preserve completed companions`,{timeout:120000},async t=>{
 const f=await xpsnrFixture({containers});t.after(()=>f.close());const service=f.service.library.qualityXpsnr,runner=(service as any).runner,original=runner.run.bind(runner);let pid=0,expire:(()=>void)|undefined;
 if(mode==='deadline'){
  // Prepare real trusted bytes/companions outside the phase-specific test clock.
  // Reuse that fixed result at the decode boundary so neither Worker startup
  // nor its own real decode deadline can consume this native-phase precondition.
  const directory=path.join(f.directory,'deadline-prepared');await mkdir(directory);const worker=runner.worker.bind(runner),release=f.service.library.qualityAdmission.acquire();let prepared;
  try{prepared=await worker('decode-worker.ts',{mode:'decode',database:f.service.library.indexDatabase,coreDir:runner.coreDir,directory,input:f.input,snapshot:{...f.input.plan,value:f.service.library.qualityCorrespondence.result(f.input.plan.id,f.actor)}},new AbortController().signal);}finally{release();}
  runner.worker=async(entry:string,data:any,signal:AbortSignal,progress:any)=>{if(entry!=='decode-worker.ts'||data.mode!=='decode')return worker(entry,data,signal,progress);signal.throwIfAborted();for(const name of ['reference.yuv','distorted.yuv'])await copyFile(path.join(directory,name),path.join(data.directory,name));signal.throwIfAborted();progress?.(prepared.pairs.length,prepared.pairs.length);return structuredClone(prepared);};
 }
 runner.run=(input:any,snapshot:any,signal:any,hooks:any)=>{const run=()=>original(input,snapshot,signal,{...hooks,process:(p:any)=>{hooks.process(p);if(p){pid=p.pid;process.kill(pid,mode==='native-crash'?'SIGKILL':'SIGSTOP');}}});if(mode!=='deadline')return run();const clock=controlledExecutionDeadline(5000,run);expire=clock.expire;return clock.work;};
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:mode==='deadline'?5000:120000}},created=await f.json('/api/quality/xpsnr/jobs',input,'stop');await until(()=>pid,Boolean,'Actual native supervisor did not start');if(mode!=='native-crash'){assert.notEqual(processStartTicks(pid),null);const capability=await f.json('/api/quality/xpsnr/capability');assert.equal(capability.enabled,true);assert.equal(capability.verification,'deferred-admission-busy');assert.equal((await f.json('/api/agent')).capabilities.find((c:any)=>c.id==='quality.xpsnr').enabled,true);}
 if(mode!=='native-crash')assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 if(mode==='cancel'){const cancelling=await f.json('/api/quality/xpsnr/jobs/'+created.job.id+'/cancel',{});assert.equal(cancelling.state,'cancelling');assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});}
 if(mode==='deadline'){assert.equal(service.get(created.job.id,f.actor).metrics.psnr.state,'completed');assert.ok(expire);expire();assert.notEqual(processStartTicks(pid),null);assert.equal(service.get(created.job.id,f.actor).endedAt,null);assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});}
 const final=await f.wait(created.job.id);assert.equal(final.state,mode==='cancel'?'cancelled':'partial',JSON.stringify(final));assert.equal(final.metrics.psnr.state,'completed');assert.equal(final.metrics.ssim.state,'completed');assert.notEqual(final.metrics.xpsnr.state,'completed');assert.equal(processStartTicks(pid),null);const release=f.service.library.qualityAdmission.acquire();release();
 if(mode==='deadline')assert.equal(final.reason.code,'budget-exceeded');
 const result=await f.json('/api/quality/xpsnr/jobs/'+created.job.id+'/result');assert.equal(result.xpsnr,null);assert.equal(result.companionPairs,8);assert.equal((await f.json('/api/quality/xpsnr/jobs',input,'stop')).job.attemptId,final.attemptId);
});
for(const containers of [['flv','flv'],['mp4','flv'],['flv','mp4']]as const)test(`real whole-execution deadline during preparation ${containers.join('→')} never requires a native process`,{timeout:120000},async t=>{
 const f=await xpsnrFixture({containers});t.after(()=>f.close());const service=f.service.library.qualityXpsnr,runner=(service as any).runner;let entered=false,nativeStarted=false;
 // A controlled pending component check is preparation, not a sleeping native
 // process. Leave the production 5000ms timer real and wait for its own abort.
 runner.component=async(signal:AbortSignal)=>{entered=true;assert.equal(signal.aborted,false);await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const native=runner.native.bind(runner);runner.native=(...args:any[])=>{nativeStarted=true;return native(...args);};
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:5000}},created=await f.json('/api/quality/xpsnr/jobs',input,'prepare-deadline');await until(()=>entered,Boolean,'Preparation boundary did not start');assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 const final=await f.wait(created.job.id);assert.equal(final.state,'failed',JSON.stringify(final));assert.equal(final.reason.code,'budget-exceeded');assert.equal(final.metrics.psnr.state,'failed');assert.equal(final.metrics.xpsnr.state,'failed');assert.equal(final.process,null);assert.equal(final.resultDigest,null);assert.equal(nativeStarted,false);assert.equal((await f.request(`/api/quality/xpsnr/jobs/${created.job.id}/result`)).status,409);const release=f.service.library.qualityAdmission.acquire();release();
});
test('shared admission queues without nested locks, bounded actor queue and explicit queued cancellation',{timeout:120000},async t=>{
 const f=await xpsnrFixture();t.after(()=>f.close());const release=f.service.library.qualityAdmission.acquire();try{
  const a=await f.json('/api/quality/xpsnr/jobs',f.input,'queue-a'),b=await f.json('/api/quality/xpsnr/jobs',f.input,'queue-b');assert.equal((await f.request('/api/quality/xpsnr/jobs',f.input,'over-actor')).status,429);await new Promise(r=>setTimeout(r,300));assert.equal((await f.json('/api/quality/xpsnr/jobs/'+a.job.id)).attemptId,null);for(const j of [a,b])assert.equal((await f.json('/api/quality/xpsnr/jobs/'+j.job.id+'/cancel',{})).state,'cancelled');
 }finally{release();}
});

for(const containers of [['flv','flv'],['mp4','mp4']] as const)test(`SIGKILL owner restart ${containers.join('→')} stops durably recorded native supervisor, preserves companions, never retries`,{timeout:120000},async t=>{
 const {spawn}=await import('node:child_process');const f=await xpsnrFixture({containers});const children:any[]=[];t.after(async()=>{for(const c of children){if(c.child.exitCode===null&&c.child.signalCode===null){c.child.kill('SIGKILL');await c.closed;}}await f.close();});
 const settings=path.join(f.directory,'server-input.json');await writeFile(settings,JSON.stringify({dataDir:f.config.dataDir,mediaRoots:f.config.mediaRoots,nativeXpsnr:f.config.nativeXpsnr}));await f.stop();
 const launch=(mode:string)=>{const child=spawn(process.execPath,[path.resolve('test/helpers/native-xpsnr-server.mjs'),settings,mode],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']}),events:any[]=[];let buffer='',output='';child.stdout.on('data',b=>{buffer+=b;output=(output+b).slice(-65536);let i;while((i=buffer.indexOf('\n'))>=0){try{events.push(JSON.parse(buffer.slice(0,i)));}catch{}buffer=buffer.slice(i+1);}});child.stderr.on('data',b=>output=(output+b).slice(-65536));const closed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});const c={child,closed,events,output:()=>output};children.push(c);return c;};
 let c=launch('hold'),port=await until(()=>{if(c.child.exitCode!==null)throw Error(c.output());return c.events.find((e:any)=>e.event==='ready')?.port;},Boolean,'Child service not ready');
 const call=async(url:string,body?:unknown,key='restart')=>{const base=`http://127.0.0.1:${port}`,r=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...f.headers,origin:base,'idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json();};
 const created=await call('/api/quality/xpsnr/jobs',f.input),held:any=await until(()=>c.events.find((e:any)=>e.event==='native-held'),Boolean,'Native supervisor not held'),before=await call('/api/quality/xpsnr/jobs/'+created.job.id);assert.equal(before.metrics.psnr.state,'completed');assert.notEqual(processStartTicks(held.process.pid),null);c.child.kill('SIGKILL');await c.closed;
 c=launch('normal');port=await until(()=>{if(c.child.exitCode!==null)throw Error(c.output());return c.events.find((e:any)=>e.event==='ready')?.port;},Boolean,'Restart did not recover native owner');
 const restored=await call('/api/quality/xpsnr/jobs/'+created.job.id);assert.equal(restored.state,'interrupted');assert.equal(restored.attemptId,before.attemptId);assert.equal(restored.metrics.psnr.state,'completed');assert.equal(restored.metrics.ssim.state,'completed');assert.equal(restored.metrics.xpsnr.state,'interrupted');assert.equal(restored.process,null);assert.equal(processStartTicks(held.process.pid),null);assert.equal((await call('/api/quality/xpsnr/jobs',f.input)).job.id,before.id);assert.equal(c.events.filter((e:any)=>e.event==='native-held').length,0);
 const result=await call('/api/quality/xpsnr/jobs/'+created.job.id+'/result');assert.equal(result.xpsnr,null);assert.equal(result.companionPairs,8);
 c.child.kill('SIGTERM');await c.closed;assert.equal(c.events.filter((e:any)=>e.event==='native-execution-start').length,0,'the entire restarted process lifetime performed no new execution');
});

test('final source verification rejects changes after successful raw preparation',{timeout:120000},async t=>{
 const f=await xpsnrFixture();t.after(()=>f.close());const runner=(f.service.library.qualityXpsnr as any).runner,run=runner.run.bind(runner);let pid=0;
 runner.run=(input:any,snapshot:any,signal:any,hooks:any)=>run(input,snapshot,signal,{...hooks,process:(p:any)=>{hooks.process(p);if(p){pid=p.pid;process.kill(pid,'SIGSTOP');}}});
 const j=(await f.json('/api/quality/xpsnr/jobs',f.input,'final-source')).job;await until(()=>pid,Boolean);const file=path.join(f.media,'reference.flv');await writeFile(file,Buffer.concat([await readFile(file),Buffer.from([0])]));process.kill(pid,'SIGCONT');const done=await f.wait(j.id);assert.equal(done.state,'partial');assert.equal(done.metrics.psnr.state,'completed');assert.equal(done.metrics.xpsnr.state,'failed');assert.equal(done.reason.code,'source-changed');assert.equal((await f.json('/api/quality/xpsnr/jobs/'+j.id+'/result')).xpsnr,null);
});
for(const replacement of ['source-table','cache-table','cache-build']as const)test(`MP4 final ${replacement} replacement refuses native publication and preserves companions`,{timeout:120000},async t=>{
 const f=await xpsnrFixture({containers:['mp4','flv']});t.after(()=>f.close());const runner=(f.service.library.qualityXpsnr as any).runner,run=runner.run.bind(runner);let pid=0;
 runner.run=(input:any,snapshot:any,signal:any,hooks:any)=>run(input,snapshot,signal,{...hooks,process:(p:any)=>{hooks.process(p);if(p){pid=p.pid;process.kill(pid,'SIGSTOP');}}});
 const job=(await f.json('/api/quality/xpsnr/jobs',f.input,'mp4-final')).job;await until(()=>pid,Boolean,'Native supervisor did not reach final-source barrier');
 assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 if(replacement==='source-table'){
  const file=path.join(f.media,f.entries[0].name),bytes=await readFile(file),at=bytes.indexOf(Buffer.from('mvhd'));assert.ok(at>0);const size=bytes.length;bytes[at+16]^=1;await writeFile(file,bytes);assert.equal((await readFile(file)).length,size,'real table change retains the same byte length; source version may change');
 }else{
  const {openIndexDatabase}=await import('../../server/sqlite.ts');const db=openIndexDatabase(f.service.library.indexDatabase);
  try{db.prepare(replacement==='cache-table'?"UPDATE media_index_manifests SET producer_json=json_set(producer_json,'$.tableSha256',?) WHERE media_id=?":"UPDATE media_index_manifests SET build_id=? WHERE media_id=?").run('f'.repeat(64),f.entries[0].id);}finally{db.close();}
 }
 process.kill(pid,'SIGCONT');const done=await f.wait(job.id);assert.equal(done.state,'partial',JSON.stringify(done));assert.equal(done.metrics.psnr.state,'completed');assert.equal(done.metrics.ssim.state,'completed');assert.equal(done.metrics.xpsnr.state,'failed');assert.ok(['source-changed','identity-mismatch','untrusted-cache'].includes(done.reason.code));assert.equal(done.process,null);assert.equal(processStartTicks(pid),null);
 const result=await f.json('/api/quality/xpsnr/jobs/'+job.id+'/result');assert.equal(result.xpsnr,null);assert.equal(result.companionPairs,8);const release=f.service.library.qualityAdmission.acquire();release();
});
test('native OS memory budget is enforced without erasing completed PSNR',{timeout:120000},async t=>{
 const f=await xpsnrFixture();t.after(()=>f.close());const input={...f.input,budget:{...f.input.budget,nativeMemoryBytes:1024*1024}},j=(await f.json('/api/quality/xpsnr/jobs',input,'memory-limit')).job,done=await f.wait(j.id);assert.equal(done.state,'partial');assert.equal(done.metrics.psnr.state,'completed');assert.equal(done.metrics.xpsnr.state,'failed');assert.equal(done.reason.code,'native-execution-failed');assert.equal(done.process,null);
});

