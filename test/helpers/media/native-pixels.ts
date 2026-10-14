import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {FrameDescription} from '../../../src/frame-description.ts';

/** Independent native decoder; only selected visible frames are materialized. */
export function nativeFrames(file:string,positions:number[],format:string,frameBytes:number,decoderOptions:string[]=[]){
 const selected=[...new Set(positions)].sort((a,b)=>a-b);assert.ok(selected.length&&selected.every(p=>Number.isSafeInteger(p)&&p>=0));
 const filter=selected.map(p=>`eq(n\\,${p})`).join('+');
 const raw=execFileSync(process.env.VOIDPLAYER_FFMPEG_ORACLE||'ffmpeg',['-v','error','-threads','1',...decoderOptions,'-i',file,'-map','0:v:0','-vf',`select=${filter}`,'-fps_mode','passthrough','-pix_fmt',format,'-f','rawvideo','pipe:1'],{maxBuffer:Math.max(64*1024*1024,frameBytes*selected.length+1024)});
 assert.equal(raw.length,frameBytes*selected.length,'native oracle must output every requested frame');
 return new Map(selected.map((p,i)=>[p,raw.subarray(i*frameBytes,(i+1)*frameBytes)]));
}
export function nativeVisibleHash(description:FrameDescription,raw:Uint8Array){
 const y=description.yuv;assert.ok(y&&!y.semiplanar,'native oracle comparison requires the actual planar source format');
 return createHash('sha256').update(JSON.stringify([description.width,description.height,description.format,[y.bitDepth,y.bitShift,y.subsampleX,y.subsampleY,y.semiplanar]])).update(raw).digest('hex');
}
