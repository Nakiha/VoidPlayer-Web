import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {loadConfig} from '../../server/config.ts';
import {startService} from '../../server/runtime.ts';
import {DiscoveryProbeRunner} from '../../server/discovery/probe-runner.ts';
import {openIndexDatabase} from '../../server/sqlite.ts';
// @ts-ignore shared readiness helper
import {waitForAnnotationMedia} from '../../scripts/testing/agent-annotations-ready.mjs';

const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,10));
async function until(predicate:()=>boolean|Promise<boolean>,label:string){
  const end=Date.now()+15000;
  while(!await predicate()){if(Date.now()>end)assert.fail(label);await pause();}
}
const sample=JSON.parse(await readFile(new URL('../helpers/quality-http-samples.json',import.meta.url),'utf8')).samples.find((s:any)=>s.codec==='h264'&&s.depth===8&&s.tagged);

test('discovery and ranges retain one physical-exit admission and independent durable HTTP histories across restart',{timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vp-discovery-ranges-')),media=join(dir,'media');
  let service:Awaited<ReturnType<typeof startService>>|undefined,probe:DiscoveryProbeRunner|undefined;
  let allowStop=()=>{};let probeWork:Promise<unknown>|undefined;
  t.after(async()=>{allowStop();await probeWork;await probe?.close();await service?.close();await rm(dir,{recursive:true,force:true});});
  await mkdir(media);const file=join(media,'source.flv');await writeFile(file,Buffer.from(sample.flv,'base64'));
  const config=await loadConfig([],'production',dir,{staticDir:resolve('public'),dataDir:join(dir,'data'),allowEmptyRoots:true});
  config.logsDir=null;config.mediaRoots=[media];config.indexWatch=false;config.port=0;
  service=await startService(config,false);await service.library.refresh();
  const base=`http://127.0.0.1:${(service.server.address() as {port:number}).port}`;config.port=(service.server.address() as {port:number}).port;
  const actor=`guest-${randomUUID()}`,headers={cookie:`voidplayer-user=${actor}`,'x-voidplayer-actor':actor,origin:base,'content-type':'application/json'};
  const get=(url:string,extra={})=>fetch(base+url,{headers:{...headers,...extra}});
  const post=(url:string,body:unknown,action:string,key:string,extra={})=>fetch(base+url,{method:'POST',headers:{...headers,'x-voidplayer-action':action,'idempotency-key':key,...extra},body:JSON.stringify(body)});
  const library=service.library,[entry]=await waitForAnnotationMedia(library,['source.flv']),source={id:entry.id,version:entry.version!};
  const version=()=>{const db=openIndexDatabase(library.indexDatabase);try{return Number(db.prepare('PRAGMA user_version').get()!.user_version);}finally{db.close();}};
  const beforeSchema=version();
  const built=await post(`/api/media/${source.id}/psnr-index`,{version:source.version},'quality-source-build','explicit-index');assert.equal(built.status,200,await built.clone().text());
  const binding=(await built.json()).binding,cache=await get(`/api/media/${source.id}/frame-index?v=${source.version}`).then(r=>r.json());
  const target=(au:number)=>({...binding,sourcePtsUs:cache.index.packets[au][2],picture:{sourceVersion:`${source.id}@${source.version}`,stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
  const range={schema:'voidplayer-quality-range',version:1,client:{id:'discovery-range-integration',kind:'agent'},interval:{startAu:0,endAu:1},correspondence:{mode:'explicit-au-table'},sampling:{mode:'all'},
    pairs:[0,1].map(au=>({pairing:'caller-specified',reference:target(au),distorted:target(au),roi:{x:0,y:0,width:32,height:32},budget:{maxReadBytes:1024*1024,maxInputBytes:1024*1024}})),
    budget:{maxReadBytes:2*1024*1024,maxInputBytes:2*1024*1024,maxPackets:4,maxOutputFrames:4,maxElapsedMs:30000}};
  const preparation={source,operation:'probe',client:{id:'discovery-range-integration',name:'Integration Agent'}};
  const plan=await post('/api/quality/ranges/plan',range,'quality-job','plan');assert.equal(plan.status,200,await plan.clone().text());
  const agent=await get('/api/agent').then(r=>r.json());assert.ok(agent.libraryDiscovery);assert.ok(agent.qualityRanges);
  assert.equal((await get('/api/library/discovery')).status,200);assert.equal((await get('/api/quality/ranges')).status,200);
  assert.equal(version(),beforeSchema,'discovery tables do not advance the main library schema used by range children');

  // An actual probe holds the shared instance permit while its open file is
  // closed and its real Worker is waiting behind a physical-termination gate.
  const state=new Int32Array(new SharedArrayBuffer(8)),controller=new AbortController();
  let exited=false,stopping=false;const stopGate=new Promise<void>(r=>allowStop=r);
  probe=new DiscoveryProbeRunner(library.indexDatabase,library.qualityAdmission,data=>{
    const worker=new Worker(new URL('../helpers/discovery-phase-worker.ts',import.meta.url),{workerData:{...data,phaseState:state.buffer,hangPhase:'opened'},trackUnmanagedFds:true});
    worker.once('exit',()=>exited=true);const terminate=worker.terminate.bind(worker);
    worker.terminate=async()=>{stopping=true;await stopGate;return terminate();};return worker;
  });
  let outcome:unknown;
  probeWork=probe.run(source,controller.signal,()=>{}).then(value=>{outcome=value;},error=>{outcome=error;});
  await until(()=>Atomics.load(state,0)===1,'real probe did not open the file');
  const acceptedPrep=await post('/api/library/preparations',preparation,'library-preparation','prepare'),acceptedRange=await post('/api/quality/ranges',range,'quality-job','range');
  assert.equal(acceptedPrep.status,202);assert.equal(acceptedRange.status,202);
  const prep=(await acceptedPrep.json()).job,r=(await acceptedRange.json()).job;
  await until(()=>library.qualityRanges.get(r.id,actor).samples.length===1,'range did not enqueue its child');
  const child=()=>library.qualityJobs.get(library.qualityRanges.get(r.id,actor).samples[0].jobId,actor);
  assert.equal(library.discovery.store.get(prep.id).state,'queued');assert.equal(library.discovery.store.get(prep.id).attemptId,null);
  assert.equal(child().state,'queued');assert.equal(child().attempt,null);
  controller.abort('integration cancellation');await until(()=>stopping,'probe did not reach physical stop');
  assert.equal(exited,false);assert.throws(()=>library.qualityAdmission.acquire(),{code:'quality-busy'});
  assert.equal((await get(`/api/library/preparations/${prep.id}`).then(r=>r.json())).attemptId,null);
  assert.equal(child().attempt,null,'range cannot bypass preparation stop through a private permit');
  allowStop();await probeWork;assert.equal(outcome,'integration cancellation');assert.equal(exited,true);
  await until(async()=>{
    const p=await get(`/api/library/preparations/${prep.id}`).then(r=>r.json()),v=await get(`/api/quality/ranges/${r.id}`).then(r=>r.json());
    assert.ok(!['failed','interrupted'].includes(p.state),JSON.stringify(p));assert.ok(!['failed','partial','interrupted'].includes(v.job.state),JSON.stringify(v));
    return p.state==='completed'&&v.job.state==='completed';
  },'queued preparation and actual range decoding did not complete after physical exit');
  const completedPrep=await get(`/api/library/preparations/${prep.id}`).then(r=>r.json()),completedRange=await get(`/api/quality/ranges/${r.id}`).then(r=>r.json());
  assert.ok(completedPrep.result.streams.some((s:any)=>s.fields.codec.value==='h264'));
  assert.deepEqual(completedRange.coverage.scored,[0,1]);assert.equal(completedRange.job.summary.groups[0].metric.sse,0);
  assert.equal(library.qualityJobs.resources().queued,0);const release=library.qualityAdmission.acquire();release();
  const other=`guest-${randomUUID()}`;
  for(const url of [`/api/library/preparations/${prep.id}`,`/api/quality/ranges/${r.id}`]){
    assert.equal((await get(url,{cookie:`voidplayer-user=${other}`,'x-voidplayer-actor':other})).status,404);
    assert.equal((await get(url,{'x-voidplayer-actor':other})).status,409);
  }
  await probe.close();await service.close();service=undefined;
  // Receipts/history are independent of the source still being available. No
  // implicit probe, rebuild, decode or new child may be created on replay.
  await rm(file);service=await startService(config,false);
  assert.equal(version(),beforeSchema);
  assert.deepEqual(await get(`/api/library/preparations/${prep.id}`).then(r=>r.json()),completedPrep);
  assert.deepEqual((await get(`/api/quality/ranges/${r.id}`).then(r=>r.json())).job,completedRange.job);
  const replayPrep=await post('/api/library/preparations',preparation,'library-preparation','prepare'),replayRange=await post('/api/quality/ranges',range,'quality-job','range');
  assert.equal(replayPrep.status,200);assert.equal(replayRange.status,200);
  assert.equal((await replayPrep.json()).job.id,prep.id);assert.equal((await replayRange.json()).job.id,r.id);
  assert.equal(service.library.qualityJobs.resources().queued,0);
});
