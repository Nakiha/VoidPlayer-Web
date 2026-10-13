import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {serializeFfmpegIndex} from '../../../src/ffmpeg-index-cache.ts';
import {ffmpegAnalysisConfiguration} from '../../../src/ffmpeg-analysis-config.ts';
import {ffmpegTicksToUs} from '../../../src/ffmpeg-index-cache.ts';
export async function loadTsCore(playback=false) {
  const file=resolve(playback?'public/vendor/voidplayer-core/voidplayer-core.js':'public/vendor/voidplayer-analysis/voidplayer-analysis.js');
  return (await import(pathToFileURL(file).href)).default({wasmBinary:fs.readFileSync(file.replace(/\.js$/,'.wasm'))});
}
export async function tsFixture(name='h264-static.ts') {
  const bytes=fs.readFileSync('fixtures/ts-analysis/'+name),play=await loadTsCore(true);
  play.vpBlobs=new Map([[1,{blob:{slice:(start:number,end:number)=>({start,end})},reader:{readAsArrayBuffer:({start,end}:any)=>bytes.subarray(start,end)}}]]);
  const ctx=play._vp_create();assert.equal(play._vp_open_blob(ctx,1,BigInt(bytes.length)),0);assert.equal(play._vp_index_build(ctx),600);
  const len=play._vp_index_export_bytes(ctx),ptr=play._malloc(len);assert.equal(play._vp_index_export(ctx,ptr,len),600);
  const records=play.HEAPU8.slice(ptr,ptr+len);play._free(ptr);
  const metadata={analysisConfiguration:ffmpegAnalysisConfiguration(play,()=>play.HEAPU8,ctx),size:bytes.length,codec:'h264',timeBaseNum:play._vp_tb_num(ctx),timeBaseDen:play._vp_tb_den(ctx),width:play._vp_width(ctx),height:play._vp_height(ctx),streamIndex:0,indexerBuild:play.ccall('vp_core_build_id','string',[],[])};
  const snapshot=serializeFfmpegIndex(metadata,records),v=new DataView(records.buffer),ordered:any[]=[];
  for(let i=0;i<600;i++)ordered[Number(v.getBigUint64(i*48+40,true))]={pts:v.getBigInt64(i*48,true),dts:v.getBigInt64(i*48+8,true)};
  const reader=(document=snapshot)=>{
    let closed=false,actualBytes=0,reads=0;
    return {size:bytes.length,ffmpegIndex:async()=>document,
      read:async(o:number,n:number)=>{assert.ok(!closed);actualBytes+=n;reads++;return bytes.subarray(o,o+n);},
      readSync(o:number,n:number){assert.ok(!closed);actualBytes+=n;reads++;return bytes.subarray(o,o+n);},
      close(){closed=true;},get closed(){return closed;},get actualBytes(){return actualBytes;},get reads(){return reads;}};
  };
  const pts=(au:number)=>ffmpegTicksToUs(ordered[au].pts,metadata.timeBaseNum,metadata.timeBaseDen);
  return {bytes,play,ctx,snapshot,records,ordered,reader,pts,close(){play._vp_destroy(ctx);}};
}
