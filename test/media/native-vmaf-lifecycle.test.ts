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
 const input={...f.input,budget:{...f.input.budget,maxElapsedMs:mode==='deadline'?5000:120000}},created=await f.json('/api/quality/vmaf/jobs',input,'stop');await until(()=>pid,Boolean,'Actual native supervisor did not start');if(mode!=='native-crash')assert.notEqual(processStartTicks(pid),null);
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
