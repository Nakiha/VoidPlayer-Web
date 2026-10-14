import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {MediaLibraryIndex} from '../../server/library.ts';
import {createMediaServer} from '../../server/app.ts';
import {JS_TS_MEDIA_INDEX_IDENTITY,JS_MATROSKA_MEDIA_INDEX_IDENTITY} from '../../src/media-index-identity.ts';
import {MediaIndexClient} from '../../src/media-index-client.ts';
import {WorkerRpc} from '../../src/worker-rpc.ts';
import type {PacketCommands} from '../../src/worker-protocol.ts';

test('JS library indexes persist across server and consumer Worker restarts; corrupt complete documents rebuild without WASM demux',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'vp-js-container-store-')),root=resolve('fixtures/js-container'),database=join(temp,'library.sqlite');
 const originalCore=process.env.VOIDPLAYER_WASM_CORE_DIR;let library:MediaLibraryIndex|undefined,server:ReturnType<typeof createMediaServer>|undefined;
 let builds=0;
 const start=async()=>{
  process.env.VOIDPLAYER_WASM_CORE_DIR=join(temp,'no-core');
  try{library=new MediaLibraryIndex([root],{database,watch:false});}finally{if(originalCore===undefined)delete process.env.VOIDPLAYER_WASM_CORE_DIR;else process.env.VOIDPLAYER_WASM_CORE_DIR=originalCore;}
  await library.refresh();const build=library.indexJobs.startBuild.bind(library.indexJobs);library.indexJobs.startBuild=(...args)=>{builds++;return build(...args);};
  server=createMediaServer({roots:[root],library,onLog(){}});await new Promise<void>((ok,bad)=>{server!.once('error',bad);server!.listen(0,'127.0.0.1',ok);});
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
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
  const worker=new Worker(new URL('../../src/packet-worker.ts',import.meta.url)),rpc=new WorkerRpc<PacketCommands>(worker as unknown as globalThis.Worker);
  try{
   const input={url:`${base}/api/media/${e.id}?v=${e.version}`,size:e.size},prepared=await rpc.call('prepare-js',{input,sourceVersion:version,format:'matroska',persistent:true});
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
 }finally{await stop();await rm(temp,{recursive:true,force:true});}
});
