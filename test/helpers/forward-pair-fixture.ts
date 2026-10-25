import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {openAnalysisInput} from '../../shared/analysis/bitstream/input.ts';
import {flvTag} from './frame-pair-fixture.ts';
export async function encodedForwardFixture(dir:string,codec:'h264'|'hevc',depth:8|10,options:{frames?:number;bframes?:number;keyint?:number}={}){
 const frames=options.frames??8,bframes=options.bframes??0,keyint=options.keyint??30;
 const file=join(dir,`${codec}-${depth}-${frames}-${bframes}-${keyint}.mp4`),format=depth===8?'yuv420p':'yuv420p10le';
 const params=`keyint=${keyint}:min-keyint=${keyint}:scenecut=0:bframes=${bframes}:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0`;
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=10','-frames:v',String(frames),'-filter_threads','1','-pix_fmt',format,
  '-c:v',codec==='h264'?'libx264':'libx265','-threads','1',...(codec==='h264'?['-x264-params',params]:['-x265-params',params+':open-gop=0:repeat-headers=0:pools=none:frame-threads=1:log-level=error']),file],{stdio:'pipe',timeout:30000});
 const mp4=await readFile(file),input=await openAnalysisInput({size:mp4.length,read:async(o,l)=>mp4.subarray(o,o+l),close(){}},new AbortController().signal);
 try{
  const configuration=input.configurations[0],enhanced=codec==='hevc',origin=2000;
  const header=(type:number,key:boolean,pts:number,dts:number)=>{
   const cts=Buffer.alloc(3);cts.writeUIntBE((pts-dts)&0xffffff,0,3);
   return enhanced?Buffer.concat([Buffer.from([(key?0x90:0xa0)|type]),Buffer.from('hvc1'),...(type===1?[cts]:[])])
    :Buffer.concat([Buffer.from([key?0x17:0x27,type]),cts]);
  };
  const tags=[flvTag(Buffer.concat([header(0,true,0,0),configuration]),0)],packets=[];
  for(const p of input.packets){
   const pts=p.pts/1000+origin,dts=p.dts!/1000+origin;
   if(!Number.isInteger(pts)||!Number.isInteger(dts))throw new Error('Fixture FLV millisecond clock must be exact');
   tags.push(flvTag(Buffer.concat([header(1,p.key,pts,dts),await input.readUnit(p)]),dts));packets.push({pts:pts*1000,dts:dts*1000,key:p.key});
  }
  const native=execFileSync('ffmpeg',['-v','error','-i',file,'-pix_fmt',format,'-f','rawvideo','-'],{stdio:'pipe',timeout:30000});
  return {bytes:Buffer.concat([Buffer.from('464c5601010000000900000000','hex'),...tags]),native,configuration,packets,file};
 }finally{input.close();}
}
