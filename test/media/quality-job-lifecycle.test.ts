import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { connect } from 'node:net';
import { randomUUID,createHash } from 'node:crypto';
import {openIndexDatabase} from '../../server/sqlite.ts';
import { encodedPair } from '../helpers/library-pair-fixture.ts';
import type { QualityJobInput,QualityJob } from '../../shared/analysis/quality/jobs.ts';
import type {QualityRangeInput} from '../../shared/analysis/quality/ranges.ts';
type FixtureChild={child:ChildProcessWithoutNullStreams;events:any[];closed:Promise<{code:number|null;signal:NodeJS.Signals|null}>;output:()=>string};
async function until<T>(check:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{
 for(let i=0;i<500;i++){const value=await check();if(value)return value as NonNullable<T>;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail(label);
}
function launch(dir:string,mode:string,marker?:string):FixtureChild{
 const child=spawn(process.execPath,[...(marker?[process.versions.bun?'--preload':'--import',resolve('test/helpers/crash-after-range-child-commit.mjs')]:[]),resolve('test/helpers/quality-job-server.ts'),dir,mode],{cwd:process.cwd(),env:{...process.env,...(marker?{RANGE_COMMIT_MARKER:marker}:{})},stdio:['pipe','pipe','pipe']}),events:any[]=[];let buffer='',output='';
 child.stdout.on('data',bytes=>{buffer+=bytes;output=(output+bytes).slice(-65536);let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{events.push(JSON.parse(line));}catch{}}});
 child.stderr.on('data',bytes=>{output=(output+bytes).slice(-65536);});
 const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 return {child,events,closed,output:()=>output};
}
async function ready(child:FixtureChild){return until(()=>child.events.find(event=>event.event==='ready')?.port,`Child did not become ready: ${child.output()}`);}
async function stop(child:FixtureChild,crash=false){
 if(child.child.exitCode===null&&child.child.signalCode===null){if(crash)child.child.kill('SIGKILL');else child.child.stdin.write('shutdown\n');}
 let timeout:ReturnType<typeof setTimeout>;try{return await Promise.race([child.closed,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('Child did not physically close: '+child.output())),10000);})]);}finally{clearTimeout(timeout!);}
}
for(const mode of ['gated','stop-fails']as const)test(`durable HTTP process lifecycle: ${mode}`,{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-job-lifecycle-')),media=join(dir,'media');
 const children:FixtureChild[]=[];t.after(async()=>{for(const child of children)if(child.child.exitCode===null&&child.child.signalCode===null)await stop(child,mode==='stop-fails');await rm(dir,{recursive:true,force:true});});
 await mkdir(media);const fixture=await encodedPair(dir,'h264',8);for(const role of ['reference','distorted','uncached'])await writeFile(join(media,role+'.flv'),fixture.bytes);
 let current=launch(dir,mode);children.push(current);let port=await ready(current),base=`http://127.0.0.1:${port}`;
 const cookie=`voidplayer-user=guest-${randomUUID()}`,headers=()=>({cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'});
 const entries=(await fetch(base+'/api/library').then(r=>r.json())).entries,targets=[];
 for(const [au,role]of ['reference','distorted'].entries()){
  const entry=entries.find((e:any)=>e.name===role+'.flv'),built=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`);assert.equal(built.status,200);const index=await built.json();
  const source=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});assert.equal(source.status,200);const proof=await source.json();
  targets.push({...proof.binding,sourcePtsUs:index.index.packets[au][2],picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
 }
 const input:QualityJobInput={schema:'voidplayer-psnr-frame-job',version:1,client:{id:'process-agent',kind:'agent'},request:{pairing:'caller-specified',reference:targets[0],distorted:targets[1],roi:{x:2,y:4,width:24,height:20}}};
 const submit=async(key:string)=>{const response=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers(),'idempotency-key':key},body:JSON.stringify(input)});return {response,value:await response.json()};};
 const get=async(id:string)=>{const response=await fetch(`${base}/api/quality/jobs/${id}`,{headers:{cookie}});assert.equal(response.status,200);return await response.json()as QualityJob;};
 // Deliver a complete real HTTP submission but never consume its response.
 // Worker readiness proves commit/admission occurred before the client vanishes.
 const body=JSON.stringify(input),socket=connect(port,'127.0.0.1');await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
 socket.write(`POST /api/quality/jobs HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${base}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nX-VoidPlayer-Action: quality-job\r\nIdempotency-Key: lost-response\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`);
 await until(()=>current.events.some(event=>event.event==='worker-blocked'&&event.id===1),'Real Worker did not reach its source barrier');socket.destroy();
 const replay=await submit('lost-response');assert.equal(replay.response.status,200);assert.equal(replay.value.replayed,true);const first=replay.value.job as QualityJob;
 assert.equal(first.state,'preparing');assert.equal(current.events.filter(event=>event.event==='worker-start').length,1);
 assert.notEqual(first.submitted.requestId,replay.response.headers.get('x-request-id'));
 const observer=connect(port,'127.0.0.1');await new Promise<void>(resolve=>observer.once('connect',resolve));observer.write(`GET /api/quality/jobs/${first.id} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n\r\n`);observer.destroy();
 assert.equal((await get(first.id)).state,'preparing','observer disconnect does not cancel a service-owned job');
 const duplicate=launch(dir,'normal');children.push(duplicate);const rejected=await duplicate.closed;assert.notEqual(rejected.code,0);assert.match(duplicate.output(),/另一个实例/);
 assert.equal((await get(first.id)).attempt!.id,first.attempt!.id,'another process cannot run startup recovery against this owner');
 const second=mode==='gated'?await submit('queued-second'):null;if(second){
  assert.equal(second.response.status,202);assert.equal(second.value.job.state,'queued');assert.equal(second.value.job.attempt,null);
  const actorFull=await submit('actor-full');assert.equal(actorFull.response.status,429);assert.equal(actorFull.value.code,'quality-actor-limit');
  const pending=[];
  for(let i=0;i<3;i++){
   const owner=`voidplayer-user=guest-${randomUUID()}`,response=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers(),cookie:owner,'idempotency-key':`queue-${i}`},body:JSON.stringify(input)});
   assert.equal(response.status,202);pending.push({owner,job:(await response.json()).job});
  }
  const queueFull=await fetch(base+'/api/quality/jobs',{method:'POST',headers:{...headers(),cookie:`voidplayer-user=guest-${randomUUID()}`,'idempotency-key':'queue-full'},body:JSON.stringify(input)});
  assert.equal(queueFull.status,429);assert.equal((await queueFull.json()).code,'quality-queue-full');
  for(const entry of pending){const cancelled=await fetch(`${base}/api/quality/jobs/${entry.job.id}/cancel`,{method:'POST',headers:{...headers(),cookie:entry.owner},body:'{}'});assert.equal(cancelled.status,200);const job=await cancelled.json();assert.equal(job.state,'cancelled');assert.equal(job.attempt,null);}
 }
 const cancel=await fetch(`${base}/api/quality/jobs/${first.id}/cancel`,{method:'POST',headers:headers(),body:'{}'});assert.equal(cancel.status,200);
 if(mode==='stop-fails'){
  const poisoned=await until(async()=>{const job=await get(first.id);return job.reason?.code==='worker-stop-uncertain'?job:null;},'Uncertain stop was not retained');
  assert.equal(poisoned.state,'cancelling');assert.equal(poisoned.endedAt,null);assert.equal(poisoned.result.available,false);
  assert.equal(poisoned.attempt!.state,'cancelling');
  assert.equal(current.events.filter(event=>event.event==='worker-exit').length,0,'the actual Worker is still alive');
  assert.equal((await submit('must-not-start')).response.status,503);
  const uncached=entries.find((entry:any)=>entry.name==='uncached.flv');
  const build=await fetch(`${base}/api/media/${uncached.id}/frame-index?v=${uncached.version}&build=1`);assert.equal(build.status,503);
  const cached=await fetch(`${base}/api/media/${targets[0].mediaId}/frame-index?v=${targets[0].mediaVersion}`);assert.equal(cached.status,200,'ordinary cache reads remain available');
 }else{
  await until(async()=>(await get(first.id)).state==='cancelled','Explicit cancellation did not reach a physical-stop terminal commit');
  assert.equal((await get(first.id)).cancelRequestId,cancel.headers.get('x-request-id'));
  await until(()=>current.events.some(event=>event.event==='worker-blocked'&&event.id===2),'Queued second job did not start');
  const exit=current.events.findIndex(event=>event.event==='worker-exit'&&event.id===1),start=current.events.findIndex(event=>event.event==='worker-start'&&event.id===2);
  assert.ok(exit>=0&&start>exit,'next Worker starts only after actual exit of the cancelled Worker');
 }
 const interruptedId=second?.value.job.id??first.id,beforeCrash=await get(interruptedId);await stop(current,true);
 current=launch(dir,'normal');children.push(current);port=await ready(current);base=`http://127.0.0.1:${port}`;
 const interrupted=await get(interruptedId);assert.equal(interrupted.state,'interrupted');assert.equal(interrupted.reason?.code,'service-restarted');assert.equal(interrupted.attempt!.id,beforeCrash.attempt!.id);assert.equal(interrupted.attempt!.number,1);
 const historical=await submit(second?'queued-second':'lost-response');assert.equal(historical.response.status,200);assert.equal(historical.value.job.state,'interrupted');assert.equal(current.events.filter(event=>event.event==='worker-start').length,0,'restart and idempotent replay do not retry interrupted work');
 const fresh=await submit('explicit-new-job');assert.equal(fresh.response.status,202);const completed=await until(async()=>{const job=await get(fresh.value.job.id);return job.state==='completed'?job:null;},'Fresh explicit job did not complete');
 const result=await fetch(`${base}/api/quality/jobs/${completed.id}/result`,{headers:{cookie}}).then(r=>r.json());assert.ok(result.value.result.metric.aggregate.sse>0);
 assert.equal(result.submitted.actorId,cookie.slice(16));assert.equal(result.value.sources.reference.binding.mediaVersion,targets[0].mediaVersion);
 assert.equal((await stop(current)).code,0);
});

test('SIGKILL after real child result commit preserves validated scored facts before the parent poll', {timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-range-commit-crash-')),media=join(dir,'media'),marker=join(dir,'child-committed.json'),children:FixtureChild[]=[];
 t.after(async()=>{for(const child of children)if(child.child.exitCode===null&&child.child.signalCode===null)await stop(child,true);await rm(dir,{recursive:true,force:true});});
 await mkdir(media);const sample=JSON.parse(await readFile(new URL('../helpers/quality-http-samples.json',import.meta.url),'utf8')).samples.find((s:any)=>s.codec==='h264'&&s.depth===8&&s.tagged);
 for(const name of ['B.flv','C.flv'])await writeFile(join(media,name),Buffer.from(sample.flv,'base64'));
 let current=launch(dir,'normal',marker);children.push(current);let port=await ready(current),base=`http://127.0.0.1:${port}`;
 const cookie=`voidplayer-user=guest-${randomUUID()}`,headers=()=>({cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'}),targets=[];
 const entries=await until(async()=>{const list=(await fetch(base+'/api/library').then(r=>r.json())).entries;return list.filter((e:any)=>e.state==='ready').length===2?list:null;},'Real sources never became ready');
 for(const [au,name] of ['B.flv','C.flv'].entries()){
  const e=entries.find((e:any)=>e.name===name),built=await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}&build=1`);assert.equal(built.status,200);const index=await built.json();
  const proof=await fetch(`${base}/api/media/${e.id}/psnr-source?v=${e.version}`,{headers:{cookie}}).then(r=>r.json());
  targets.push({...proof.binding,sourcePtsUs:index.index.packets[au][2],picture:{sourceVersion:`${e.id}@${e.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
 }
 const input:QualityRangeInput={schema:'voidplayer-quality-range',version:1,client:{id:'commit-crash',kind:'agent'},interval:{startAu:0,endAu:0},correspondence:{mode:'explicit-au-table'},sampling:{mode:'all'},pairs:[{pairing:'caller-specified',reference:targets[0],distorted:targets[1],roi:{x:0,y:0,width:32,height:32},budget:{maxReadBytes:65536,maxInputBytes:65536}}],budget:{maxReadBytes:65536,maxInputBytes:65536,maxPackets:2,maxOutputFrames:2,maxElapsedMs:10000}};
 const submission=fetch(base+'/api/quality/ranges',{method:'POST',headers:{...headers(),'idempotency-key':'commit-crash'},body:JSON.stringify(input)}).then(r=>r.text()).catch(()=>undefined);
 const crashed=await current.closed;await submission;assert.notEqual(crashed.code,0);
 const committed=JSON.parse(await readFile(marker,'utf8')),parentId=committed.submitted.client.id.slice('range:'.length);assert.equal(committed.state,'completed');assert.equal(committed.result.available,true);
 const childFile=join(dir,'library.sqlite.quality.sqlite'),parentFile=join(dir,'library.sqlite.quality-ranges.sqlite'),db=openIndexDatabase(childFile),row=db.prepare('SELECT actor_id,input_json,result_json,result_sha FROM quality_jobs WHERE id=?').get(committed.id)!;db.close();
 const parentDb=openIndexDatabase(parentFile),parentBody=String(parentDb.prepare('SELECT body FROM quality_ranges WHERE id=?').get(parentId)!.body);parentDb.close();
 assert.notEqual(JSON.parse(parentBody).samples[0].state,'completed','the real child commit precedes parent publication');
 for(const fault of ['actor','source','result-source','budget','numeric','actual-work'] as const){
  const badInput=JSON.parse(String(row.input_json)),badResult=JSON.parse(String(row.result_json));let badActor=String(row.actor_id);
  if(fault==='actor')badActor=`guest-${randomUUID()}`;
  if(fault==='source')badInput.request.reference.indexBuildId+='-changed';
  if(fault==='result-source'){badResult.value.result.provenance.reference.indexBuildId+='-changed';badResult.value.sources.reference.binding.indexBuildId=badResult.value.result.provenance.reference.indexBuildId;}
  if(fault==='budget')badInput.request.budget.maxReadBytes*=2;
  if(fault==='numeric')badResult.value.result.metric.aggregate.sse++;
  if(fault==='actual-work')badResult.value.result.work.readBytes=65537;
  const json=JSON.stringify(badResult),write=openIndexDatabase(childFile);write.prepare('UPDATE quality_jobs SET actor_id=?,input_json=?,result_json=?,result_sha=? WHERE id=?').run(badActor,JSON.stringify(badInput),json,createHash('sha256').update(json).digest('hex'),committed.id);write.close();
  const rejected=launch(dir,'normal');children.push(rejected);const closed=await rejected.closed;assert.notEqual(closed.code,0,`${fault} mismatch must fail recovery`);assert.equal(rejected.events.filter(e=>e.event==='worker-start').length,0);
  const inspect=openIndexDatabase(parentFile);try{assert.equal(String(inspect.prepare('SELECT body FROM quality_ranges WHERE id=?').get(parentId)!.body),parentBody,'invalid recovery rolls back the parent transaction');}finally{inspect.close();}
 }
 const restore=openIndexDatabase(childFile);restore.prepare('UPDATE quality_jobs SET actor_id=?,input_json=?,result_json=?,result_sha=? WHERE id=?').run(String(row.actor_id),String(row.input_json),String(row.result_json),String(row.result_sha),committed.id);restore.close();
 current=launch(dir,'normal');children.push(current);port=await ready(current);base=`http://127.0.0.1:${port}`;
 const get=async(url:string)=>{const r=await fetch(base+url,{headers:{cookie}});assert.equal(r.status,200,await r.clone().text());return r.json();};
 const restored=await get(`/api/quality/ranges/${parentId}`),child=await get(`/api/quality/jobs/${committed.id}`),result=await get(`/api/quality/jobs/${committed.id}/result`),page=await get(`/api/quality/ranges/${parentId}/results`);
 assert.equal(restored.job.state,'interrupted');assert.equal(restored.job.samples[0].state,'completed');assert.equal(child.state,'completed');assert.equal(child.attempt.id,committed.attempt.id);
 assert.equal(restored.job.summary.scoredPairs,1);assert.equal(restored.job.summary.groups[0].metric.sse,263374);assert.deepEqual(restored.coverage.scored,[0]);assert.deepEqual(restored.coverage.holes,[]);assert.equal(restored.coverage.complete,false);
 assert.equal(page.entries.length,1);assert.deepEqual(page.entries[0].result,result);assert.equal(restored.job.samples[0].result.digest,child.result.digest);
 const replay=await fetch(base+'/api/quality/ranges',{method:'POST',headers:{...headers(),'idempotency-key':'commit-crash'},body:JSON.stringify(input)});assert.equal(replay.status,200);assert.equal((await replay.json()).job.id,parentId);assert.equal(current.events.filter(e=>e.event==='worker-start').length,0,'recovery/replay never recomputes committed scores');
 assert.equal((await stop(current)).code,0);
});

for(const mode of ['gated','stop-fails'] as const)test(`bounded range process lifecycle: ${mode}`,{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-range-lifecycle-')),media=join(dir,'media'),children:FixtureChild[]=[];
 t.after(async()=>{for(const c of children)if(c.child.exitCode===null&&c.child.signalCode===null)await stop(c,true);await rm(dir,{recursive:true,force:true});});
 await mkdir(media);const fixture=await encodedPair(dir,'h264',8);for(const name of ['reference','distorted'])await writeFile(join(media,name+'.flv'),fixture.bytes);
 let current=launch(dir,mode);children.push(current);let port=await ready(current),base=`http://127.0.0.1:${port}`;
 const cookie=`voidplayer-user=guest-${randomUUID()}`,headers=()=>({cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-job'});
 const entries=(await fetch(base+'/api/library').then(r=>r.json())).entries,targets=[];
 for(const [au,role] of ['reference','distorted'].entries()){
  const e=entries.find((x:any)=>x.name===role+'.flv'),built=await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}&build=1`);assert.equal(built.status,200);const index=await built.json();
  const proof=await fetch(`${base}/api/media/${e.id}/psnr-source?v=${e.version}`,{headers:{cookie}}).then(r=>r.json());
  targets.push({...proof.binding,sourcePtsUs:index.index.packets[au][2],picture:{sourceVersion:`${e.id}@${e.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
 }
 const input:QualityRangeInput={schema:'voidplayer-quality-range',version:1,client:{id:'range-process',kind:'agent'},interval:{startAu:0,endAu:0},correspondence:{mode:'explicit-au-table'},sampling:{mode:'all'},
  pairs:[{pairing:'caller-specified',reference:targets[0],distorted:targets[1],roi:{x:2,y:4,width:24,height:20},budget:{maxReadBytes:1024*1024,maxInputBytes:1024*1024}}],
  budget:{maxReadBytes:1024*1024,maxInputBytes:1024*1024,maxPackets:2,maxOutputFrames:2,maxElapsedMs:30000}};
 const submit=async(key:string)=>{const response=await fetch(base+'/api/quality/ranges',{method:'POST',headers:{...headers(),'idempotency-key':key},body:JSON.stringify(input)});return {response,value:await response.json()};};
 const get=async(id:string)=>{const r=await fetch(`${base}/api/quality/ranges/${id}`,{headers:{cookie}});assert.equal(r.status,200);return r.json();};
 const body=JSON.stringify(input),socket=connect(port,'127.0.0.1');await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
 socket.write(`POST /api/quality/ranges HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${base}\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nX-VoidPlayer-Action: quality-job\r\nIdempotency-Key: range-lost\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`);
 await until(()=>current.events.some(e=>e.event==='worker-blocked'&&e.id===1),'Range child did not reach actual source gate');socket.destroy();
 const replay=await submit('range-lost');assert.equal(replay.response.status,200);assert.equal(replay.value.replayed,true);const first=replay.value.job;
 assert.equal(first.state,'running');assert.equal(first.samples.length,1);assert.notEqual(first.requestId,replay.response.headers.get('x-request-id'));assert.equal(current.events.filter(e=>e.event==='worker-start').length,1);
 const child=await fetch(`${base}/api/quality/jobs/${first.samples[0].jobId}`,{headers:{cookie}}).then(r=>r.json());assert.ok(child.attempt.id);assert.equal(child.state,'preparing');
 const observer=connect(port,'127.0.0.1');await new Promise<void>(resolve=>observer.once('connect',resolve));observer.write(`GET /api/quality/ranges/${first.id} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n\r\n`);observer.destroy();assert.equal((await get(first.id)).job.state,'running');
 const second=mode==='gated'?await submit('range-second'):null;
 if(second){assert.equal(second.response.status,202);assert.equal(second.value.job.state,'queued');assert.equal((await submit('range-overload')).response.status,429);}
 const cancel=await fetch(`${base}/api/quality/ranges/${first.id}/cancel`,{method:'POST',headers:headers(),body:'{}'});assert.equal(cancel.status,200);
 if(mode==='stop-fails'){
  const poisoned=await until(async()=>{const d=await get(first.id);return d.job.reason?.code==='worker-stop-uncertain'?d:null;},'Range did not retain uncertain physical stop');
  assert.equal(poisoned.job.state,'cancelling');assert.equal(poisoned.job.endedAt,null);assert.equal(poisoned.progress.active.phase,'stopping');
  assert.equal(current.events.filter(e=>e.event==='worker-exit').length,0);assert.equal((await submit('range-no-start')).response.status,503);
 }else{
  await until(async()=>(await get(first.id)).job.state==='cancelled','Range cancellation did not wait for physical exit');
  await until(()=>current.events.some(e=>e.event==='worker-blocked'&&e.id===2),'Next range child never started');
  assert.ok(current.events.findIndex(e=>e.event==='worker-exit'&&e.id===1)<current.events.findIndex(e=>e.event==='worker-start'&&e.id===2));
 }
 const interruptedId=second?.value.job.id??first.id,before=await get(interruptedId);assert.equal(before.job.samples.length,1);const beforeChild=await fetch(`${base}/api/quality/jobs/${before.job.samples[0].jobId}`,{headers:{cookie}}).then(r=>r.json());
 await stop(current,true);current=launch(dir,'normal');children.push(current);port=await ready(current);base=`http://127.0.0.1:${port}`;
 const recovered=await get(interruptedId);assert.equal(recovered.job.state,'interrupted');assert.equal(recovered.job.samples[0].state,'interrupted');
 const recoveredChild=await fetch(`${base}/api/quality/jobs/${beforeChild.id}`,{headers:{cookie}}).then(r=>r.json());assert.equal(recoveredChild.state,'interrupted');assert.equal(recoveredChild.attempt.id,beforeChild.attempt.id);
 const historical=await submit(second?'range-second':'range-lost');assert.equal(historical.response.status,200);assert.equal(historical.value.job.state,'interrupted');assert.equal(current.events.filter(e=>e.event==='worker-start').length,0);
 const fresh=await submit('range-explicit-new');assert.equal(fresh.response.status,202);const done=await until(async()=>{const d=await get(fresh.value.job.id);return d.job.state==='completed'?d:null;},'Fresh range did not complete');assert.equal(done.coverage.complete,true);assert.equal(done.job.summary.scoredPairs,1);
 assert.equal((await stop(current)).code,0);
});
