import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {JsContainerEngine} from '../../src/media/decoding/js-container-engine.ts';
import {openJsPacketAnalysisInput} from '../../shared/analysis/bitstream/js-ts-input.ts';
import {analyzePicture} from '../../shared/analysis/bitstream/runner.ts';
import {jsPictureStream} from '../../shared/media/containers/matroska-packet-index.ts';
import {loadTsCore} from '../helpers/media/ts-analysis.ts';
import {nativeFrames,nativeVisibleHash} from '../helpers/media/native-pixels.ts';
import {visiblePixelHash} from '../helpers/visible-pixels.ts';
import type {MatroskaPacketIndex} from '../../shared/media/containers/matroska-packet-index.ts';
import {MatroskaPacketSource} from '../../shared/media/containers/matroska-packet-source.ts';
import {TsCombinationNotMigrated} from '../../shared/media/containers/ts-packet-source.ts';
import {RangeReader} from '../../shared/media/io/range-reader.ts';
import {MediaOpenError} from '../../shared/media/io/media-errors.ts';
import {wasmFlvDecoder} from '../../src/media/decoding/flv-decoder.ts';
import {IDBFactory,IDBDatabase} from 'fake-indexeddb';
import {localJsSourceVersion,saveLocalJsIndex,loadLocalJsIndex,JS_PACKET_CACHE_DATABASE} from '../../src/media/indexing/js-packet-index-cache.ts';

const names=['h264.ts','hevc.ts','h264.mkv','hevc.mkv','hevc10.ts','hevc10.mkv','hevc-audio.mkv','vp8.webm','vp9.webm'] as const;
test('real 20-picture VP9 WebM rejects a later invisible SimpleBlock during initial admission',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'vp-invisible-webm-')),file=join(directory,'twenty.webm');
 try{
  execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-i','fixtures/js-container/vp9.webm','-frames:v','20','-an','-c:v','copy',file]);
  const bytes=new Uint8Array(await readFile(file)),source=(data:Uint8Array<ArrayBuffer>)=>new MatroskaPacketSource(new RangeReader({file:new Blob([data])}),'invisible-regression',new AbortController().signal);
  const original=source(bytes);try{assert.equal((await original.open()).packets.length,20);}finally{original.close();}
  const offsets:number[]=[];
  const integer=(at:number,id=false)=>{let width=1,mask=0x80;while(!(bytes[at]&mask)){width++;mask>>=1;assert.ok(width<=8);}let value=id?bytes[at]:bytes[at]&(mask-1),unknown=!id&&(bytes[at]&(mask-1))===mask-1;for(let i=1;i<width;i++){value=value*256+bytes[at+i];unknown=unknown&&bytes[at+i]===255;}return{width,value,unknown};};
  const visit=(start:number,end:number)=>{for(let at=start;at<end;){const id=integer(at,true),size=integer(at+id.width),data=at+id.width+size.width,next=size.unknown?end:data+size.value;assert.ok(next<=end&&next>at);if(id.value===0x18538067||id.value===0x1f43b675)visit(data,next);if(id.value===0xa3)offsets.push(data+integer(data).width+2);at=next;}};
  visit(0,bytes.length);assert.equal(offsets.length,20);bytes[offsets[3]]|=8;
  const changed=source(bytes);try{await assert.rejects(changed.open(),TsCombinationNotMigrated,'AU3 Invisible must not be indexed as an ordinary visible picture');}finally{changed.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});
for(const operation of ['load','save'] as const)for(const storeName of ['indexes','keys'] as const)test(`local JS cache ${operation} cancellation releases a queued ${storeName} transaction (fake-indexeddb)`,async t=>{
 const previous=globalThis.indexedDB;globalThis.indexedDB=new IDBFactory();t.after(()=>{globalThis.indexedDB=previous;});
 const directory=await mkdtemp(join(tmpdir(),'vp-cache-abort-')),file=join(directory,'twelve.webm');t.after(()=>rm(directory,{recursive:true,force:true}));
 execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-i','fixtures/js-container/vp9.webm','-frames:v','12','-an','-c:v','copy',file]);
 const bytes=new Uint8Array(await readFile(file)),reader={size:bytes.length,async read(at:number,n:number){return bytes.subarray(at,at+n);},close(){}},version=await localJsSourceVersion(reader,new AbortController().signal);
 const source=new MatroskaPacketSource(reader,version,new AbortController().signal);let index:MatroskaPacketIndex;try{index=await source.open();assert.equal(index.packets.length,12);}finally{source.close();}
 await saveLocalJsIndex(index);
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(JS_PACKET_CACHE_DATABASE);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});t.after(()=>db.close());
 if(operation==='save')await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['indexes','entries'],'readwrite');tx.objectStore('indexes').clear();tx.objectStore('entries').clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
 const hold=db.transaction(storeName,'readwrite'),held=hold.objectStore(storeName);let holding=true,started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 const pump=()=>{if(!holding)return;const req=held.get('held');req.onsuccess=()=>{started();pump();};};pump();await ready;
 const original=IDBDatabase.prototype.transaction;let queued!:()=>void;const queuedPromise=new Promise<void>(resolve=>queued=resolve);
 IDBDatabase.prototype.transaction=function(...args:Parameters<typeof original>){const tx=original.apply(this,args);if(args[0]===storeName||Array.isArray(args[0])&&args[0].includes(storeName))queued();return tx;};
 const controller=new AbortController();let pending:Promise<unknown>|undefined;
 try{
  pending=operation==='load'?loadLocalJsIndex(reader,version,'matroska',controller.signal,true):saveLocalJsIndex(index,controller.signal);
  await Promise.race([queuedPromise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Cache operation did not enqueue')),1000))]);controller.abort();
  const outcome=await Promise.race([pending.then(()=> 'resolved',error=>error?.name),new Promise(resolve=>setTimeout(()=>resolve('still-pending'),100))]);
  assert.equal(outcome,'AbortError','cancellation must settle before the held transaction is released');
 }finally{IDBDatabase.prototype.transaction=original;holding=false;hold.abort();await pending?.catch(()=>{});}
 if(operation==='save'){const stored=await new Promise(resolve=>{const req=db.transaction('indexes').objectStore('indexes').get(`matroska:${version}`);req.onsuccess=()=>resolve(req.result);});assert.equal(stored,undefined,'cancelled queued save cannot persist a late complete-scan receipt');}
});
test('local JS cache cancellation closes a late database connection (controlled Node request)',async t=>{
 const previous=globalThis.indexedDB;let began!:()=>void;const ready=new Promise<void>(resolve=>began=resolve);let closed=0;
 const req={onsuccess:undefined as (()=>void)|undefined,onerror:undefined,onupgradeneeded:undefined,result:{close(){closed++;}}};
 globalThis.indexedDB={open(){began();return req;}} as unknown as IDBFactory;t.after(()=>{globalThis.indexedDB=previous;});
 const controller=new AbortController(),pending=loadLocalJsIndex({size:1,async read(){return Uint8Array.of(0);},close(){}},'local-js-v1:1:controlled','matroska',controller.signal,true);
 await ready;controller.abort();const outcome=await Promise.race([pending.then(()=> 'resolved',error=>error?.name),new Promise(resolve=>setTimeout(()=>resolve('still-pending'),100))]);
 req.onsuccess?.();await pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));assert.equal(outcome,'AbortError');assert.equal(closed,1,'late open result must close exactly once');
});
for(const name of names)test(`JS ${name}: real 600-picture packet decode, raw clocks, random seek, EOF and independent analysis`,async()=>{
 const bytes=new Uint8Array(await readFile(`fixtures/js-container/${name}`)),format=name.endsWith('.ts')?'ts':'matroska';
 const directory=await mkdtemp(join(tmpdir(),'vp-js-container-matrix-')),wrapper=join(directory,'packet-only.mjs');
 const glue=pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href;
 await writeFile(wrapper,`import load from ${JSON.stringify(glue)};export default async options=>{const c=await load(options);c._vp_open=c._vp_open_blob=c._vp_open_range=()=>{throw new Error('Product WASM container forbidden');};return c;};`);
 const engine=new JsContainerEngine({file:new Blob([bytes])},`matrix-${name}`,{},format);
 let input:Awaited<ReturnType<typeof openJsPacketAnalysisInput>>|undefined;
 try{
  const opened=await engine.open(pathToFileURL(wrapper).href,new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')),false);
  assert.equal(opened.decoder,'ffmpeg-wasm','Node native-unavailable fallback consumes JS packets');assert.equal(opened.times.length,600);
  const index=engine.packetIndex!;assert.equal(index.packets.length,600);assert.equal(index.completeness.state,'complete');
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','packet=pts_time','-of','json',`fixtures/js-container/${name}`],{encoding:'utf8'}));
  assert.deepEqual(index.packets.map(p=>p.ptsUs),probe.packets.map((p:any)=>Math.round(Number(p.pts_time)*1e6)),'original presentation clock and decode ordinal agree with independent ffprobe');
  if(format==='matroska')assert.ok(index.packets.every(p=>p.timing.dts===null),'Matroska has no raw DTS field; never substitute PTS');
  else assert.ok(index.packets.some(p=>p.timing.dts===null),'missing PES DTS stays unknown');
  const checks=[0,3,200,560,599,0],rank=(au:number)=>index.packets.filter(p=>p.ptsUs<index.packets[au].ptsUs).length;
  const first=await engine.at(index.packets[0].ptsUs),native=nativeFrames(`fixtures/js-container/${name}`,checks.map(rank),first.description.sourcePixelFormat!,first.pixels!.byteLength);first.frame?.close();
  for(const au of checks){
   const frame=await engine.at(index.packets[au].ptsUs);assert.equal(frame.pts,index.packets[au].ptsUs);
   assert.deepEqual(frame.packetPicture,{au,configuration:0,stream:jsPictureStream(index)});
   assert.equal(visiblePixelHash(frame.description,frame.pixels!),nativeVisibleHash(frame.description,native.get(rank(au))!),`${name} AU${au}: complete native visible planes`);frame.frame?.close();
  }
  const reader=()=>{let closed=false;return{size:bytes.length,async read(at:number,n:number){assert.equal(closed,false);return bytes.subarray(at,at+n);},close(){closed=true;},get closed(){return closed;}};};
  if(index.codec==='h264'||index.codec==='hevc'){
   let loads=0,saves=0;
   const hostCached=await openJsPacketAnalysisInput(format,{...reader(),indexCache:{async load(){loads++;return index;},async save(){saves++;}}},index.sourceVersion,new AbortController().signal);
   assert.equal(loads,1,'shared analysis delegates persistence to the explicit host cache');assert.equal(saves,0,'reusing a proven index does not rewrite host storage');assert.equal(hostCached.packets.length,600);hostCached.close();
   const failed=reader(),cacheError=new Error('host cache failed');
   await assert.rejects(openJsPacketAnalysisInput(format,{...failed,indexCache:{async load(){throw cacheError;},async save(){}}},index.sourceVersion,new AbortController().signal),error=>error===cacheError);
   assert.equal(failed.closed,true,'host cache failure closes the independent analysis reader');

   input=await openJsPacketAnalysisInput(format,reader(),index.sourceVersion,new AbortController().signal,index);
   const packet=input.packets[560],picture=input.picture(packet,index.sourceVersion),core=await loadTsCore();
   core._vpd_open=()=>{throw new Error('Analysis WASM container forbidden');};
   const result=await analyzePicture(input.reader,{sourceVersion:index.sourceVersion,sourcePtsUs:packet.pts,normalizedMediaUs:packet.pts-index.packets[0].ptsUs,picture},core,'matrix',new AbortController().signal,{input});
   assert.equal(result.confidence,'exact');assert.deepEqual(result.picture,picture);assert.equal(result.codec,index.codec);
  }else{
   const independent=reader();await assert.rejects(openJsPacketAnalysisInput(format,independent,index.sourceVersion,new AbortController().signal,index),(error:any)=>error.code==='unsupported-codec');
   assert.equal(independent.closed,true,'unsupported block/QP analysis closes its own reader; packet statistics remain available');
   assert.equal(engine.analysisIndex?.packets.length,600);
  }
  // Analysis owns its source/cursor. Neither an analysis seek nor its close may
  // alter the packet decoder's subsequent actual output.
  let frame=await engine.at(index.packets[0].ptsUs);const seen=new Set<number>();
  while(frame){assert.ok(frame.packetPicture);assert.equal(seen.has(frame.packetPicture.au),false);seen.add(frame.packetPicture.au);const pts=frame.pts;frame.frame?.close();frame=await engine.next(pts) as typeof frame;}
  assert.equal(seen.size,600,'EOF is 600 real output pictures, not index rows');
 }finally{input?.close();engine.close();await rm(directory,{recursive:true,force:true});}
});
test('native codec startup failure retains the JS packet path; input failure never becomes a decoder fallback',async()=>{
 const bytes=new Uint8Array(await readFile('fixtures/js-container/hevc.ts'));
 const glue=pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,wasm=new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm'));
 for(const stage of ['decode','input'] as const){let software=0;const engine=new JsContainerEngine({file:new Blob([bytes])},'codec-startup',{
  native:async()=>{throw new MediaOpenError(stage,'controlled startup failure');},software:async(...args)=>{software++;return wasmFlvDecoder(...args);},
 });try{if(stage==='decode'){const opened=await engine.open(glue,wasm,false);assert.equal(opened.decoder,'ffmpeg-wasm');assert.equal(software,1);assert.equal((await engine.at(engine.packetIndex!.packets[560].ptsUs)).packetPicture?.au,560);}else{await assert.rejects(engine.open(glue,wasm,false),/controlled startup/);assert.equal(software,0);}}finally{engine.close();}}
});
test('untrusted serialized Matroska completeness rebuilds from actual blocks; corruption does not select an unmigrated route',async()=>{
 const bytes=new Uint8Array(await readFile('fixtures/js-container/hevc.mkv')),source=()=>new MatroskaPacketSource(new RangeReader({file:new Blob([bytes])}),'mkv-completeness',new AbortController().signal);
 const original=source();let index:MatroskaPacketIndex;try{index=await original.open();}finally{original.close();}
 for(const tail of [false,true]){const forged:MatroskaPacketIndex=structuredClone(index);forged.packets.splice(tail?599:2,1);forged.packets.forEach((p,i)=>p.au=i);forged.completeness.packets=599;const fresh=source();try{assert.deepEqual(await fresh.open(forged),index);assert.equal(fresh.indexReused,false);assert.equal(fresh.packetsRead,600);}finally{fresh.close();}}
 const corrupted=new JsContainerEngine({file:new Blob([bytes.subarray(0,bytes.length-80)])},'truncated',{},'matroska');
 try{await assert.rejects(corrupted.prepare(),(error:unknown)=>error instanceof Error&&!(error instanceof TsCombinationNotMigrated));}finally{corrupted.close();}
 const directory=await mkdtemp(join(tmpdir(),'vp-uncompiled-codec-')),file=join(directory,'huffyuv.mkv');
 try{execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=5:duration=1','-c:v','huffyuv','-pix_fmt','yuv422p',file]);
  const unadmitted=new JsContainerEngine({file:new Blob([await readFile(file)])},'uncompiled-huffyuv',{},'matroska');
  try{await assert.rejects(unadmitted.prepare(),TsCombinationNotMigrated);}finally{unadmitted.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
});
