import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readMp4QualityIndex} from '../../shared/media/indexing/mp4-quality-index.ts';
export async function mp4QualityFixture(directory:string,codec:'h264'|'hevc',depth:8|10){
  const file=join(directory,`${codec}-${depth}.mp4`),format=depth===10?'yuv420p10le':'yuv420p';
  execFileSync('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=25','-frames:v','8','-vf','setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv','-c:v',codec==='h264'?'libx264':'libx265','-threads','1','-bf','2','-g','8',...(codec==='h264'?['-x264-params','scenecut=0:open-gop=0:chromaloc=0']:['-x265-params','pools=1:frame-threads=1:scenecut=0:open-gop=0:chromaloc=0:log-level=error','-tag:v','hvc1']),'-pix_fmt',format,'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left','-use_editlist','0','-video_track_timescale','1000000','-movflags','+faststart+write_colr',file],{stdio:'pipe'});
  const native=execFileSync('ffmpeg',['-v','error','-i',file,'-pix_fmt',format,'-f','rawvideo','-'],{stdio:'pipe'}),packets=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts,dts,duration,pos,size,flags','-of','json',file],{encoding:'utf8'})).packets;
  const bytes=await readFile(file),{document}=await readMp4QualityIndex({size:bytes.length,read:async(at,n)=>bytes.subarray(at,at+n)},{validatePayloads:false,digest:async b=>createHash('sha256').update(b).digest('hex')});
  return {file,bytes,native,packets,format,document};
}
/** A separate real FLV file with unchanged compressed AU bytes and exact clocks.
 * The production MP4 adapter never constructs or consults these test-only tags. */
export function flvCopyOfMp4Fixture(f:Awaited<ReturnType<typeof mp4QualityFixture>>){
 const codec=f.document.codec,enhanced=codec==='hevc';
 const header=(type:number,key:boolean,cts:number)=>{if(!Number.isInteger(cts)||cts< -0x800000||cts>0x7fffff)throw Error('Fixture clock cannot be represented by FLV');const clock=Buffer.alloc(3);clock.writeUIntBE(cts&0xffffff,0,3);return enhanced?Buffer.concat([Buffer.from([0x80|(key?0x10:0x20)|type]),Buffer.from('hvc1'),...(type===1?[clock]:[])]):Buffer.concat([Buffer.from([(key?0x10:0x20)|7,type]),clock]);};
 const tag=(payload:Uint8Array,dts:number)=>{if(!Number.isInteger(dts)||dts<0||dts>0xffffffff)throw Error('Fixture DTS cannot be represented by FLV');const b=Buffer.alloc(payload.length+15);b[0]=9;b.writeUIntBE(payload.length,1,3);b.writeUIntBE(dts&0xffffff,4,3);b[7]=dts>>>24;b.set(payload,11);b.writeUInt32BE(11+payload.length,b.length-4);return b;};
 return Buffer.concat([Buffer.from('464c5601010000000900000000','hex'),tag(Buffer.concat([header(0,true,0),Buffer.from(f.document.description)]),0),...f.document.samples.map(s=>tag(Buffer.concat([header(1,s.key,(s.ptsUs-s.dtsUs)/1000),f.bytes.subarray(s.offset,s.offset+s.size)]),s.dtsUs/1000))]);
}
