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
