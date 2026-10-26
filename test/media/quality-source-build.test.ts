import {prepareFrameIndex} from '../../server/frame-index-store.ts';
import {FLV_MEDIA_INDEX_IDENTITY} from '../../shared/media/indexing/media-index-identity.ts';
import {bindNativePresentedFrame} from '../../shared/review/native-presented-binding.ts';
import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,rm,stat,open} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {Worker} from 'node:worker_threads';
import {MediaLibraryIndex,fileVersion} from '../../server/library.ts';import {createMediaServer} from '../../server/app.ts';import {LibraryPairRunner} from '../../server/analysis/quality/runner.ts';import {QUALITY_SOURCE_BUILD_LIMITS} from '../../shared/analysis/quality/source-build.ts';import {buildFlvIndexDocument} from '../../server/flv-index-builder.ts';
import type {AddressInfo} from 'node:net';
const sample=JSON.parse(await readFile(new URL('../helpers/quality-http-samples.json',import.meta.url),'utf8')).samples.find((s:any)=>s.codec==='h264'&&s.depth===8&&s.tagged);
async function setup(t:any){const dir=await mkdtemp(path.join(tmpdir(),'vp-quality-build-')),media=path.join(dir,'media');await mkdir(media);const file=path.join(media,'input.flv');await writeFile(file,Buffer.from(sample.flv,'base64'));let library:MediaLibraryIndex|undefined,server:ReturnType<typeof createMediaServer>|undefined;const cleanup:(()=>Promise<unknown>)[]=[];
 t.after(async()=>{for(const close of cleanup)await close();if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await library?.close();await rm(dir,{recursive:true,force:true});});
 library=new MediaLibraryIndex([media],{database:path.join(dir,'library.sqlite'),watch:false});await library.refresh();const entry=library.browse({recursive:true}).entries.find(e=>e.name==='input.flv')!;assert.ok(entry?.version);
 server=createMediaServer({library,roots:[media],onLog(){}});await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,actor=`guest-${randomUUID()}`,cookie=`voidplayer-user=${actor}`;
 const source=()=>fetch(`${base}/api/media/${entry.id}/psnr-source?v=${entry.version}`,{headers:{cookie,'x-voidplayer-actor':actor}}),build=(extra:Record<string,string>={},body:unknown={version:entry.version})=>fetch(`${base}/api/media/${entry.id}/psnr-index`,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-voidplayer-action':'quality-source-build','x-voidplayer-actor':actor,...extra},body:JSON.stringify(body)});
 return {dir,media,file,library,server,entry,base,actor,cookie,source,build,cleanup};}
test('explicit HTTP source build is actor fenced, read-only discovery never builds, and creates only server producer evidence',async t=>{const f=await setup(t);const absent=await f.source();assert.equal(absent.status,409);assert.equal((await absent.json()).code,'cache-miss');
 assert.equal((await fetch(`${f.base}/api/media/${f.entry.id}/psnr-index`,{headers:{cookie:f.cookie}})).status,405);
 assert.equal((await f.build({'x-voidplayer-actor':`guest-${randomUUID()}`})).status,409);assert.equal((await f.source()).status,409);
 assert.equal((await f.build({origin:'https://foreign.invalid'})).status,403);assert.equal((await f.build({}, {version:f.entry.version,budget:{maxSourceBytes:2**40}})).status,400);assert.equal((await f.source()).status,409);
 const built=await f.build();assert.equal(built.status,200,await built.clone().text());const value=await built.json();assert.equal(value.producer.producer,'server-flv-scan-v1');assert.equal(value.producer.sourceVersion,`${f.entry.id}@${f.entry.version}`);assert.match(value.producer.documentSha256,/^[a-f0-9]{64}$/);assert.deepEqual(await(await f.source()).json(),value);
 const again=await f.build();assert.equal(again.status,200);assert.deepEqual(await again.json(),value,'ready cache is read, never rebuilt');
 const page=await fetch(`${f.base}/api/media/${f.entry.id}/psnr-frames?v=${f.entry.version}&limit=1`,{headers:{cookie:f.cookie}});assert.equal(page.status,200);const candidates=await page.json();assert.equal(candidates.presentedInput.protocol,'webcodecs-associated-chunk-v1');
 const g=candidates.geometry,w=candidates.presentedInput.packets[0],capture:any={schema:'voidplayer-native-presented-input',version:1,binding:'unbound',slot:'A',instance:'actual-open-instance',commit:1,sourceGeneration:1,
  source:{kind:'library',id:f.entry.id,url:`${f.base}/api/media/${f.entry.id}?v=${f.entry.version}`},sourceVersion:`${f.entry.id}@${f.entry.version}`,
  input:{protocol:'webcodecs-associated-chunk-v1',epoch:1,configurationHex:candidates.presentedInput.configurationHex,...w},
  geometry:{codedWidth:g.codedWidth,codedHeight:g.codedHeight,visibleRect:{x:0,y:0,width:g.width,height:g.height},displayWidth:g.width,displayHeight:g.height,rotation:0}};
 assert.deepEqual(bindNativePresentedFrame(capture,candidates,f.base),candidates.entries[0]);
 const padded=structuredClone(capture);padded.geometry.codedHeight+=2;assert.deepEqual(bindNativePresentedFrame(padded,candidates,f.base),candidates.entries[0]);
 for(const mutate of [(x:any)=>x.input.au++,(x:any)=>x.input.configuration++,(x:any)=>x.input.pts++,(x:any)=>x.input.dts++,(x:any)=>x.input.offset++,(x:any)=>x.input.size++,(x:any)=>x.input.configurationHex='00',
  (x:any)=>x.source.id='c'.repeat(24),(x:any)=>x.sourceVersion+='x',(x:any)=>x.source.url=x.source.url.replace(f.base,'http://foreign.invalid'),(x:any)=>x.source.url=x.source.url.replace(f.entry.id,'c'.repeat(24)),
  (x:any)=>x.geometry.rotation=90,(x:any)=>x.geometry.visibleRect.x=2,(x:any)=>x.geometry.displayWidth++]){const bad=structuredClone(capture);mutate(bad);assert.throws(()=>bindNativePresentedFrame(bad,candidates,f.base));}
 for(const mutate of [(x:any)=>x.source.binding.indexBuildId='changed',(x:any)=>x.source.binding.indexIdentity.indexerBuild='changed',(x:any)=>x.geometry.sarNum=1000,(x:any)=>x.geometry.sarSpecified=false]){const bad=structuredClone(candidates);mutate(bad);assert.throws(()=>bindNativePresentedFrame(capture,bad,f.base));}
 const file=path.join(f.media,'too-large.flv'),handle=await open(file,'w');try{await handle.truncate(QUALITY_SOURCE_BUILD_LIMITS.maxSourceBytes+1);}finally{await handle.close();}await f.library.refresh();const large=f.library.browse({recursive:true}).entries.find(e=>e.name==='too-large.flv')!;
 const rejected=await fetch(`${f.base}/api/media/${large.id}/psnr-index`,{method:'POST',headers:{cookie:f.cookie,origin:f.base,'content-type':'application/json','x-voidplayer-action':'quality-source-build','x-voidplayer-actor':f.actor},body:JSON.stringify({version:large.version})});assert.equal(rejected.status,413);assert.equal((await rejected.json()).code,'budget-exceeded');
});
test('explicit build enforces real scan/read/serialized-index limits and closes its descriptor on rejection',async t=>{const f=await setup(t),size=(await stat(f.file)).size,version=fileVersion(await stat(f.file));
 for(const limits of [{maxReadBytes:1,maxPackets:10,maxIndexBytes:100000},{maxReadBytes:100000,maxPackets:1,maxIndexBytes:100000},{maxReadBytes:100000,maxPackets:10,maxIndexBytes:1}])await assert.rejects(buildFlvIndexDocument(f.file,size,version,undefined,limits),e=>(e as any).code==='budget-exceeded');
 // Windows removal is also an actual descriptor-cleanup assertion.
 await rm(f.file);assert.equal((await f.source()).status,409);
});
test('source-build cancellation holds admission until the real open file and Worker close; no late publication',async t=>{const f=await setup(t),state=new Int32Array(new SharedArrayBuffer(20));let worker:Worker|undefined,exited=false;
 const runner=new LibraryPairRunner(f.library,path.resolve('public/vendor/voidplayer-core'),data=>{worker=new Worker(new URL('../helpers/quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:'resolve',hangOccurrence:2,phaseState:state.buffer}});worker.once('exit',()=>exited=true);return worker;});f.cleanup.push(async()=>{const closing=runner.close();worker?.postMessage({type:'resume'});await closing;});
 const controller=new AbortController();let settled=false;const operation=runner.buildSource(f.entry.id,f.entry.version!,controller.signal);void operation.then(()=>settled=true,()=>settled=true);
 const wait=async(index:number)=>{const deadline=Date.now()+10000;while(!Atomics.load(state,index)){if(Date.now()>deadline)throw Error('Actual source-build stage did not arrive');await new Promise(r=>setTimeout(r,5));}};
 await wait(0);controller.abort(0);await wait(2);assert.equal(settled,false);assert.equal(exited,false);assert.throws(()=>f.library.qualityAdmission.acquire());
 worker!.postMessage({type:'resume'});await assert.rejects(operation,e=>e===0);assert.equal(exited,true);assert.equal((await f.source()).status,409,'cancelled scan never minted producer evidence');
 worker!.postMessage({type:'resume'});const built=await f.build();assert.equal(built.status,200,await built.clone().text());assert.equal((await f.source()).status,200);
});

test('explicit build deadline and service close cover preflight and final publication with actual Worker exit',async t=>{
 for(const phase of ['source','publish'] as const)for(const reason of ['deadline','close'] as const){const f=await setup(t),state=new Int32Array(new SharedArrayBuffer(20));let trigger:(()=>void)|undefined,exited=false;
  const runner=new LibraryPairRunner(f.library,path.resolve('public/vendor/voidplayer-core'),data=>{const worker=new Worker(new URL('../helpers/quality-phase-worker.ts',import.meta.url),{workerData:{...data,hangPhase:phase,phaseState:state.buffer}});worker.once('exit',()=>exited=true);return worker;},{set(callback,ms){assert.equal(ms,30000);trigger=callback;return 1 as unknown as ReturnType<typeof setTimeout>;},clear(){}});f.cleanup.push(()=>runner.close());
  const operation=runner.buildSource(f.entry.id,f.entry.version!,new AbortController().signal);const handled=operation.then(()=>({ok:true,error:undefined}),error=>({ok:false,error}));
  const end=Date.now()+10000;while(!Atomics.load(state,0)){if(Date.now()>end)throw Error('Bounded build stage not reached');await new Promise(r=>setTimeout(r,5));}
  assert.throws(()=>f.library.qualityAdmission.acquire());if(reason==='deadline')trigger!();else await runner.close();const result=await handled;assert.equal(result.ok,false);assert.equal(result.error.code,reason==='deadline'?'budget-exceeded':'cancelled');assert.equal(exited,true);assert.equal((await f.source()).status,409);const release=f.library.qualityAdmission.acquire();release();
 }
});

test('explicit preparation cannot bless a client cache or reuse a changed source version',async t=>{
 const f=await setup(t),size=(await stat(f.file)).size,result=await buildFlvIndexDocument(f.file,size,f.entry.version!);
 f.library.frameIndexes.commit(f.entry.id,f.entry.version!,prepareFrameIndex(result.document,size,FLV_MEDIA_INDEX_IDENTITY,`${f.entry.id}@${f.entry.version}`),f.library.frameIndexes.epoch);
 const untrusted=await f.build();assert.equal(untrusted.status,409);assert.equal((await untrusted.json()).code,'untrusted-cache');assert.equal((await f.source()).status,409);
 f.library.frameIndexes.remove();await writeFile(f.file,Buffer.concat([Buffer.from(sample.flv,'base64'),Buffer.from([0])]));const changed=await f.build();assert.equal(changed.status,409);assert.equal((await changed.json()).code,'source-changed');assert.equal(f.library.frameIndexes.has(f.entry.id,f.entry.version!,'flv',FLV_MEDIA_INDEX_IDENTITY),false);
});
