import {nalRanges} from '../shared/media/codecs/nal-framing.ts';
import{readFile,writeFile,mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';import path from'node:path';
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'fixtures/analysis-execution');await mkdir(out,{recursive:true});
const args=['-v','error','-f','lavfi','-i','testsrc2=size=320x184:rate=24','-frames:v','48','-c:v','libx265','-pix_fmt','yuv420p','-x265-params','pools=none:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0:bframes=3:b-adapt=0:log-level=error','-f','hevc','-y',path.join(out,'base.hevc')];execFileSync('ffmpeg',args);
const raw=await readFile(path.join(out,'base.hevc'));
const packets=JSON.parse(execFileSync('ffprobe',['-v','error','-f','hevc','-show_packets','-show_entries','packet=pos,size','-of','json',path.join(out,'base.hevc')])).packets;
function rbspEscape(bytes){const out=[];let zeros=0;for(const b of bytes){if(zeros>=2&&b<=3){out.push(3);zeros=0;}out.push(b);zeros=b===0?zeros+1:0;}return Buffer.from(out);}
function sei(type,payload,prefix=false){return Buffer.concat([Buffer.from([0,0,0,1,(prefix?39:40)<<1,1]),rbspEscape(Buffer.concat([Buffer.from([type,payload.length]),payload,Buffer.from([128])]))]);}
let bits='0'+'00'+'0'+'00'+'0010'+'000'+'1';bits=bits.padEnd(Math.ceil(bits.length/8)*8,'0');const grain=Buffer.from(bits.match(/.{8}/g).map(x=>parseInt(x,2)));
const range=nalRanges('hevc',Buffer.from([0,0,0,1]),raw).find(n=>(raw[n.offset]>>1&63)===34);if(!range)throw Error('PPS missing');const pps=Buffer.concat([Buffer.from([0,0,0,1]),raw.subarray(range.offset,range.offset+range.size)]);
for(const [name,nal,prefix]of[['late-hash',sei(132,Buffer.from([1,0,0,0,0,0,0])),false],['late-grain',sei(19,grain,true),true],['late-pps',pps,true]]){
 const chunks=[];for(let i=0;i<packets.length;i++){const p=packets[i],unit=raw.subarray(Number(p.pos),Number(p.pos)+Number(p.size));chunks.push(i===10&&prefix?Buffer.concat([nal,unit]):i===10?Buffer.concat([unit,nal]):unit);}
 const file=path.join(out,name+'.hevc');await writeFile(file,Buffer.concat(chunks));execFileSync('ffmpeg',['-v','error','-fflags','+genpts','-r','24','-f','hevc','-i',file,'-map','0:v:0','-c','copy','-tag:v','hev1','-y',path.join(out,name+'.mp4')]);console.log(name,packets.length,nal.length);
}

execFileSync('ffmpeg',['-v','error','-fflags','+genpts','-r','24','-f','hevc','-i',path.join(out,'base.hevc'),'-c','copy','-tag:v','hev1','-y',path.join(out,'normal.mp4')]);
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=128x64:rate=24','-frames:v','48','-c:v','libx265','-pix_fmt','yuv420p10le','-x265-params','pools=none:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0:bframes=3:log-level=error','-tag:v','hvc1','-y',path.join(out,'main10.mp4')]);
// Main10 late requirements use the same NAL framing and transaction boundaries.
execFileSync('ffmpeg',['-v','error','-i',path.join(out,'main10.mp4'),'-c','copy','-bsf:v','hevc_mp4toannexb','-f','hevc','-y',path.join(out,'main10.hevc')]);
const raw10=await readFile(path.join(out,'main10.hevc')),packets10=JSON.parse(execFileSync('ffprobe',['-v','error','-f','hevc','-show_packets','-show_entries','packet=pos,size','-of','json',path.join(out,'main10.hevc')])).packets;
const ppsRange10=nalRanges('hevc',Buffer.from([0,0,0,1]),raw10).find(n=>(raw10[n.offset]>>1&63)===34);if(!ppsRange10)throw Error('Main10 PPS missing');
const pps10=Buffer.concat([Buffer.from([0,0,0,1]),raw10.subarray(ppsRange10.offset,ppsRange10.offset+ppsRange10.size)]);
for(const [name,nal,prefix]of[['main10-late-hash',sei(132,Buffer.from([1,0,0,0,0,0,0])),false],['main10-late-grain',sei(19,grain,true),true],['main10-late-pps',pps10,true]]){
 const chunks=packets10.map((p,i)=>{const unit=raw10.subarray(Number(p.pos),Number(p.pos)+Number(p.size));return i===10?Buffer.concat(prefix?[nal,unit]:[unit,nal]):unit;});
 const file=path.join(out,name+'.hevc');await writeFile(file,Buffer.concat(chunks));execFileSync('ffmpeg',['-v','error','-fflags','+genpts','-r','24','-f','hevc','-i',file,'-c','copy','-tag:v','hev1','-y',path.join(out,name+'.mp4')]);
}
execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x184:rate=24','-frames:v','48','-c:v','libx265','-pix_fmt','yuv420p','-x265-params','pools=none:frame-threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=1:bframes=3:b-adapt=0:log-level=error','-tag:v','hvc1','-y',path.join(out,'open-gop.mp4')]);
execFileSync('ffmpeg',['-v','error','-i',path.join(out,'open-gop.mp4'),'-c','copy','-bsf:v','hevc_mp4toannexb','-f','hevc','-y',path.join(out,'open.hevc')]);
const openRaw=await readFile(path.join(out,'open.hevc')),openPackets=JSON.parse(execFileSync('ffprobe',['-v','error','-f','hevc','-show_packets','-show_entries','packet=pos,flags','-of','json',path.join(out,'open.hevc')])).packets,second=openPackets.find((p,i)=>i>0&&p.flags.includes('K'));
if(!second)throw Error('CRA fixture needs second key AU');const parameters=new Map();for(const n of nalRanges('hevc',Buffer.from([0,0,0,1]),openRaw)){const t=openRaw[n.offset]>>1&63;if(t>=32&&t<=34&&!parameters.has(t))parameters.set(t,Buffer.concat([Buffer.from([0,0,0,1]),openRaw.subarray(n.offset,n.offset+n.size)]));}
await writeFile(path.join(out,'missing-anchor.hevc'),Buffer.concat([...parameters.values(),openRaw.subarray(Number(second.pos))]));
execFileSync('ffmpeg',['-v','error','-fflags','+genpts','-r','24','-f','hevc','-i',path.join(out,'missing-anchor.hevc'),'-c','copy','-tag:v','hev1','-y',path.join(out,'missing-anchor.mp4')]);

execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x192:rate=24','-frames:v','48','-c:v','libx264','-pix_fmt','yuv420p','-x264-params','threads=1:keyint=24:min-keyint=24:scenecut=0:open-gop=0:bframes=2:slices=2','-y',path.join(out,'h264.mp4')]);
