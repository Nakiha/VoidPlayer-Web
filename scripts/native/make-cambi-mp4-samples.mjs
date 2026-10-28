/** Offline public synthetic fixture generation; application/tests never invoke
 * PATH encoders. Pin the strict table plus independently reconstructed pixels. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
import {readMp4QualityIndex} from '../../shared/media/indexing/mp4-quality-index.ts';
const sha=b=>createHash('sha256').update(b).digest('hex');
const source=JSON.parse(await readFile(new URL('../../test/helpers/native-cambi-samples.json',import.meta.url),'utf8'));
const directory=await mkdtemp(path.join(tmpdir(),'vp-cambi-mp4-generator-'));
try{
 const samples=[];
 for(const [codec,depth,variant='forward']of [['h264',8],['hevc',8],['hevc',10],['hevc',10,'reordered']]){
  const fixed=source.samples.find(s=>s.depth===depth&&s.pattern==='banded');
  const raw=gunzipSync(Buffer.from(fixed.rawGzip,'base64'));assert.equal(sha(raw),fixed.rawSha256);if(variant==='reordered')for(let f=0;f<4;f++)for(let i=0;i<fixed.width*fixed.height;i++){const at=(f*fixed.width*fixed.height*3/2+i)*2;raw.writeUInt16LE(raw.readUInt16LE(at)+f*4,at);}
  const input=path.join(directory,'input.flv'),output=path.join(directory,'output.mp4');
  let args,sourceFlvSha256=null;
  if(codec===fixed.codec&&variant==='forward'){
   const flv=Buffer.from(fixed.flv,'base64');assert.equal(sha(flv),fixed.flvSha256);sourceFlvSha256=sha(flv);await writeFile(input,flv);
   args=['-copyts','-i',input,'-map','0:v:0','-c:v','copy'];
  }else{
   const yuv=path.join(directory,'input.yuv');await writeFile(yuv,raw);
   args=['-f','rawvideo','-pixel_format',depth===8?'yuv420p':'yuv420p10le','-video_size',`${fixed.width}x${fixed.height}`,'-framerate','4','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-i',yuv,'-c:v','libx265','-preset','ultrafast','-threads','1','-x265-params',`lossless=1:keyint=4:min-keyint=4:scenecut=0:bframes=${variant==='reordered'?2:0}:b-adapt=0:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0:pools=none:frame-threads=1`,'-vf','setsar=1','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left'];
  }
  execFileSync('ffmpeg',['-hide_banner','-v','error','-y',...args,...(variant==='reordered'?['-avoid_negative_ts','make_zero']:[]),'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-an','-tag:v',codec==='h264'?'avc1':'hvc1','-video_track_timescale','1000000','-use_editlist','0','-movflags','+faststart+write_colr',output]);
  console.log('Validating explicit synthetic MP4',codec,depth,variant);
  const mp4=await readFile(output),{document}=await readMp4QualityIndex({size:mp4.length,read:async(at,n)=>mp4.subarray(at,at+n)},{digest:async b=>sha(b)});
  assert.equal(document.codec,codec);assert.equal(document.samples.length,4);
  for(const [i,s]of document.samples.entries()){if(variant==='forward')assert.equal(s.ptsUs,i*250000);assert.equal(s.dtsUs,i*250000);assert.equal(s.durationUs,250000);}
  if(variant==='reordered')assert.ok(document.samples.some(s=>s.ptsUs!==s.dtsUs));
  const decoded=execFileSync('ffmpeg',['-v','error','-i',output,'-pix_fmt',depth===8?'yuv420p':'yuv420p10le','-threads','1','-f','rawvideo','-'],{maxBuffer:16*1024*1024});
  assert.deepEqual(decoded,raw,'lossless source pixels must equal independent MP4 decoder output');
  samples.push({container:'mp4',variant,firstPtsUs:Math.min(...document.samples.map(s=>s.ptsUs)),endPtsUs:Math.max(...document.samples.map(s=>s.ptsUs+s.durationUs)),codec,depth,pattern:'banded',width:fixed.width,height:fixed.height,frames:4,mp4:mp4.toString('base64'),mp4Sha256:sha(mp4),sourceRawSha256:sha(raw),sourceFlvSha256,rawGzip:gzipSync(decoded).toString('base64'),rawSha256:sha(decoded),rawBytes:decoded.length,tableSha256:document.moov.sha256});
 }
 await writeFile(new URL('../../test/helpers/native-cambi-mp4-samples.json',import.meta.url),JSON.stringify({schema:'voidplayer-cambi-mp4-fixtures',version:1,recipe:{ffmpeg:execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\n')[0],source:'fixed original synthetic banded CAMBI planes; remux H2648/HEVC10, losslessly encode HEVC8; independently decode all outputs',mp4:'avc1/hvc1; exact 1000000 timescale; no edit list; faststart/write_colr; progressive square limited BT709 SDR'},samples})+'\n');
 console.log('Generated four strict CAMBI MP4 codec/depth fixtures including nonzero clocks/reordered drain, exact clocks and independent native pixels.');
}finally{await rm(directory,{recursive:true,force:true});}
