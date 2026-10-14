import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {JsContainerEngine} from '../../src/js-container-engine.ts';
import {visiblePixelHash} from '../helpers/visible-pixels.ts';
import {nativeFrames,nativeVisibleHash} from '../helpers/media/native-pixels.ts';

for(const [name,format,count] of [
 ['ffv1_yuv422p_8bit.mkv','matroska',60],['ffv1_yuv422p10le.mkv','matroska',60],['ffv1_yuv444p10le.mkv','matroska',60],
 ['mpeg2_10s_1280x720.ts','ts',600],['av1_10s_1920x1080.webm','matroska',600],
] as const)test(`JS ${name}: native visible pixels, all ${count} outputs, rear seek and independent cursor`,async()=>{
 const path=resolve('fixtures/video',name),bytes=await readFile(path),engine=new JsContainerEngine({file:new Blob([bytes])},name,{},format);
 try{
  const opened=await engine.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm'),true);
  assert.equal(opened.times.length,count);assert.equal(opened.decoder,'ffmpeg-wasm');assert.equal(opened.demuxBackend,format==='ts'?'js-ts-packets':'js-matroska-packets');
  const index=engine.packetIndex!,probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','packet=pts_time,flags','-of','json',path],{encoding:'utf8'}));
  assert.deepEqual(index.packets.map(p=>p.ptsUs),probe.packets.map((p:any)=>Math.round(Number(p.pts_time)*1e6)));
  if(format==='matroska')assert.ok(index.packets.every(p=>p.timing.dts===null));else assert.equal(index.packets.filter(p=>p.timing.dts===null).length,1);
  // Intra evidence is read from the encoded FFV1/MPEG-2 payload, independently
  // cross-checked against native demux/parser key flags.
  assert.deepEqual(index.packets.map(p=>p.key),probe.packets.map((p:any)=>p.flags.includes('K')));
  const positions=[0,3,count-8,count-1],first=await engine.extract(0),frameBytes=first.pixels!.byteLength;
  const expected=nativeFrames(path,positions,first.description.sourcePixelFormat!,frameBytes,format==='ts'?['-idct','simple']:[]);first.frame?.close();
  for(const position of [...positions,0]){const frame=await engine.extract(position);assert.equal(visiblePixelHash(frame.description,frame.pixels!),nativeVisibleHash(frame.description,expected.get(position)!),`native position ${position}`);frame.frame?.close();}
  let frame:Awaited<ReturnType<typeof engine.next>>=await engine.extract(0),last=frame.pts,outputs=1;frame.frame?.close();
  while((frame=await engine.next(last))){assert.ok(frame.pts>last);last=frame.pts;outputs++;frame.frame?.close();assert.ok(outputs<=count);}
  assert.equal(outputs,count);assert.equal(await engine.next(last),null);
  const late=await engine.extract(count-8);assert.equal(visiblePixelHash(late.description,late.pixels!),nativeVisibleHash(late.description,expected.get(count-8)!));late.frame?.close();
 }finally{engine.close();}
});

for(const [name,codec] of [['mpeg4.mp4','mpeg4'],['mjpeg.mov','mjpeg'],['prores.mov','prores']] as const)test(`JS ${name}: preserve existing decoder with sample-table packets and native pixel oracle`,async()=>{
 const {Mp4Engine}=await import('../../src/mp4-engine.ts'),path=resolve('fixtures/demux-removal',name),bytes=await readFile(path),engine=new Mp4Engine({file:new Blob([bytes])});
 try{
  const opened=await engine.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm'),true);
  assert.equal(opened.codec,codec);assert.equal(opened.times.length,24);
  const positions=[0,3,22,23],first=await engine.extract(0),expected=nativeFrames(path,positions,first.description.sourcePixelFormat!,first.pixels!.byteLength,['-idct','simple']);first.frame?.close();
  for(const position of [...positions,0]){const frame=await engine.extract(position);assert.equal(frame.pts,opened.firstPtsUs+opened.times[position]);assert.equal(visiblePixelHash(frame.description,frame.pixels!),nativeVisibleHash(frame.description,expected.get(position)!),`${name} native position ${position}`);frame.frame?.close();}
  let frame:Awaited<ReturnType<typeof engine.next>>=await engine.extract(0),count=1,last=frame.pts;frame.frame?.close();
  while((frame=await engine.next(last))){assert.ok(frame.pts>last);last=frame.pts;count++;frame.frame?.close();assert.ok(count<=24);}assert.equal(count,24);
 }finally{engine.close();}
});

for(const [name,count] of [['progressive-two-slices.ts',25],['mbaff.ts',50],['mbaff-frame-sei.ts',50]] as const)
for(const threads of [1,2])test(`JS ${name} ST/MT ${threads}: retain all ${count} native frames without exact picture identity`,async()=>{
 const path=resolve('fixtures/ts-analysis',name),bytes=await readFile(path),engine=new JsContainerEngine({file:new Blob([bytes])},name);
 try{
  const suffix=threads===1?'':'-mt',opened=await engine.open(pathToFileURL(resolve(`public/vendor/voidplayer-core/voidplayer-core${suffix}.js`)).href,await readFile(`public/vendor/voidplayer-core/voidplayer-core${suffix}.wasm`),true,threads);
  assert.equal(opened.times.length,count);assert.equal(opened.demuxBackend,'js-ts-packets');
  const {isVerifiedCompleteTsIndex,tsDecodeIndex}=await import('../../src/ts-packet-source.ts');
  const doc=engine.packetIndex!;assert.equal(doc.kind,'js-ts-packets');
  if(doc.kind==='js-ts-packets'){assert.equal(doc.exactPictureMapping,false);const forged={...structuredClone(doc),exactPictureMapping:undefined};assert.equal(isVerifiedCompleteTsIndex(forged),false);assert.throws(()=>tsDecodeIndex(forged),/unverified complete index/);}
  const positions=Array.from({length:count},(_,i)=>i),first=await engine.extract(0),expected=nativeFrames(path,positions,first.description.sourcePixelFormat!,first.pixels!.byteLength);first.frame?.close();
  let frame:Awaited<ReturnType<typeof engine.next>>=await engine.extract(0),last=-Infinity,outputs=0;
  while(frame){assert.ok(frame.pts>last);assert.equal(frame.packetPicture,undefined,'unverified coding layout cannot mint exact AU identity');assert.equal(visiblePixelHash(frame.description,frame.pixels!),nativeVisibleHash(frame.description,expected.get(outputs)!),`native display ${outputs}`);last=frame.pts;outputs++;frame.frame?.close();assert.ok(outputs<=count);frame=await engine.next(last);}
  assert.equal(outputs,count);assert.equal(await engine.next(last),null);
  for(const position of [count-2,3,0,count-1]){const frame=await engine.extract(position);assert.equal(frame.packetPicture,undefined);assert.equal(visiblePixelHash(frame.description,frame.pixels!),nativeVisibleHash(frame.description,expected.get(position)!),`seek native ${position}`);frame.frame?.close();}
 }finally{engine.close();}
});
