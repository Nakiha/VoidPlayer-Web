import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readMp4QualityIndex,mp4TicksToUs} from '../../shared/media/indexing/mp4-quality-index.ts';
const digest=async(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const parse=(b:Uint8Array)=>readMp4QualityIndex({size:b.length,read:async(at,n)=>b.slice(at,at+n)},{digest});
function boxData(b:Uint8Array,name:string){for(let i=4;i<b.length-4;i++)if(String.fromCharCode(...b.subarray(i,i+4))===name)return i+4;assert.fail('Missing fixture box '+name);}
for(const [codec,depth]of [['h264',8],['hevc',8],['hevc',10]] as const)test(`strict MP4 ${codec}/${depth} raw sample identity matches ffprobe`,{timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'vp-mp4-quality-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'source.mp4');
  execFileSync('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=25','-frames:v','8','-vf','setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv','-c:v',codec==='h264'?'libx264':'libx265','-threads','1','-bf','2','-g','8',...(codec==='h264'?['-x264-params','scenecut=0:open-gop=0']:['-x265-params','pools=1:frame-threads=1:scenecut=0:open-gop=0:log-level=error','-tag:v','hvc1']),'-pix_fmt',depth===10?'yuv420p10le':'yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-use_editlist','0','-video_track_timescale','1000000','-movflags','+faststart+write_colr',file],{stdio:['ignore','pipe','pipe']});
  const bytes=new Uint8Array(await readFile(file)),{document:d,readBytes}=await parse(bytes),probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts,dts,duration,pos,size,flags','-of','json',file],{encoding:'utf8'}));
  assert.equal(d.codec,codec);assert.equal(d.timescale,1000000);assert.equal(d.samples.length,8);assert.ok(readBytes>bytes.length/2);assert.ok(d.samples.some(s=>s.ctsTicks!==0),'fixture contains delayed/reordered clocks');
  for(const [i,p]of probe.packets.entries())assert.deepEqual([d.samples[i].ordinal,d.samples[i].offset,d.samples[i].size,d.samples[i].dtsTicks,d.samples[i].ctsTicks,d.samples[i].durationTicks,d.samples[i].key],[i,Number(p.pos),Number(p.size),p.dts,p.pts-p.dts,p.duration,p.flags.includes('K')]);
  assert.equal(d.moov.sha256,await digest(bytes.subarray(d.moov.offset,d.moov.offset+d.moov.size)));
  const truncated=bytes.slice(0,-1);await assert.rejects(parse(truncated),/Truncated|outside/);
  const badOffset=bytes.slice();new DataView(badOffset.buffer).setUint32(boxData(badOffset,'stco')+8,0);await assert.rejects(parse(badOffset),/outside complete mdat/);
  const external=bytes.slice();external[boxData(external,'url ')+3]=0;await assert.rejects(parse(external),/self-contained/);
  const fractional=bytes.slice();new DataView(fractional.buffer).setUint32(boxData(fractional,'mdhd')+12,90001);await assert.rejects(parse(fractional),/exactly representable/);
  const fakeKey=bytes.slice(),first=d.samples[0];let at=first.offset;const width=codec==='h264'?(d.description[4]&3)+1:(d.description[21]&3)+1;while(at<first.offset+first.size){let n=0;for(let i=0;i<width;i++)n=n*256+fakeKey[at++];const type=codec==='h264'?fakeKey[at]&31:fakeKey[at]>>1&63;if(codec==='h264'?type===5:type===19||type===20){fakeKey[at]=codec==='h264'?(fakeKey[at]&224)|1:(fakeKey[at]&129)|(1<<1);break;}at+=n;}await assert.rejects(parse(fakeKey),/verified single-picture closed IDR/);
});
test('MP4 clocks require exact safe integer microseconds without rounding',()=>{assert.equal(mp4TicksToUs(3,75),40000);assert.throws(()=>mp4TicksToUs(1,3),/exactly representable/);assert.throws(()=>mp4TicksToUs(Number.MAX_SAFE_INTEGER,1),/exact integer range/);});
