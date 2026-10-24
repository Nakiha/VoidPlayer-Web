import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { encodedPair } from '../helpers/library-pair-fixture.ts';
import type { QualityJobInput,QualityJob } from '../../shared/analysis/quality/jobs.ts';
type FixtureChild={child:ChildProcessWithoutNullStreams;events:any[];closed:Promise<{code:number|null;signal:NodeJS.Signals|null}>;output:()=>string};
async function until<T>(check:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{
 for(let i=0;i<500;i++){const value=await check();if(value)return value as NonNullable<T>;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail(label);
}
function launch(dir:string,mode:string):FixtureChild{
 const child=spawn(process.execPath,[resolve('test/helpers/quality-job-server.ts'),dir,mode],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']}),events:any[]=[];let buffer='',output='';
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
