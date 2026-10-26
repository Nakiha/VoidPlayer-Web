import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';
import {nativeFixture,nativeComponent,until} from '../helpers/native-vmaf.mjs';
import {verifyVmafComponent} from '../../server/analysis/vmaf/component.ts';import {processStartTicks} from '../../server/analysis/vmaf/runner.ts';
test('pinned component rejects tampered model, binary, supervisor and manifest',{timeout:30000},async t=>{
 const c=await nativeComponent(),directory=await mkdtemp(path.join(tmpdir(),'vp-vmaf-tampered-'));t.after(()=>rm(directory,{recursive:true,force:true}));await cp(c.directory,directory,{recursive:true,filter:p=>!p.includes('/build')});
 for(const name of ['vmaf_v0.6.1.json','vmaf','vmaf-limit','manifest.json']){const file=path.join(directory,name),saved=await readFile(file);await writeFile(file,Buffer.concat([saved,Buffer.from([0])]));await assert.rejects(verifyVmafComponent({...c,directory},'vmaf_v0_6_1'),{code:'component-unavailable'});await writeFile(file,saved);}
 assert.equal((await verifyVmafComponent({...c,directory},'vmaf_v0_6_1neg')).sourceRevision,'17a67b238ce0539bdeafdc95961abac64fa16ea8');
});
for(const mode of ['cancel','deadline','native-crash'] as const)test(`actual native supervisor ${mode}: physical stop before capacity, preserve completed companions`,{timeout:120000},async t=>{
 const f=await nativeFixture();t.after(()=>f.close());const service=f.service.library.qualityVmaf,runner=(service as any).runner,original=runner.run.bind(runner);let pid=0;
 runner.run=(input:any,snapshot:any,signal:any,hooks:any)=>original(input,snapshot,signal,{...hooks,process:(p:any)=>{hooks.process(p);if(p){pid=p.pid;process.kill(pid,mode==='native-crash'?'SIGKILL':'SIGSTOP');}}});
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:mode==='deadline'?5000:120000}},created=await f.json('/api/quality/vmaf/jobs',input,'stop');await until(()=>pid,Boolean,'Actual native supervisor did not start');if(mode!=='native-crash'){assert.notEqual(processStartTicks(pid),null);const capability=await f.json('/api/quality/vmaf/capability');assert.equal(capability.enabled,true);assert.equal(capability.verification,'deferred-admission-busy');assert.equal((await f.json('/api/agent')).capabilities.find((c:any)=>c.id==='quality.vmaf').enabled,true);}
 if(mode!=='native-crash')assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});
 if(mode==='cancel'){const cancelling=await f.json('/api/quality/vmaf/jobs/'+created.job.id+'/cancel',{});assert.equal(cancelling.state,'cancelling');assert.throws(()=>f.service.library.qualityAdmission.acquire(),{code:'quality-busy'});}
 const final=await f.wait(created.job.id);assert.equal(final.state,mode==='cancel'?'cancelled':'partial',JSON.stringify(final));assert.equal(final.metrics.psnr.state,'completed');assert.equal(final.metrics.ssim.state,'completed');assert.notEqual(final.metrics.vmaf.state,'completed');assert.equal(processStartTicks(pid),null);const release=f.service.library.qualityAdmission.acquire();release();
 const result=await f.json('/api/quality/vmaf/jobs/'+created.job.id+'/result');assert.equal(result.vmaf,null);assert.equal(result.companionPairs,8);assert.equal((await f.json('/api/quality/vmaf/jobs',input,'stop')).job.attemptId,final.attemptId);
});
test('shared admission queues without nested locks, bounded actor queue and explicit queued cancellation',{timeout:120000},async t=>{
 const f=await nativeFixture();t.after(()=>f.close());const release=f.service.library.qualityAdmission.acquire();try{
  const a=await f.json('/api/quality/vmaf/jobs',f.input,'queue-a'),b=await f.json('/api/quality/vmaf/jobs',f.input,'queue-b');assert.equal((await f.request('/api/quality/vmaf/jobs',f.input,'over-actor')).status,429);await new Promise(r=>setTimeout(r,300));assert.equal((await f.json('/api/quality/vmaf/jobs/'+a.job.id)).attemptId,null);for(const j of [a,b])assert.equal((await f.json('/api/quality/vmaf/jobs/'+j.job.id+'/cancel',{})).state,'cancelled');
 }finally{release();}
});

test('SIGKILL owner restart stops durably recorded native supervisor, preserves companions, never retries',{timeout:120000},async t=>{
 const {spawn}=await import('node:child_process');const f=await nativeFixture();const children:any[]=[];t.after(async()=>{for(const c of children){if(c.child.exitCode===null&&c.child.signalCode===null){c.child.kill('SIGKILL');await c.closed;}}await f.close();});
 const settings=path.join(f.directory,'server-input.json');await writeFile(settings,JSON.stringify({dataDir:f.config.dataDir,mediaRoots:f.config.mediaRoots,nativeVmaf:f.config.nativeVmaf}));await f.stop();
 const launch=(mode:string)=>{const child=spawn(process.execPath,[path.resolve('test/helpers/native-vmaf-server.mjs'),settings,mode],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']}),events:any[]=[];let buffer='',output='';child.stdout.on('data',b=>{buffer+=b;output=(output+b).slice(-65536);let i;while((i=buffer.indexOf('\n'))>=0){try{events.push(JSON.parse(buffer.slice(0,i)));}catch{}buffer=buffer.slice(i+1);}});child.stderr.on('data',b=>output=(output+b).slice(-65536));const closed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});const c={child,closed,events,output:()=>output};children.push(c);return c;};
 let c=launch('hold'),port=await until(()=>{if(c.child.exitCode!==null)throw Error(c.output());return c.events.find((e:any)=>e.event==='ready')?.port;},Boolean,'Child service not ready');
 const call=async(url:string,body?:unknown,key='restart')=>{const base=`http://127.0.0.1:${port}`,r=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...f.headers,origin:base,'idempotency-key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(r.ok,await r.clone().text());return r.json();};
 const created=await call('/api/quality/vmaf/jobs',f.input),held:any=await until(()=>c.events.find((e:any)=>e.event==='native-held'),Boolean,'Native supervisor not held'),before=await call('/api/quality/vmaf/jobs/'+created.job.id);assert.equal(before.metrics.psnr.state,'completed');assert.notEqual(processStartTicks(held.process.pid),null);c.child.kill('SIGKILL');await c.closed;
 c=launch('normal');port=await until(()=>{if(c.child.exitCode!==null)throw Error(c.output());return c.events.find((e:any)=>e.event==='ready')?.port;},Boolean,'Restart did not recover native owner');
 const restored=await call('/api/quality/vmaf/jobs/'+created.job.id);assert.equal(restored.state,'interrupted');assert.equal(restored.attemptId,before.attemptId);assert.equal(restored.metrics.psnr.state,'completed');assert.equal(restored.metrics.ssim.state,'completed');assert.equal(restored.metrics.vmaf.state,'interrupted');assert.equal(restored.process,null);assert.equal(processStartTicks(held.process.pid),null);assert.equal((await call('/api/quality/vmaf/jobs',f.input)).job.id,before.id);assert.equal(c.events.filter((e:any)=>e.event==='native-held').length,0);
 const result=await call('/api/quality/vmaf/jobs/'+created.job.id+'/result');assert.equal(result.vmaf,null);assert.equal(result.companionPairs,8);
 c.child.kill('SIGTERM');await c.closed;
});

test('final source verification rejects changes after successful raw preparation',{timeout:120000},async t=>{
 const f=await nativeFixture();t.after(()=>f.close());const runner=(f.service.library.qualityVmaf as any).runner,run=runner.run.bind(runner);let pid=0;
 runner.run=(input:any,snapshot:any,signal:any,hooks:any)=>run(input,snapshot,signal,{...hooks,process:(p:any)=>{hooks.process(p);if(p){pid=p.pid;process.kill(pid,'SIGSTOP');}}});
 const j=(await f.json('/api/quality/vmaf/jobs',f.input,'final-source')).job;await until(()=>pid,Boolean);const file=path.join(f.media,'reference.flv');await writeFile(file,Buffer.concat([await readFile(file),Buffer.from([0])]));process.kill(pid,'SIGCONT');const done=await f.wait(j.id);assert.equal(done.state,'partial');assert.equal(done.metrics.psnr.state,'completed');assert.equal(done.metrics.vmaf.state,'failed');assert.equal(done.reason.code,'source-changed');assert.equal((await f.json('/api/quality/vmaf/jobs/'+j.id+'/result')).vmaf,null);
});
test('native OS memory budget is enforced without erasing completed PSNR',{timeout:120000},async t=>{
 const f=await nativeFixture();t.after(()=>f.close());const input={...f.input,budget:{...f.input.budget,nativeMemoryBytes:1024*1024}},j=(await f.json('/api/quality/vmaf/jobs',input,'memory-limit')).job,done=await f.wait(j.id);assert.equal(done.state,'partial');assert.equal(done.metrics.psnr.state,'completed');assert.equal(done.metrics.vmaf.state,'failed');assert.equal(done.reason.code,'native-execution-failed');assert.equal(done.process,null);
});

test('official native child has kernel CPU/address-space/file limits and exits when supervisor is killed',{timeout:30000},async t=>{
 const {spawn}=await import('node:child_process'),{readlinkSync,readFileSync,writeFileSync}=await import('node:fs');const config=await nativeComponent(),c=await verifyVmafComponent(config,'vmaf_v0_6_1'),directory=await mkdtemp(path.join(tmpdir(),'vp-vmaf-kernel-'));let child:any,pid=0,closed:Promise<void>|undefined;
 t.after(async()=>{if(child?.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;if(pid&&processStartTicks(pid)!==null)try{process.kill(pid,'SIGKILL');}catch{}await rm(directory,{recursive:true,force:true});});
 const raw=Buffer.alloc(640*360*3/2*32);for(const name of ['reference.yuv','distorted.yuv'])writeFileSync(path.join(directory,name),raw);
 child=spawn(c.supervisor,['1',String(64*1024*1024),String(4*1024*1024),c.binary,'--reference','reference.yuv','--distorted','distorted.yuv','--width','640','--height','360','--pixel_format','420','--bitdepth','8','--model',`path=${c.model}:name=vmaf`,'--threads','1','--cpumask','0','--json','--output','result.json','--quiet'],{cwd:directory,stdio:['pipe','pipe','pipe'],env:{LANG:'C',LC_ALL:'C'}});
 closed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});let stdout='';child.stdout.on('data',(b:Buffer)=>stdout+=b);child.stderr.resume();child.stdin.end('G');
 await until(()=>{const n=Number(/VOIDPLAYER_VMAF_PID (\d+)/.exec(stdout)?.[1]);if(!n)return false;try{if(readlinkSync(`/proc/${n}/exe`)!==c.binary)return false;process.kill(n,'SIGSTOP');pid=n;return true;}catch{return false;}},Boolean,'Official native executable not witnessed');
 const limits=readFileSync(`/proc/${pid}/limits`,'utf8');assert.match(limits,/Max cpu time\s+1\s+1\s+seconds/);assert.match(limits,/Max address space\s+67108864\s+67108864\s+bytes/);assert.match(limits,/Max file size\s+4194304\s+4194304\s+bytes/);assert.match(limits,/Max core file size\s+0\s+0\s+bytes/);
 child.kill('SIGKILL');await closed;await until(()=>processStartTicks(pid)===null,Boolean,'Native child survived supervisor death');
});
