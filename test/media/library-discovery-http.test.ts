import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MediaLibraryIndex } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import type { AddressInfo } from 'node:net';
const sample=JSON.parse(await readFile(new URL('../helpers/quality-http-samples.json',import.meta.url),'utf8')).samples.find((s:any)=>s.codec==='h264'&&s.depth===8&&s.tagged);
async function setup(t:any,persistent=true){const dir=await mkdtemp(path.join(tmpdir(),'vp-discovery-http-')),media=path.join(dir,'media');await mkdir(media);
  let library:MediaLibraryIndex|undefined,server:ReturnType<typeof createMediaServer>|undefined;
  t.after(async()=>{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await library?.close();await rm(dir,{recursive:true,force:true});});
  const flv=path.join(media,'reference.flv');await writeFile(flv,Buffer.from(sample.flv,'base64'));
  const fixtures=JSON.parse(await readFile(new URL('../helpers/library-discovery-samples.json',import.meta.url),'utf8'));
  for(const format of ['mp4','mkv','ts']){const fixture=fixtures.samples.find((s:any)=>s.name===`h264-8-tagged.${format}`);await writeFile(path.join(media,`reference.${format}`),Buffer.from(fixture.bytes,'base64'));}
  library=new MediaLibraryIndex([media],{...(persistent?{database:path.join(dir,'library.sqlite')}:{}),watch:false});await library.refresh();
  server=createMediaServer({library,roots:[media],onLog(){}});await library.qualityApplication.ready;await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,actor=`guest-${randomUUID()}`,headers={cookie:`voidplayer-user=${actor}`,'x-voidplayer-actor':actor};
  const post=(body:unknown,key:string=randomUUID(),extra={})=>fetch(base+'/api/library/preparations',{method:'POST',headers:{...headers,origin:base,'x-voidplayer-action':'library-preparation','content-type':'application/json','idempotency-key':key,...extra},body:JSON.stringify(body)});
  const wait=async(id:string)=>{const deadline=Date.now()+15000;for(;;){const r=await fetch(base+`/api/library/preparations/${id}`,{headers});assert.equal(r.status,200);const job=await r.json();if(!['queued','running','cancelling'].includes(job.state))return job;if(Date.now()>deadline)throw Error('Preparation did not settle');await new Promise(r=>setTimeout(r,10));}};
  return {dir,media,library,server,base,headers,post,wait,entries:library.browse({recursive:true}).entries};
}
test('real HTTP discovers unknown without media IO, explicitly probes MP4/Matroska/TS/FLV, and never admits metadata as scoring',async t=>{
  const f=await setup(t);
  const schema=await fetch(f.base+'/api/library/discovery-schema').then(r=>r.json()),agent=await fetch(f.base+'/api/agent').then(r=>r.json());
  for(const key of Object.keys(schema))assert.deepEqual(agent.libraryDiscovery[key],schema[key],key);assert.equal(schema.preparationRequest.responses.accepted,202);assert.equal(schema.limits.probeBytes,4*1024*1024);
  assert.match(schema.fields.streamInventory,/subtitle\/data\/unknown/);assert.match(schema.fields.clock,/not-established/);
  const head=await fetch(f.base+'/api/library/discovery-schema',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  const guide=await fetch(f.base+'/agent/library.md').then(r=>r.text());for(const term of ['recordsReady=1','streamInventoryComplete','X-VoidPlayer-Actor','physical','initial container declarations'])assert.ok(guide.includes(term),term);
  const initial=await fetch(f.base+'/api/library/discovery?codec=h264&limit=2').then(r=>r.json());assert.equal(initial.coverage.total,null);assert.equal(initial.coverage.cumulative.unknown,2);
  const continued=await fetch(f.base+`/api/library/discovery?codec=h264&limit=2&cursor=${initial.nextCursor}`).then(r=>r.json());assert.equal(continued.coverage.exhausted,true);assert.equal(continued.coverage.cumulative.unknown,4);
  assert.equal(new Set([...initial.entries,...continued.entries].map((e:any)=>e.source.id)).size,4);
  assert.equal(Number(f.library.discovery.store.db.prepare('SELECT count(*) AS n FROM media_index_manifests').get()!.n),0);
  for(const entry of f.entries){const body={source:{id:entry.id,version:entry.version},operation:'probe',client:{id:'agent',name:'HTTP Agent'}};
    const wrong=await f.post(body,randomUUID(),{'x-voidplayer-actor':`guest-${randomUUID()}`});assert.equal(wrong.status,409);assert.equal((await wrong.json()).code,'actor-changed');
    assert.equal((await f.post(body,randomUUID(),{origin:'https://foreign.invalid'})).status,403);
    const key=randomUUID(),accepted=await f.post(body,key);assert.equal(accepted.status,202,await accepted.clone().text());const received=await accepted.json();
    const job=await f.wait(received.job.id);assert.equal(job.state,'completed',JSON.stringify(job));assert.equal(job.result.source.id,entry.id);
    const repeated=await f.post(body,key);assert.equal(repeated.status,200);assert.equal((await repeated.json()).job.id,job.id);
    const detail=await fetch(`${f.base}/api/media/${entry.id}/discovery?v=${entry.version}`).then(r=>r.json());
    assert.equal(detail.technical.probe.streams[0].fields.codec.value,'h264');assert.equal(detail.technical.probe.streams[0].fields.width.value,32);
    assert.equal(detail.scoring.state,'requires-quality-source-check');assert.ok(detail.technical.probe.coverage.bytesRead<=4*1024*1024);
    const unavailable=await fetch(`${f.base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:f.headers});assert.notEqual(unavailable.status,200,'metadata never mints a trusted quality cache');
    const other=await fetch(`${f.base}/api/library/preparations/${job.id}`,{headers:{cookie:`voidplayer-user=guest-${randomUUID()}`}});assert.equal(other.status,404);
  }
  const result=await fetch(f.base+'/api/library/discovery?codec=h264&limit=32').then(r=>r.json());assert.equal(result.coverage.exhausted,true);assert.equal(result.coverage.totals.match,4);
  const flv=f.entries.find(e=>e.name.endsWith('.flv'))!;
  const built=await f.post({source:{id:flv.id,version:flv.version},operation:'quality-index',client:{id:'agent',name:'HTTP Agent'}});assert.equal(built.status,202);
  const done=await f.wait((await built.json()).job.id);assert.equal(done.state,'completed',JSON.stringify(done));
  assert.equal((await fetch(`${f.base}/api/media/${flv.id}/psnr-source?v=${flv.version}`,{headers:f.headers})).status,200);
  assert.equal((await fetch(f.base+`/api/library/discovery?codec=h264&limit=2&cursor=${initial.nextCursor}`)).status,409,'cache/probe change invalidates real HTTP continuation');
  const release=f.library.qualityAdmission.acquire(),changedKey=randomUUID(),changedBody={source:{id:flv.id,version:flv.version},operation:'probe',client:{id:'agent',name:'HTTP Agent'}};
  try{const accepted=await f.post(changedBody,changedKey);assert.equal(accepted.status,202);const id=(await accepted.json()).job.id;
    await writeFile(path.join(f.media,'reference.flv'),Buffer.concat([Buffer.from(sample.flv,'base64'),Buffer.from([0])]));await f.library.refresh();release();
    const failed=await f.wait(id);assert.equal(failed.state,'failed');assert.equal(failed.reason.code,'source-changed');assert.equal(failed.result,null);
    const replay=await f.post(changedBody,changedKey);assert.equal(replay.status,200);assert.equal((await replay.json()).job.id,id,'receipt remains replayable after actual source version change');
    assert.equal((await fetch(f.base+`/api/media/${flv.id}/discovery?v=${flv.version}`)).status,409);
  }finally{release();}
  const audioSample=JSON.parse(await readFile(new URL('../helpers/library-discovery-samples.json',import.meta.url),'utf8')).audioSamples[0];
  await writeFile(path.join(f.media,'audio-only.flv'),Buffer.from(audioSample.bytes,'base64'));await f.library.refresh();const audio=f.library.browse({recursive:true}).entries.find(e=>e.name==='audio-only.flv')!;
  const acceptedAudio=await f.post({source:{id:audio.id,version:audio.version},operation:'probe',client:{id:'agent',name:'HTTP Agent'}});assert.equal(acceptedAudio.status,202);
  const audioJob=await f.wait((await acceptedAudio.json()).job.id);assert.equal(audioJob.state,'completed');assert.equal(audioJob.result.streams[0].type,'audio');assert.equal(audioJob.result.streams[0].fields.codec.value,'mp3');assert.equal(audioJob.result.coverage.prefix.tagHeadersInspected,8);
  const audioPage=await fetch(f.base+'/api/library/discovery?search=audio-only&codec=h264').then(r=>r.json());assert.equal(audioPage.entries[0].decision.state,'unknown');assert.equal(audioPage.coverage.totals.unknown,1);
  assert.notEqual((await fetch(`${f.base}/api/media/${audio.id}/psnr-source?v=${audio.version}`,{headers:f.headers})).status,200);
});
test('durable preparations respect shared busy admission, per-actor/global queue budgets, cancellation and ephemeral discovery',async t=>{
 const f=await setup(t),entry=f.entries[0],body={source:{id:entry.id,version:entry.version},operation:'probe',client:{id:'agent',name:'HTTP Agent'}};
 const release=f.library.qualityAdmission.acquire();t.after(release);
 const jobs:any[]=[];
 for(let i=0;i<4;i++){const r=await f.post(body,`actor-a-${i}`);assert.equal(r.status,202);const value=await r.json();jobs.push(value.job);assert.equal(value.job.state,'queued');assert.equal(value.job.attemptId,null);}
 const actorFull=await f.post(body,'a-full');assert.equal(actorFull.status,429);assert.equal((await actorFull.json()).code,'preparation-actor-limit');
 const other=`guest-${randomUUID()}`,otherHeaders={cookie:`voidplayer-user=${other}`,'x-voidplayer-actor':other};
 for(let i=0;i<4;i++){const r=await f.post(body,`actor-b-${i}`,otherHeaders);assert.equal(r.status,202);jobs.push((await r.json()).job);}
 const globalFull=await f.post(body,'global-full',{cookie:`voidplayer-user=guest-${randomUUID()}`,'x-voidplayer-actor':f.headers['x-voidplayer-actor']});assert.equal(globalFull.status,409,'inconsistent captured actor is rejected before queue accounting');
 const third=`guest-${randomUUID()}`,full=await f.post(body,'global-full-valid',{cookie:`voidplayer-user=${third}`,'x-voidplayer-actor':third});assert.equal(full.status,429);assert.equal((await full.json()).code,'preparation-queue-full');
 for(const job of jobs){const actor=job.submitted.actorId;const r=await fetch(f.base+`/api/library/preparations/${job.id}/cancel`,{method:'POST',headers:{cookie:`voidplayer-user=${actor}`,'x-voidplayer-actor':actor,origin:f.base,'x-voidplayer-action':'library-preparation','content-type':'application/json'},body:'{}'});assert.equal(r.status,200);assert.equal((await r.json()).state,'cancelled');}
 release();assert.equal(Number(f.library.discovery.store.db.prepare('SELECT count(*) AS n FROM discovery_probes').get()!.n),0,'queued/cancelled preparation never read or published metadata');
 const temporary=await setup(t,false),agent=await fetch(temporary.base+'/api/agent').then(r=>r.json());assert.equal(agent.capabilities.find((c:any)=>c.id==='library.discovery').enabled,true);assert.equal(agent.capabilities.find((c:any)=>c.id==='library.preparations').enabled,false);
 assert.equal((await fetch(temporary.base+'/api/library/discovery')).status,200);const item=temporary.entries[0];const denied=await temporary.post({source:{id:item.id,version:item.version},operation:'probe',client:{id:'agent',name:'HTTP Agent'}});assert.equal(denied.status,503);assert.equal((await denied.json()).code,'preparation-storage-unavailable');
});
