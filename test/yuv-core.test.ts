import test from 'node:test';
import { createHash } from 'node:crypto';
const hash=(data:Uint8Array|Uint8ClampedArray)=>createHash('sha256').update(data).digest('hex');
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openFFmpegMedia } from '../src/ffmpeg-media.ts';
import { openPacketMedia } from '../src/packet-media.ts';
import { validateDescription } from '../src/frame-description.ts';

for(const mt of [false,true])test(`real ${mt?'mt':'single'} core planes equal independent FFmpeg raw decode, including seek/reset`,async()=>{
  const suffix=mt?'-mt':'';
  const core=new URL('../public/vendor/voidplayer-core/',import.meta.url);
  const deps={glueURL:new URL(`voidplayer-core${suffix}.js`,core).href,wasmBinary:await readFile(new URL(`voidplayer-core${suffix}.wasm`,core))};
  for(const name of ['ffv1_yuv422p_8bit.mkv','ffv1_yuv444p10le.mkv','mhw_hevc_fullrange_bt709_3s.mp4','h266_10s_1920x1080.mp4']){
    const url=new URL(`../fixtures/video/${name}`,import.meta.url);
    const file=new File([await readFile(url)],name);
    const source=name.endsWith('.mp4')?await openPacketMedia('mp4',{file},file,{...deps,forceWasm:true}):await openFFmpegMedia(file,deps);
    try{
      const first=await source.frameAt(0);
      assert.equal(first.kind,'yuv',name);validateDescription(first.description,first.pixels!.byteLength);
      const raw=execFileSync('ffmpeg',['-v','error','-threads','1','-i',fileURLToPath(url),'-frames:v','1','-f','rawvideo','-pix_fmt',first.description.sourcePixelFormat!,'pipe:1'],{maxBuffer:64*1024*1024});
      assert.equal(hash(first.pixels!),hash(raw),`${name}: original precision and plane order`);
      const saved=first.pixels!.slice();first.close();
      if(source.framesFollowing){
        const following=source.framesFollowing(0),next=await following.next();
        assert.equal(next.done,false);assert.ok(next.value!.ptsUs>0,`${name}: continuation skips the already displayed frame`);
        const nextHash=hash(next.value!.pixels!),nextPts=next.value!.ptsUs;next.value!.close();await following.return(undefined);
        const sought=await source.frameAt(nextPts);assert.equal(hash(sought.pixels!),nextHash,`${name}: continuation equals independently repositioned output`);sought.close();
      }
      const later=await source.frameAt(500000);later.close();
      const back=await source.frameAt(0);assert.equal(hash(back.pixels!),hash(saved),`${name}: seek owns its pixels`);back.close();
    }finally{source.dispose();}
  }
});

test('real core retains odd-sized 16-bit planes and SAR without RGBA quantization',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'void-yuv16-'));
  try{
    const path=join(dir,'odd.mkv');const raw=Buffer.alloc(5*3*3*2);
    for(let i=0;i<45;i++)raw.writeUInt16LE((i*1459)%65536,i*2);
    execFileSync('ffmpeg',['-v','error','-f','rawvideo','-pixel_format','yuv444p16le','-video_size','5x3','-i','pipe:0','-frames:v','1','-vf','setsar=4/3','-c:v','ffv1','-level','3','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',path],{input:raw});
    const data=await readFile(path);
    const decoded=execFileSync('ffmpeg',['-v','error','-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','yuv444p16le','pipe:1']);
    for(const suffix of ['', '-mt']){
      const core=new URL('../public/vendor/voidplayer-core/',import.meta.url);
      const source=await openFFmpegMedia(new File([data],'odd.mkv'),{glueURL:new URL(`voidplayer-core${suffix}.js`,core).href,wasmBinary:await readFile(new URL(`voidplayer-core${suffix}.wasm`,core))});
      try{const frame=await source.frameAt(0);assert.equal(frame.description.yuv!.bitDepth,16);assert.equal(frame.description.width,5);assert.equal(frame.description.height,3);assert.equal(frame.description.displayWidth,7);assert.equal(hash(frame.pixels!),hash(decoded),JSON.stringify({actual:[...frame.pixels!.slice(0,24)],reference:[...decoded.slice(0,24)],input:[...raw.slice(0,24)]}));frame.close();}finally{source.dispose();}
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
