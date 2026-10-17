import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {JsContainerEngine} from '../../src/js-container-engine.ts';
import {openJsTsAnalysisInput} from '../../shared/analysis/bitstream/js-ts-input.ts';
import {analyzePicture} from '../../shared/analysis/bitstream/runner.ts';
import {loadTsCore} from '../helpers/media/ts-analysis.ts';
import {CachedContainerAudio} from '../../src/cached-container-audio.ts';
import {visiblePixelHash} from '../helpers/visible-pixels.ts';

test('H264 TS with interleaved AAC keeps JS packet playback, independent exact analysis and cached audio',async()=>{
 const bytes=new Uint8Array(await readFile('fixtures/demux-removal/h264-audio.ts')),version='ts-audio-js';
 let mediaReads=0;class ObservedBlob extends Blob{override slice(start?:number,end?:number){mediaReads++;return super.slice(start,end);}}
 const engine=new JsContainerEngine({file:new ObservedBlob([bytes])},version);
 let analysis:Awaited<ReturnType<typeof openJsTsAnalysisInput>>|undefined;
 try{
  const index=await engine.prepare();assert.equal(index.packets.length,600);assert.equal(index.codec,'h264');
  const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','packet=pts_time','-of','json','fixtures/demux-removal/h264-audio.ts'],{encoding:'utf8'}));
  assert.deepEqual(index.packets.map(p=>p.ptsUs),probe.packets.map((p:any)=>Math.round(Number(p.pts_time)*1e6)));
  await engine.open(pathToFileURL(resolve('public/vendor/voidplayer-core/voidplayer-core.js')).href,new Uint8Array(await readFile('public/vendor/voidplayer-core/voidplayer-core.wasm')),true);
  const displayPosition=probe.packets.filter((p:any)=>Math.round(Number(p.pts_time)*1e6)<index.packets[560].ptsUs).length;
  const native=execFileSync('ffmpeg',['-v','error','-i','fixtures/demux-removal/h264-audio.ts','-map','0:v:0','-vf',`select=eq(n\\,0)+eq(n\\,${displayPosition})`,'-fps_mode','passthrough','-pix_fmt','yuv420p','-f','rawvideo','pipe:1'],{maxBuffer:16*1024*1024});
  const frameBytes=1920*1080*3/2;assert.equal(native.length,frameBytes*2);
  for(const [slot,au] of [0,560].entries()){
   const frame=await engine.at(index.packets[au].ptsUs);assert.equal(frame.packetPicture?.au,au);assert.equal(frame.description.visibleRect.width,1920);assert.equal(frame.description.visibleRect.height,1080);
   const d=frame.description,y=d.yuv!;const expected=createHash('sha256').update(JSON.stringify([d.width,d.height,d.format,[y.bitDepth,y.bitShift,y.subsampleX,y.subsampleY,y.semiplanar]])).update(native.subarray(slot*frameBytes,(slot+1)*frameBytes)).digest('hex');
   assert.equal(visiblePixelHash(d,frame.pixels!),expected,`native visible-plane oracle AU${au}`);frame.frame?.close();
  }
  let closed=false;const reader={size:bytes.length,async read(at:number,n:number){assert.equal(closed,false);return bytes.subarray(at,at+n);},jsIndex:async()=>index,close(){closed=true;}};
  analysis=await openJsTsAnalysisInput(reader,version,new AbortController().signal);const core=await loadTsCore();core._vpd_open=()=>{throw new Error('Container analysis forbidden');};
  const packet=analysis.packets[560],picture=analysis.picture(packet,version);const result=await analyzePicture(reader,{sourceVersion:version,sourcePtsUs:packet.pts,normalizedMediaUs:packet.pts-index.packets[0].ptsUs,picture},core,'audio-test',new AbortController().signal,{input:analysis});
  assert.equal(result.confidence,'exact');assert.deepEqual(result.picture,picture);const again=await engine.at(packet.pts);assert.equal(again.packetPicture?.au,560);again.frame?.close();
  const beforeAudio=mediaReads,audio=new CachedContainerAudio(bytes.length,async(at,n)=>engine.peekCachedBytes(at,n),async()=>engine.cachedWindows(),'mpegts');try{let batch;for(let i=0;i<4;i++){batch=await audio.read(index.packets[0].ptsUs);if(batch.packets.length)break;}assert.ok(batch!.packets.length>0);assert.ok(batch!.config?.codec.startsWith('mp4a'));assert.equal(mediaReads,beforeAudio,'optional audio cannot read missing media');}finally{audio.dispose();}
 }finally{analysis?.close();engine.close();}
});
