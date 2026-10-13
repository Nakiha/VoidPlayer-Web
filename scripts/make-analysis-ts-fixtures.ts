import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
// Fixture-only timebase rescaling is performed by the standard muxer. Video is
// copied from the independently frozen H264 source; no codec transcode.
await mkdir('fixtures/ts-analysis',{recursive:true});
execFileSync('ffmpeg',['-y','-v','error','-i','fixtures/video/h264_9s_1920x1080.mp4','-map','0:v:0','-an','-c:v','copy','-bsf:v','h264_mp4toannexb','-f','mpegts','fixtures/ts-analysis/h264-static.ts']);
const {readFile,writeFile}=await import('node:fs/promises');
const original=await readFile('fixtures/ts-analysis/h264-static.ts');
const pes:number[]=[];
for(let at=0;at<original.length;at+=188) {
  if(original[at]!==0x47 || !(original[at+1]&0x40))continue;
  const control=(original[at+3]>>4)&3;if(!(control&1))continue;
  const start=at+4+(control&2?1+original[at+4]:0);
  if(start+19<=at+188 && original[start]===0 && original[start+1]===0 && original[start+2]===1 && original[start+3]>=0xe0 && original[start+3]<=0xef && (original[start+7]>>6)===3)pes.push(start);
}
if(pes.length<2)throw new Error('Fixture lacks timestamped video PES');
const missing=Buffer.from(original);missing[pes[0]+7]&=0x3f;missing.fill(0xff,pes[0]+9,pes[0]+9+missing[pes[0]+8]);
await writeFile('fixtures/ts-analysis/h264-missing-timestamps.ts',missing);
const duplicate=Buffer.from(original);original.copy(duplicate,pes[1]+9,pes[0]+9,pes[0]+14);
await writeFile('fixtures/ts-analysis/h264-duplicate-pts.ts',duplicate);
// HRD SEI must not turn absent PES clocks into trusted timestamps.
execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x96:rate=25','-t','4','-c:v','libx264','-b:v','120k','-minrate','120k','-maxrate','120k','-bufsize','240k','-x264-params','nal-hrd=cbr:keyint=25:scenecut=0:slices=1','-an','-f','mpegts','fixtures/ts-analysis/hrd.ts']);
const hrd=await readFile('fixtures/ts-analysis/hrd.ts'),badHrd=Buffer.from(hrd),videoPes:number[]=[];
for(let at=0;at<hrd.length;at+=188) {
 if(hrd[at]!==0x47 || !(hrd[at+1]&0x40))continue;const control=(hrd[at+3]>>4)&3;if(!(control&1))continue;
 const pos=at+4+(control&2?1+hrd[at+4]:0);
 if(hrd[pos]===0 && hrd[pos+1]===0 && hrd[pos+2]===1 && hrd[pos+3]>=0xe0 && hrd[pos+3]<=0xef)videoPes.push(pos);
}
if(videoPes.length!==100)throw new Error('HRD negative fixture must have 100 video PES packets');
for(const au of [10,11,40,41]){const pos=videoPes[au],flags=badHrd[pos+7]>>6;if(![2,3].includes(flags))throw new Error('Missing source HRD PES timing');badHrd[pos+7]&=0x3f;badHrd.fill(0xff,pos+9,pos+9+(flags===3?10:5));}
await writeFile('fixtures/ts-analysis/hrd-missing.ts',badHrd);
// Coding structure stays MBAFF. Only presentation pic_struct becomes FRAME.
execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x96:rate=25','-t','2','-c:v','libx264','-flags','+ilme+ildct','-x264-params','interlaced=1:tff=1:keyint=25:scenecut=0:slices=1:pic-struct=1','-an','-f','mpegts','fixtures/ts-analysis/mbaff.ts']);
const mbaff=await readFile('fixtures/ts-analysis/mbaff.ts'),frameSei=Buffer.from(mbaff);let replaced=0;
for(let at=0;at+5<=mbaff.length;at++)if(mbaff[at]===6 && mbaff[at+1]===1 && mbaff[at+2]===1 && [0x32,0x42].includes(mbaff[at+3]) && mbaff[at+4]===0x80){
 if(Math.floor(at/188)!==Math.floor((at+4)/188))throw new Error('Picture SEI crosses a TS packet');frameSei[at+3]=4;replaced++;
}
// x264 may signal TOP_BOTTOM (3) or BOTTOM_TOP (4) for B pictures; both become
// FRAME (0). This bounded fixture requires exactly one such SEI per picture.
if(replaced!==50)throw new Error(`Expected 50 picture-timing SEIs, found ${replaced}`);
await writeFile('fixtures/ts-analysis/mbaff-frame-sei.ts',frameSei);
for(const [name,slices] of [['progressive-single',1],['progressive-two-slices',2]] as const)
 execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x96:rate=25','-t','1','-c:v','libx264','-x264-params',`keyint=25:scenecut=0:slices=${slices}`,'-an','-f','mpegts',`fixtures/ts-analysis/${name}.ts`]);
// Null transport packets increase physical IO beyond 64 MiB without changing
// any compressed picture, timestamps or decoder workload. Whole execution must
// retain bounded advancement budgets rather than a lifetime byte ceiling.
const padding=Buffer.alloc(188,0xff);padding.set([0x47,0x1f,0xff,0x10]);
const padded=Buffer.alloc(original.length*4);
for(let at=0;at<original.length;at+=188){original.copy(padded,at*4,at,at+188);for(let i=1;i<4;i++)padding.copy(padded,at*4+i*188);}
await writeFile('fixtures/ts-analysis/h264-padded-long.ts',padded);
