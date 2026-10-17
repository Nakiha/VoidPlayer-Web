import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {MediaLibraryIndex} from '../../server/library.ts';
import {createMediaServer} from '../../server/app.ts';
import {JS_TS_MEDIA_INDEX_IDENTITY,JS_MATROSKA_MEDIA_INDEX_IDENTITY} from '../../shared/media/indexing/media-index-identity.ts';
import {MediaIndexClient} from '../../src/media-index-client.ts';
import {WorkerRpc} from '../../src/worker-rpc.ts';
import type {PacketCommands} from '../../src/worker-protocol.ts';
import {loadServerJsIndex} from '../../src/js-packet-index-client.ts';
import {TsCombinationNotMigrated} from '../../shared/media/containers/ts-packet-source.ts';
import {MatroskaPacketSource} from '../../shared/media/containers/matroska-packet-source.ts';
import {RangeReader} from '../../shared/media/io/range-reader.ts';
import {JsContainerEngine} from '../../src/js-container-engine.ts';
import {ownLibraryIndexReference} from '../../src/library-index-reference.ts';

test('an unregistered HTTP service with a library-shaped URL cannot authorize dropped and renumbered AU records',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'vp-unregistered-index-')),file=join(temp,'twelve.webm'),id='a'.repeat(24),version='b'.repeat(24),sourceVersion=`${id}@${version}`;
 let server:ReturnType<typeof createServer>|undefined,indexRequests=0;
 try{
  execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-i','fixtures/js-container/vp9.webm','-frames:v','12','-an','-c:v','copy',file]);
  const bytes=new Uint8Array(await readFile(file)),source=new MatroskaPacketSource(new RangeReader({file:new Blob([bytes])}),sourceVersion,new AbortController().signal);
  let original;try{original=await source.open();assert.equal(original.packets.length,12);}finally{source.close();}
  const forged=structuredClone(original);forged.packets.splice(5,1);forged.packets.forEach((p,i)=>p.au=i);forged.completeness.packets=11;
  server=createServer((req,res)=>{
   if(req.url?.includes('/frame-index')){indexRequests++;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({epoch:0,index:forged}));return;}
   if(req.url?.includes('/metadata')){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id,version,size:bytes.length,state:'ready'}));return;}
   const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');if(range){const start=Number(range[1]),end=Math.min(Number(range[2]),bytes.length-1);res.writeHead(206,{'content-range':`bytes ${start}-${end}/${bytes.length}`,'content-length':end-start+1}).end(bytes.subarray(start,end+1));}else res.writeHead(200,{'content-length':bytes.length}).end(bytes);
  });await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/media/${id}?v=${version}`;
  assert.equal(await loadServerJsIndex(url,sourceVersion,bytes.length,'matroska',new AbortController().signal),undefined,'pathname and arbitrary metadata do not establish library authority');
  await assert.rejects(loadServerJsIndex(url,sourceVersion,bytes.length,'matroska',new AbortController().signal,undefined,{origin:new URL(url).origin,id,version}),(error:any)=>error.stage==='input','raw reference fields cannot register an arbitrary service as the application origin');
  const engine=new JsContainerEngine({url,size:bytes.length},sourceVersion,{persistent:true},'matroska');
  try{const index=await engine.prepare();assert.equal(index.packets.length,12);assert.equal(index.packets[5].locator,original.packets[5].locator,'AU5 cannot become the original AU6');assert.equal(engine.packetIndex?.completeness.packets,12);}finally{engine.close();}
  assert.equal(indexRequests,0,'unregistered endpoint receives no authoritative index request');
 }finally{server?.closeAllConnections();if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));await rm(temp,{recursive:true,force:true});}
});

test('JS library indexes persist across server and consumer Worker restarts; corrupt complete documents rebuild without WASM demux',async t=>{
 const previousLocation=Object.getOwnPropertyDescriptor(globalThis,'location');t.after(()=>{if(previousLocation)Object.defineProperty(globalThis,'location',previousLocation);else Reflect.deleteProperty(globalThis,'location');});
 const temp=await mkdtemp(join(tmpdir(),'vp-js-container-store-')),root=join(temp,'media'),database=join(temp,'library.sqlite');const {mkdir,copyFile,readdir}=await import('node:fs/promises');await mkdir(root);for(const name of await readdir('fixtures/js-container'))if(name.endsWith('.ts')||name.endsWith('.mkv')||name.endsWith('.webm'))await copyFile(join('fixtures/js-container',name),join(root,name));execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=5:duration=1','-c:v','huffyuv','-pix_fmt','yuv422p',join(root,'uncompiled-huffyuv.mkv')]);
 const originalCore=process.env.VOIDPLAYER_WASM_CORE_DIR;let library:MediaLibraryIndex|undefined,server:ReturnType<typeof createMediaServer>|undefined;
 let builds=0;
 const start=async()=>{
  process.env.VOIDPLAYER_WASM_CORE_DIR=join(temp,'no-core');
  try{library=new MediaLibraryIndex([root],{database,watch:false});}finally{if(originalCore===undefined)delete process.env.VOIDPLAYER_WASM_CORE_DIR;else process.env.VOIDPLAYER_WASM_CORE_DIR=originalCore;}
  await library.refresh();const build=library.indexJobs.startBuild.bind(library.indexJobs);library.indexJobs.startBuild=(...args)=>{builds++;return build(...args);};
  server=createMediaServer({roots:[root],library,onLog(){}});await new Promise<void>((ok,bad)=>{server!.once('error',bad);server!.listen(0,'127.0.0.1',ok);});
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:base,href:base+'/'}});return base;
 };
 const stop=async()=>{server?.closeAllConnections();if(server?.listening)await new Promise<void>((ok,bad)=>server!.close(e=>e?bad(e):ok()));server=undefined;await library?.close();library=undefined;};
 try{
  let base=await start();const documents=new Map<string,unknown>();
  const names=['h264.ts','hevc.ts','h264.mkv','hevc.mkv','hevc10.ts','hevc10.mkv','hevc-audio.mkv','vp8.webm','vp9.webm'];
  const read=async(name:string)=>{const e=library!.browse().entries.find(e=>e.name===name)!;assert.ok(e);const identity=name.endsWith('.ts')?JS_TS_MEDIA_INDEX_IDENTITY:JS_MATROSKA_MEDIA_INDEX_IDENTITY;
   const client=new MediaIndexClient(`${base}/api/media/${e.id}?v=${e.version}`,identity.kind,64*1024*1024,120000,true,identity);try{const d=await client.read();assert.ok(d);return d;}finally{client.close();}};
  for(const name of names)documents.set(name,await read(name));assert.equal(builds,names.length);
  await stop();builds=0;base=await start();for(const name of names)assert.deepEqual(await read(name),documents.get(name));assert.equal(builds,0,'server restart uses stored source/build-bound complete indexes');
  const e=library!.browse().entries.find(e=>e.name==='hevc.mkv')!,version=`${e.id}@${e.version}`;
  // Node has no document origin. This fixture explicitly hosts the real
  // library application at base, including its fresh consumer Worker's origin.
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(`globalThis.location={origin:${JSON.stringify(base)},href:${JSON.stringify(base+'/')}};await import(${JSON.stringify(new URL('../../src/packet-worker.ts',import.meta.url).href)});`))),rpc=new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
  try{
   const input={url:`${base}/api/media/${e.id}?v=${e.version}`,size:e.size,library:ownLibraryIndexReference(e.id,e.version!)},prepared=await rpc.call('prepare-js',{input,sourceVersion:version,format:'matroska',persistent:true});
   if(!prepared.admitted)assert.fail(prepared.reason);
   const opened=await rpc.call('init',{input,container:'matroska',sourceVersion:version,preparedTsSession:prepared.session,forceWasm:true,wasmBinary:new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')),glueURL:pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href});
   assert.equal(opened.jsIndexReused,true);assert.equal(opened.jsIndexPacketsScanned,0,'fresh consumer Worker does not re-enumerate 600 access units');assert.equal(opened.times.length,600);assert.equal(builds,0);
   const frame=await rpc.call('extract',{position:560});assert.equal(frame?.packetPicture?.au,[...prepared.index.packets].sort((a,b)=>a.ptsUs-b.ptsUs)[560].au);frame?.frame?.close();
  }finally{rpc.terminate();}
  const damaged=structuredClone(documents.get('hevc.mkv')) as any;damaged.packets.splice(2,1);damaged.packets.forEach((p:any,i:number)=>p.au=i);damaged.completeness.packets=damaged.packets.length;
  const db=Reflect.get(library!.frameIndexes,'db');db.prepare("UPDATE media_index_batches SET payload=? WHERE media_id=? AND kind='js-matroska'").run(JSON.stringify(damaged),e.id);
  assert.equal(library!.frameIndexes.has(e.id,e.version!,'js-matroska',JS_MATROSKA_MEDIA_INDEX_IDENTITY),false,'self-consistent missing/renumbered records cannot replace stored scan authority');
  assert.deepEqual(await read('hevc.mkv'),documents.get('hevc.mkv'));assert.equal(builds,1,'one JS rebuild restores actual complete file coverage');
  const response=await fetch(`${base}/api/media/${e.id}/frame-index?v=${e.version}&kind=js-matroska&stream=video:0&schema=1&indexer=${JS_MATROSKA_MEDIA_INDEX_IDENTITY.indexerBuild}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epoch:await library!.indexJobs.call('epoch'),index:damaged})});
  assert.equal(response.status,405,'clients cannot upload their own completeness authority');
  const outside=library!.browse().entries.find(e=>e.name==='uncompiled-huffyuv.mkv')!;
  await assert.rejects(loadServerJsIndex(`${base}/api/media/${outside.id}?v=${outside.version}`,`${outside.id}@${outside.version}`,outside.size,'matroska',new AbortController().signal,undefined,ownLibraryIndexReference(outside.id,outside.version!)),TsCombinationNotMigrated,'explicit codec admission result survives Worker/RPC/NDJSON; raw IO or corruption errors cannot select this route');
 }finally{await stop();await rm(temp,{recursive:true,force:true});}
});
