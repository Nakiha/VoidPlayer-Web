import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import type {FrameDescription} from '../../../shared/media/frame-description.ts';

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

export function nativeVisibleFrameBytes(description:FrameDescription){
 const y=description.yuv;assert.ok(y&&!y.semiplanar);const r=description.visibleRect;
 return y.planes.reduce((sum,_plane,i)=>{const sx=i?2**y.subsampleX:1,sy=i?2**y.subsampleY:1;
  return sum+(Math.ceil((r.x+r.width)/sx)-Math.floor(r.x/sx))*(Math.ceil((r.y+r.height)/sy)-Math.floor(r.y/sy))*(y.bitDepth>8?2:1);
 },0);
}

/** Metadata must come from the same pinned native build as the pixel oracle. */
export function nativeVideoMetadata(file:string){
 const probe=process.env.VOIDPLAYER_FFPROBE_ORACLE||(process.env.VOIDPLAYER_FFMPEG_ORACLE?join(dirname(process.env.VOIDPLAYER_FFMPEG_ORACLE),'ffprobe'):'ffprobe');
 const result=JSON.parse(execFileSync(probe,['-v','error','-select_streams','v:0','-show_entries','stream=codec_name,pix_fmt','-of','json',file],{encoding:'utf8'})).streams?.[0];
 assert.ok(result&&typeof result.codec_name==='string'&&typeof result.pix_fmt==='string','native oracle must identify the codec and decoded pixel format');
 return result as {codec_name:string;pix_fmt:string};
}

/** Seek before opening the output encoder so changing source dimensions do not
 * get scaled back to the first segment's rawvideo geometry. */
export function nativeSeekFrame(file:string,timeUs:number,format:string,frameBytes:number){
 assert.ok(Number.isSafeInteger(timeUs)&&timeUs>=0);
 const raw=execFileSync(process.env.VOIDPLAYER_FFMPEG_ORACLE||'ffmpeg',['-v','error','-threads','1','-ss',String(timeUs/1e6),'-i',file,'-map','0:v:0','-frames:v','1','-pix_fmt',format,'-f','rawvideo','pipe:1'],{maxBuffer:Math.max(64*1024*1024,frameBytes+1024)});
 assert.equal(raw.length,frameBytes,'native seek oracle must preserve this segment geometry');return raw;
}
