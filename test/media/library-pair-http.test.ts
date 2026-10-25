import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm,realpath,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { readdirSync,readlinkSync,realpathSync,statSync,openSync,closeSync,fstatSync } from 'node:fs';
import { LibraryPairRunner } from '../../server/analysis/quality/runner.ts';
import {fileStatWitness,sameFileStat} from '../../server/file-stat.ts';
import type { AddressInfo } from 'node:net';
import { MediaLibraryIndex } from '../../server/library.ts';
import { createMediaServer } from '../../server/app.ts';
import { measurePsnr } from '../../shared/analysis/quality/psnr.ts';
import { rgbaDescription } from '../../shared/media/frame-description.ts';
import { wrapFlv, pairRequest } from '../helpers/frame-pair-fixture.ts';
import type { PairTarget } from '../../shared/analysis/quality/frame-pair.ts';
import type { LibraryPairBinding, LibraryPairResponse } from '../../shared/analysis/quality/library-pair.ts';
import { encodedPair } from '../helpers/library-pair-fixture.ts';
function nativeFrame(pixels:Uint8Array,depth:8|10){const bytes=depth===8?1:2;return {pixels,description:rgbaDescription(32,32,{format:'YUV',stride:null,byteLength:pixels.length,
 color:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false},yuv:{bitDepth:depth,bitShift:0,subsampleX:1,subsampleY:1,semiplanar:false,chromaLocation:1,
 planes:[{offset:0,stride:32*bytes,width:32,height:32},{offset:1024*bytes,stride:16*bytes,width:16,height:16},{offset:1280*bytes,stride:16*bytes,width:16,height:16}]}})};}

for(const [codec,depth] of [['h264',8],['hevc',8],['hevc',10]] as const)test(`HTTP library ${codec} ${depth}-bit: explicit server cache to actual Worker SSE/provenance`,{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-library-pair-'));
 let library:MediaLibraryIndex,server:ReturnType<typeof createMediaServer>;
 // node:test after hooks run in registration order. Windows cannot remove an
 // open SQLite database, so close every owner before attempting directory removal.
 t.after(async()=>{
  if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(library)await library.close();
  await rm(dir,{recursive:true,force:true});
 });
 const media=join(dir,'media');await mkdir(media);
 const fixture=await encodedPair(dir,codec,depth);
 await writeFile(join(media,'reference.flv'),fixture.bytes);await writeFile(join(media,'distorted.flv'),fixture.bytes);
 if(codec==='h264'){
  await writeFile(join(media,'gated-source.flv'),fixture.bytes);await writeFile(join(media,'client.flv'),fixture.bytes);await writeFile(join(media,'uncached.flv'),fixture.bytes);
  await writeFile(join(media,'missing-color.flv'),(await encodedPair(dir,'h264',8,false)).bytes);
  const at=8,length=fixture.configuration[at-2]*256+fixture.configuration[at-1],prefix=Buffer.alloc(4+length);
  prefix.writeUInt32BE(length);prefix.set(fixture.configuration.subarray(at,at+length),4);
  await writeFile(join(media,'repeated.flv'),wrapFlv('h264',fixture.configuration,fixture.packets.map(packet=>Buffer.concat([prefix,packet]))));
  const changed=Buffer.from(prefix);changed[changed.length-1]^=1;
  await writeFile(join(media,'changed-parameter.flv'),wrapFlv('h264',fixture.configuration,fixture.packets.map(packet=>Buffer.concat([changed,packet]))));
  const duplicate=Buffer.from(fixture.bytes),firstTag=13,secondTag=firstTag+15+5+fixture.configuration.length,thirdTag=secondTag+15+5+fixture.packets[0].length;
  duplicate.writeUIntBE(2000,thirdTag+4,3);duplicate[thirdTag+7]=0;
  await writeFile(join(media,'duplicate-pts.flv'),duplicate);
 }
 if(process.platform==='win32'){
  const file=join(media,'reference.flv'),asyncPath=await realpath(file),syncPath=realpathSync(file);
  const short=(value:string)=>value.split(/[\\/]/).some(part=>/~\d/.test(part));
  const fd=openSync(file,'r');try{
   console.info(JSON.stringify({event:'quality-windows-path-compatibility',asyncShort:short(asyncPath),syncShort:short(syncPath),equal:asyncPath===syncPath,
    equalIgnoringCase:asyncPath.toLowerCase()===syncPath.toLowerCase(),sameCanonical:realpathSync(asyncPath)===syncPath,sameStatWitness:sameFileStat(fileStatWitness(await stat(file,{bigint:true})),fileStatWitness(statSync(file,{bigint:true}))),
    descriptorMatchesPath:sameFileStat(fileStatWitness(fstatSync(fd,{bigint:true})),fileStatWitness(statSync(file,{bigint:true})))}));
  }finally{closeSync(fd);}
 }
 library=new MediaLibraryIndex([media],{database:join(dir,'library.sqlite'),watch:false});await library.refresh();
 server=createMediaServer({library,roots:[media],onLog(){}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,cookie=`voidplayer-user=guest-${randomUUID()}`;
 const entries=(await fetch(base+'/api/library').then(r=>r.json())).entries;
 const bindings:LibraryPairBinding[]=[],targets:PairTarget[]=[];
 for(const [i,name] of ['reference.flv','distorted.flv'].entries()){
  const entry=entries.find((entry:any)=>entry.name===name);assert.ok(entry?.version);
  const absent=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});assert.equal(absent.status,409);assert.equal((await absent.json()).code,'cache-miss');
  const built=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`);assert.equal(built.status,200);const cached=await built.json();assert.equal(cached.index.packets.length,2);
  const bindingResponse=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});assert.equal(bindingResponse.status,200);const binding=await bindingResponse.json() as LibraryPairBinding;bindings.push(binding);
  assert.equal(binding.producer.producer,'server-flv-scan-v1');assert.equal(binding.producer.epoch,cached.epoch);assert.match(binding.producer.packetCommitId,/^[a-f0-9-]{36}$/);assert.match(binding.producer.documentSha256,/^[a-f0-9]{64}$/);
  const candidates=await fetch(`${base}/api/media/${entry.id}/psnr-frames?v=${entry.version}&limit=1`,{headers:{cookie}});
  assert.equal(candidates.status,200,await candidates.clone().text());const page=await candidates.json();
  assert.deepEqual(page.source,binding);assert.equal(page.entries[0].sourcePtsUs,cached.index.packets[0][2]);assert.equal(page.entries[0].picture.au,0);
  assert.equal(page.nextAu,1);assert.equal(page.geometry.width,32);assert.equal(page.inspection.supported,true);assert.match(page.eligibility,/candidate-execution-verifies/);
  const second=await fetch(`${base}/api/media/${entry.id}/psnr-frames?v=${entry.version}&afterAu=1&limit=1&buildId=${binding.binding.indexBuildId}`,{headers:{cookie}});
  assert.equal(second.status,200);assert.equal((await second.json()).entries[0].picture.au,1);
  for(const query of ['afterAu=1','limit=51','limit=','afterAu=1&buildId=rebuilt','build=1']){
   const rejected=await fetch(`${base}/api/media/${entry.id}/psnr-frames?v=${entry.version}&${query}`,{headers:{cookie}});assert.ok(rejected.status>=400);assert.equal((await rejected.json()).entries,undefined);
  }
  targets.push({...binding.binding,picture:{sourceVersion:`${entry.id}@${entry.version}`,stream:'video',configuration:0,au:i,picture:0,layer:0,field:'frame'},sourcePtsUs:cached.index.packets[i][2]});
 }
 const request=pairRequest(targets[0],targets[1]),headers={'content-type':'application/json',origin:base,'x-voidplayer-action':'quality',cookie};
 const post=async(body:unknown,extra:Record<string,string>={})=>fetch(base+'/api/quality/psnr-pair',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
 const mismatch=await post(request,{'x-voidplayer-actor':`guest-${randomUUID()}`});assert.equal(mismatch.status,409);assert.equal((await mismatch.json()).code,'actor-changed');
 const mismatchedSource=await fetch(`${base}/api/media/${targets[0].mediaId}/psnr-frames?v=${targets[0].mediaVersion}`,{headers:{cookie,'x-voidplayer-actor':`guest-${randomUUID()}`}});assert.equal(mismatchedSource.status,409);assert.equal((await mismatchedSource.json()).code,'actor-changed');
 const response=await post(request);const actual=await response.json() as LibraryPairResponse;assert.equal(response.status,200,JSON.stringify(actual));
 assert.equal(actual.request.id,response.headers.get('x-request-id'));assert.equal(actual.request.actorId,cookie.slice('voidplayer-user='.length));
 const frameBytes=1536*(depth===8?1:2),expected=measurePsnr({domain:'source-yuv-code-values',reference:nativeFrame(Uint8Array.from(fixture.native.subarray(0,frameBytes)),depth),distorted:nativeFrame(Uint8Array.from(fixture.native.subarray(frameBytes)),depth),roi:request.roi});
 assert.deepEqual(actual.result.metric,expected);assert.ok(expected.aggregate.sse>0);assert.deepEqual(actual.sources,{reference:bindings[0],distorted:bindings[1]});
 assert.equal(actual.execution.host,'node-worker');assert.equal(actual.execution.runtime,process.versions.bun?'bun':'node');assert.equal(actual.execution.sourceIdentity,'stat-version-v1');assert.match(actual.result.decoder.buildId,/^[a-f0-9]{40}$/);
 assert.equal(actual.result.provenance.reference.picture.au,0);assert.equal(actual.result.provenance.distorted.picture.au,1);assert.equal(actual.result.work.outputFrames,2);
 assert.equal(actual.result.correspondence,'caller-specified-no-content-or-time-alignment');
 const zero=await post(pairRequest(targets[0]));assert.equal(zero.status,200);assert.deepEqual((await zero.json()).result.metric.aggregate.psnr,{kind:'positive-infinity',db:null});
 const invalids=[
  [{...request,reference:{...targets[0],picture:{...targets[0].picture,au:1}}},'identity-mismatch'],
  [{...request,reference:{...targets[0],indexBuildId:'wrong'}},'identity-mismatch'],
  [{...request,reference:{...targets[0],indexIdentity:{...targets[0].indexIdentity,indexerBuild:'wrong'}}},'invalid-request'],
  [{...request,budget:{maxReadBytes:1}},'budget-exceeded'],
  [{...pairRequest(targets[0]),budget:{maxIndexPackets:1}},'budget-exceeded'],
  [{...request,budget:{maxIndexBytes:1}},'budget-exceeded'],
  [{...request,budget:{maxFrameBytes:1}},'budget-exceeded'],
  [{...request,budget:{maxHeapBytes:1}},'budget-exceeded'],
  [{...request,roi:{...request.roi,x:1}},'unsupported-format'],
  [{...request,filePath:join(media,'reference.flv')},'invalid-request'],
 ] as const;
 for(const [body,code] of invalids){const r=await post(body);assert.notEqual(r.status,200);const failure=await r.json();assert.equal(failure.code,code,JSON.stringify(failure));assert.equal(failure.result,undefined);}
 assert.equal((await post(request,{origin:'http://foreign.invalid'})).status,403);
 assert.equal((await post(request,{cookie:''})).status,401);
 if(codec==='h264'){
  const targetFor=async(name:string,au=0)=>{
   const entry=entries.find((entry:any)=>entry.name===name);
   const r=await fetch(`${base}/api/media/${entry.id}/frame-index?v=${entry.version}&build=1`);assert.equal(r.status,200);const doc=await r.json();
   const b=await fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie}});assert.equal(b.status,200);const bound=await b.json();
   return {...bound.binding,picture:{...targets[0].picture,sourceVersion:`${entry.id}@${entry.version}`,au},sourcePtsUs:doc.index.packets[au][2]} as PairTarget;
  };
  const repeated=await targetFor('repeated.flv'),repeatedOther=await targetFor('repeated.flv',1);
  const matching=await post(pairRequest(repeated,repeatedOther));assert.equal(matching.status,200);assert.deepEqual((await matching.json()).result.metric,expected,'real HTTP accepts identical repeated source parameter sets');
  for(const [name,code] of [['changed-parameter.flv','unsupported-source'],['missing-color.flv','missing-color'],['duplicate-pts.flv','identity-mismatch']]){
   const target=await targetFor(name),r=await post(pairRequest(target));assert.notEqual(r.status,200);const error=await r.json();assert.equal(error.code,code,JSON.stringify(error));assert.equal(error.result,undefined);
  }
  const client=entries.find((entry:any)=>entry.name==='client.flv');
  const uploaded=await fetch(`${base}/api/media/${client.id}/frame-index?v=${client.version}`,{method:'POST',headers:{...headers,'x-voidplayer-action':'frame-index'},
   body:JSON.stringify({epoch:bindings[0].producer.epoch,index:{...(await fetch(`${base}/api/media/${targets[0].mediaId}/frame-index?v=${targets[0].mediaVersion}`).then(r=>r.json())).index,flvProducer:bindings[0].producer}})});
  assert.equal(uploaded.status,201);
  const clientTarget={...targets[0],mediaId:client.id,mediaVersion:client.version,picture:{...targets[0].picture,sourceVersion:`${client.id}@${client.version}`}};
  const untrusted=await post(pairRequest(clientTarget));assert.equal(untrusted.status,409);assert.equal((await untrusted.json()).code,'untrusted-cache');
  await fetch(`${base}/api/media/${client.id}/frame-index?v=${client.version}&build=1`);
  const stillUntrusted=await fetch(`${base}/api/media/${client.id}/psnr-source?v=${client.version}`,{headers:{cookie}});assert.equal((await stillUntrusted.json()).code,'untrusted-cache','a cached client upload must never be blessed by a no-op server build');
  const uncached=entries.find((entry:any)=>entry.name==='uncached.flv');
  const missingTarget={...targets[0],mediaId:uncached.id,mediaVersion:uncached.version,picture:{...targets[0].picture,sourceVersion:`${uncached.id}@${uncached.version}`}};
  const missing=await post(pairRequest(missingTarget));assert.equal(missing.status,409);assert.equal((await missing.json()).code,'cache-miss');
  const untouched=await fetch(`${base}/api/media/${uncached.id}/frame-index?v=${uncached.version}`).then(r=>r.json());assert.equal(untouched.index,null,'quality does not silently build missing indexes');
  for(const mode of ['disconnect','deadline'] as const){
   let releaseStop!:()=>void,stopping!:()=>void,exited=false,first=true;
   const stopGate=new Promise<void>(resolve=>releaseStop=resolve),stopRequested=new Promise<void>(resolve=>stopping=resolve),ready=new Int32Array(new SharedArrayBuffer(4));
   let exitPromise:Promise<void>=Promise.resolve();
   const runner=new LibraryPairRunner(library,resolve('public/vendor/voidplayer-core'),data=>{
    if(!first)return new Worker(new URL('../../server/analysis/quality/worker.ts',import.meta.url),{workerData:data});first=false;
    const worker=new Worker(new URL('../helpers/quality-stall-worker.ts',import.meta.url),{workerData:{ready:ready.buffer}}),terminate=worker.terminate.bind(worker);
    exitPromise=new Promise<void>(resolve=>worker.once('exit',()=>{exited=true;resolve();}));
    worker.terminate=async()=>{stopping();await stopGate;return terminate();};return worker;
   });
   Object.defineProperty(library,'quality',{value:runner,configurable:true});
   const controller=new AbortController(),body=mode==='deadline'?{...request,budget:{maxElapsedMs:250}}:request;
   const pending=fetch(base+'/api/quality/psnr-pair',{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});
   const result=mode==='disconnect'?assert.rejects(pending,{name:'AbortError'}):pending.then(async response=>{assert.equal(response.status,413);assert.equal((await response.json()).code,'budget-exceeded');});
   void result.catch(()=>{});
   try{
   // Readiness is a shared-memory event, not a success reply consumed by the runner.
   if(Atomics.load(ready,0)===0)await (Atomics as typeof Atomics & {waitAsync(array:Int32Array,index:number,value:number,timeout:number):{value:Promise<string>|string}}).waitAsync(ready,0,0,5000).value;assert.equal(Atomics.load(ready,0),1);
   if(mode==='disconnect')controller.abort();await stopRequested;
   assert.equal(exited,false,'the uncooperative Worker is physically alive while terminate is held');
   const busy=await post(request);assert.equal(busy.status,503);assert.equal((await busy.json()).code,'quality-busy');
   const buildBlocked=await fetch(`${base}/api/media/${uncached.id}/frame-index?v=${uncached.version}&build=1`);assert.equal(buildBlocked.status,503);assert.equal((await buildBlocked.json()).code,'quality-busy');
   const uploadBlocked=await fetch(`${base}/api/media/${client.id}/frame-index?v=${client.version}`,{method:'POST',headers:{...headers,'x-voidplayer-action':'frame-index'},body:'{}'});assert.equal(uploadBlocked.status,503);assert.equal((await uploadBlocked.json()).code,'quality-busy');
   const analysisBlocked=await fetch(`${base}/api/media/${targets[0].mediaId}/bitstream-analysis/requests?v=${targets[0].mediaVersion}`,{method:'POST',headers:{...headers,'x-voidplayer-action':'bitstream-analysis'},body:JSON.stringify({version:targets[0].mediaVersion,target:{sourceVersion:targets[0].picture.sourceVersion,sourcePtsUs:targets[0].sourcePtsUs,normalizedMediaUs:0}})});
   assert.equal(analysisBlocked.status,429);assert.equal((await analysisBlocked.json()).reason.code,'resource-limit');
   releaseStop();await exitPromise;await result;await new Promise(resolve=>setImmediate(resolve));
   const recovered=await post(request);assert.equal(recovered.status,200);assert.deepEqual((await recovered.json()).result.metric,expected);
   }finally{releaseStop();controller.abort();await result.catch(()=>{});await runner.close();}
  }
  delete (library as unknown as Record<string,unknown>).quality;
  const descriptors=()=>process.platform!=='linux'?0:readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd).startsWith(dir+'/');}catch{return false;}}).length;
  for(const operation of ['measure','source'] as const)for(const phase of (operation==='measure'?['source','resolve','decode','publish']:['source','resolve','publish']))for(const mode of ['disconnect','deadline','close'] as const){
   const descriptorBaseline=descriptors();
   const state=new Int32Array(new SharedArrayBuffer(20));let releaseStop!:()=>void,stopping!:()=>void,worker!:Worker,deadline!:(()=>void);
   const stopGate=new Promise<void>(resolve=>releaseStop=resolve),stopRequested=new Promise<void>(resolve=>stopping=resolve);
   const clock=mode==='deadline'?{set(callback:()=>void,ms:number){assert.equal(ms,30000);deadline=callback;return {} as ReturnType<typeof setTimeout>;},clear(){}}:undefined;
   const runner=new LibraryPairRunner(library,resolve('public/vendor/voidplayer-core'),data=>{
    worker=new Worker(new URL('../helpers/quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:phase,phaseState:state.buffer}});
    const terminate=worker.terminate.bind(worker);worker.terminate=async()=>{stopping();await stopGate;return terminate();};return worker;
   },clock);
   Object.defineProperty(library,'quality',{value:runner,configurable:true});
   const controller=new AbortController(),pending=operation==='measure'?fetch(base+'/api/quality/psnr-pair',{method:'POST',headers,body:JSON.stringify(request),signal:controller.signal}):fetch(`${base}/api/media/${targets[0].mediaId}/psnr-source?v=${targets[0].mediaVersion}`,{headers:{cookie},signal:controller.signal});
   const checked=mode==='disconnect'?assert.rejects(pending,{name:'AbortError'}):pending.then(async response=>{assert.equal(response.status,mode==='deadline'?413:499);assert.equal((await response.json()).code,mode==='deadline'?'budget-exceeded':'cancelled');});void checked.catch(()=>{});
   const waitFlag=async(index:number)=>{if(Atomics.load(state,index)===0)await (Atomics as typeof Atomics & {waitAsync(array:Int32Array,index:number,value:number,timeout:number):{value:Promise<string>|string}}).waitAsync(state,index,0,5000).value;assert.equal(Atomics.load(state,index),1,`${phase}/${mode}: expected phase/cancel/recovery marker ${index}`);};
   let closing=Promise.resolve();
   try{
    await waitFlag(0);if(mode==='disconnect')controller.abort();else if(mode==='deadline')deadline();else closing=runner.close();
    await stopRequested;await waitFlag(2);
    if(mode!=='disconnect'){worker.postMessage({type:'resume'});await waitFlag(4);}
    assert.equal(Atomics.load(state,3),0,'a late source/resolve/final check must never publish success');
    assert.throws(()=>library.qualityAdmission.acquire(),{code:'quality-busy'},'late IO cannot release the still-owned stop budget');
    releaseStop();await checked;await closing;await runner.close();
    if(mode==='disconnect'){try{worker.postMessage({type:'resume'});}catch{}assert.equal(Atomics.load(state,4),0,'terminated source IO cannot resume after cancellation');}
    assert.ok(descriptors()<=descriptorBaseline,`${operation}/${phase}/${mode}: owned source/database descriptors leaked after physical exit`);
   }finally{releaseStop();controller.abort();try{worker?.postMessage({type:'resume'});}catch{}await checked.catch(()=>{});await runner.close();}
   delete (library as unknown as Record<string,unknown>).quality;
  }
  const gatedSource=await targetFor('gated-source.flv');
  for(const mutation of ['source-change','cache-clear'] as const){
   const gate=new Int32Array(new SharedArrayBuffer(8));
   const runner=new LibraryPairRunner(library,resolve('public/vendor/voidplayer-core'),data=>new Worker(new URL('../helpers/quality-gated-worker.ts',import.meta.url),{workerData:{...data,gate:gate.buffer}}));
   Object.defineProperty(library,'quality',{value:runner,configurable:true});
   const target=mutation==='source-change'?gatedSource:targets[0],pending=post(pairRequest(target));
   try{
    if(Atomics.load(gate,0)===0)await (Atomics as typeof Atomics & {waitAsync(array:Int32Array,index:number,value:number,timeout:number):{value:Promise<string>|string}}).waitAsync(gate,0,0,5000).value;
    assert.equal(Atomics.load(gate,0),1,'actual quality Worker reached its execution barrier');
    if(mutation==='source-change'){const changed=Buffer.from(fixture.bytes);changed[changed.length-5]^=1;await writeFile(join(media,'gated-source.flv'),changed);}
    else library.frameIndexes.remove();
    Atomics.store(gate,1,1);Atomics.notify(gate,1);
    const response=await pending;assert.equal(response.status,409);const error=await response.json();assert.equal(error.code,mutation==='source-change'?'source-changed':'cache-miss');assert.equal(error.result,undefined);
   }finally{Atomics.store(gate,1,1);Atomics.notify(gate,1);await runner.close();await pending.catch(()=>{});}
   delete (library as unknown as Record<string,unknown>).quality;
  }
 }
 const changed=Buffer.from(fixture.bytes);changed[changed.length-5]^=1;await writeFile(join(media,'reference.flv'),changed);
 const stale=await post(request);assert.equal(stale.status,409);assert.equal((await stale.json()).code,'source-changed');
 t.diagnostic(JSON.stringify({codec,depth,sse:actual.result.metric.aggregate.sse,decoder:actual.result.decoder,host:actual.execution}));
});
