/** Explicit fixture generation only: remux the fixed FLV bitstreams without
 * re-encoding and independently verify native raw output before committing. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {scanFlv} from '../../shared/media/containers/flv-demux.ts';
import {readMp4QualityIndex} from '../../shared/media/indexing/mp4-quality-index.ts';

const sha=b=>createHash('sha256').update(b).digest('hex');
const source=JSON.parse(await readFile(new URL('../../test/helpers/native-vmaf-samples.json',import.meta.url),'utf8'));
const directory=await mkdtemp(path.join(tmpdir(),'vp-vmaf-mp4-generator-'));
try{
 const samples=[];
 const ffmpeg=execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\n')[0];
 for(const [codec,depth]of [['h264',8],['hevc',8],['hevc',10]]){
  const row=source.samples.find(s=>s.codec===codec&&s.depth===depth&&s.tagged);
  assert.ok(row);const sample={codec,depth,frames:row.frames,reference:null,distorted:null};
  for(const side of ['reference','distorted']){
   const fixed=row[side],flv=Buffer.from(fixed.flv,'base64');assert.equal(sha(flv),fixed.flvSha256);
   const input=path.join(directory,'input.flv'),output=path.join(directory,'output.mp4');
   await writeFile(input,flv);
   const args=['-hide_banner','-v','error','-y','-copyts','-i',input,'-map','0:v:0','-c:v','copy','-an','-tag:v',codec==='h264'?'avc1':'hvc1','-video_track_timescale','1000000','-use_editlist','0','-movflags','+faststart+write_colr',output];
   execFileSync('ffmpeg',args,{stdio:'pipe'});
   const mp4=await readFile(output),{document}=await readMp4QualityIndex({size:mp4.length,read:async(at,n)=>mp4.subarray(at,at+n)},{digest:async b=>sha(b)});
   const {index}=await scanFlv({size:flv.length,read:async(at,n)=>flv.subarray(at,at+n)});
   assert.equal(document.samples.length,index.packets.length);
   for(const [au,s]of document.samples.entries()){
    const p=index.packets[au];assert.equal(s.ptsUs,p.pts);assert.equal(s.dtsUs,p.dts);assert.equal(s.durationUs,250000);
    assert.deepEqual(mp4.subarray(s.offset,s.offset+s.size),flv.subarray(p.offset,p.offset+p.size));
   }
   const raw=execFileSync('ffmpeg',['-v','error','-i',output,'-pix_fmt',depth===8?'yuv420p':'yuv420p10le','-f','rawvideo','-'],{stdio:'pipe'});
   assert.equal(sha(raw),fixed.rawSha256);assert.deepEqual(raw,gunzipSync(Buffer.from(fixed.rawGzip,'base64')));
   sample[side]={mp4:mp4.toString('base64'),mp4Sha256:sha(mp4),sourceFlvSha256:fixed.flvSha256,rawSha256:sha(raw)};
  }
  samples.push(sample);
 }
 await writeFile(new URL('../../test/helpers/native-vmaf-mp4-samples.json',import.meta.url),JSON.stringify({schema:'voidplayer-native-vmaf-mp4-fixtures',version:1,recipe:{ffmpeg,source:'native-vmaf-samples.json fixed FLV access units',remux:'copyts; video copy; no edit list; 1000000 ticks/s; faststart/write_colr; avc1/hvc1',verification:'exact compressed AU bytes and PTS/DTS/duration; independently decoded raw SHA256 equals fixed FLV raw oracle; no content certification'},samples},null,2)+'\n');
 console.log('Generated 3 fixed MP4 codec/depth fixtures; identical access units, clocks and independently decoded native planes.');
}finally{await rm(directory,{recursive:true,force:true});}
