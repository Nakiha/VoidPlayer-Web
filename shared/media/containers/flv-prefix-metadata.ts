import {DISCOVERY_LIMITS as LIMITS} from '../discovery.ts';
import {aacMetadata} from './cached-track-metadata.ts';
import type {AudioTrackMetadata} from './cached-track-metadata.ts';
const u24=(b:Uint8Array,i:number)=>b[i]*65536+b[i+1]*256+b[i+2];
const u32=(b:Uint8Array,i:number)=>b[i]*16777216+u24(b,i+1);
/** Bounded prefix observation, independent of the full FLV packet indexer.
 * No recovery, resync, picture search or attempt to reach a late video stream. */
export async function flvPrefixMetadata(size:number,read:(offset:number,length:number)=>Promise<Uint8Array>){
 const header=await read(0,Math.min(9,size));
 if(header.length<9||header[3]!==1||header[4]&~5)throw Error('unsupported-flv-header');
 const end=Math.min(size,LIMITS.flvPrefixBytes),dataOffset=u32(header,5);
 if(dataOffset<9||dataOffset+4>end)throw Error('unsupported-flv-header');
 if(u32(await read(dataOffset,4),0)!==0)throw Error('malformed-flv-prefix');
 let at=dataOffset+4,tags=0,stop='prefix-byte-limit';
 let video:{codec:string|null;description:Uint8Array|null;reason:string|null}|null=null;
 let audio:{codec:string|null;metadata:AudioTrackMetadata;reason:string|null}|null=null;
 while(at<end&&tags<LIMITS.flvTagHeaders){
  if(at+11>end){stop=at===size?'end-of-prefix-source':'incomplete-prefix-tag';break;}
  const tag=await read(at,11);tags++;const length=u24(tag,1),payload=at+11,next=payload+length+4;
  if(![8,9,18].includes(tag[0])||u24(tag,8)!==0)throw Error('malformed-flv-prefix');
  if(next>end){stop='tag-exceeds-prefix';break;}
  if(u32(await read(next-4,4),0)!==length+11)throw Error('malformed-flv-prefix');
  if(tag[0]===8&&!audio&&length){
   const b=await read(payload,Math.min(length,66)),format=b[0]>>4;
   const codec=({0:'pcm',1:'adpcm',2:'mp3',3:'pcm',4:'nellymoser',5:'nellymoser',6:'nellymoser',7:'pcm-alaw',8:'pcm-mulaw',10:'aac',11:'speex',14:'mp3'} as Record<number,string>)[format]??null;
   const metadata:AudioTrackMetadata={};let reason:string|null=null;
   if(format===10){if(b.length>=4&&b[1]===0)Object.assign(metadata,aacMetadata(b.subarray(2)));else reason='AAC-initial-configuration-not-observed';}
   else if([0,1,2,3,14].includes(format)){metadata.channels=(b[0]&1)+1;metadata.sampleRate=format===14?8000:[5500,11025,22050,44100][(b[0]>>2)&3];}
   audio={codec,metadata,reason:codec?reason:'unsupported-FLV-audio-format'};
  }
  if(tag[0]===9&&length&&(!video||!video.description)){
   const b=await read(payload,Math.min(length,8)),enhanced=!!(b[0]&128),frameType=(b[0]>>4)&7;
   if(frameType<1||frameType>5)throw Error('malformed-flv-video-prefix');
   if(frameType!==5){
    if(length<5)throw Error('malformed-flv-video-prefix');
    const type=enhanced?b[0]&15:b[1],codec=enhanced?({avc1:'h264',hvc1:'hevc',av01:'av1',vvc1:'vvc'} as Record<string,string>)[String.fromCharCode(...b.subarray(1,5))]:({7:'h264',12:'hevc',13:'av1',14:'vvc'} as Record<number,string>)[b[0]&15];
    if(type!==2&&type!==4){
     video={codec:codec??null,description:null,reason:enhanced&&type>3?'unsupported-enhanced-video-packet-kind':codec?'initial-video-configuration-not-observed':'unsupported-FLV-video-codec'};
     if(type===0&&codec){const count=length-5;if(count>0&&count<=LIMITS.flvConfigurationBytes){video.description=await read(payload+5,count);video.reason=null;}else video.reason='initial-video-configuration-exceeds-prefix-budget';}
    }
   }
  }
  at=next;
  if(video?.description&&audio){stop='initial-audio-and-video-observed';break;}
 }
 if(tags===LIMITS.flvTagHeaders)stop='prefix-tag-limit';else if(at===size)stop='end-of-prefix-source';
 return {video,audio,prefix:{endOffset:Math.min(at,end),tagHeadersInspected:tags,stop}};
}
