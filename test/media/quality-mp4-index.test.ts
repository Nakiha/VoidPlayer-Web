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
  execFileSync('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=25','-frames:v','8','-vf','setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv','-c:v',codec==='h264'?'libx264':'libx265','-threads','1','-bf','2','-g','8',...(codec==='h264'?['-x264-params','scenecut=0:open-gop=0']:['-x265-params','pools=1:frame-threads=1:scenecut=0:open-gop=0:log-level=error','-tag:v','hvc1']),'-pix_fmt',depth===10?'yuv420p10le':'yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-use_editlist','0','-video_track_timescale','1000000','-movie_timescale','1000000','-movflags','+faststart+write_colr',file],{stdio:['ignore','pipe','pipe']});
  const bytes=new Uint8Array(await readFile(file)),{document:d,readBytes}=await parse(bytes),probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts,dts,duration,pos,size,flags','-of','json',file],{encoding:'utf8'}));
  assert.equal(d.codec,codec);assert.equal(d.timescale,1000000);assert.equal(d.samples.length,8);assert.ok(readBytes>bytes.length/2);assert.ok(d.samples.some(s=>s.ctsTicks!==0),'fixture contains delayed/reordered clocks');
  for(const [i,p]of probe.packets.entries())assert.deepEqual([d.samples[i].ordinal,d.samples[i].offset,d.samples[i].size,d.samples[i].dtsTicks,d.samples[i].ctsTicks,d.samples[i].durationTicks,d.samples[i].key],[i,Number(p.pos),Number(p.size),p.dts,p.pts-p.dts,p.duration,p.flags.includes('K')]);
  assert.equal(d.moov.sha256,await digest(bytes.subarray(d.moov.offset,d.moov.offset+d.moov.size)));
  if(codec==='hevc'){const conflict=bytes.slice(),at=boxData(conflict,'hvcC');conflict[at+17]=(conflict[at+17]&248)|(depth===8?2:0);conflict[at+18]=(conflict[at+18]&248)|(depth===8?2:0);await assert.rejects(parse(conflict),/configuration and SPS/);}
  const truncated=bytes.slice(0,-1);await assert.rejects(parse(truncated),/Truncated|outside/);
  const badOffset=bytes.slice();new DataView(badOffset.buffer).setUint32(boxData(badOffset,'stco')+8,0);await assert.rejects(parse(badOffset),/outside complete mdat/);
  const external=bytes.slice();external[boxData(external,'url ')+3]=0;await assert.rejects(parse(external),/self-contained/);
  const fractional=bytes.slice();new DataView(fractional.buffer).setUint32(boxData(fractional,'mdhd')+12,90001);const retimed=(await parse(fractional)).document;assert.equal(retimed.timescale,90001);assert.deepEqual(retimed.samples.map(s=>[s.dtsTicks,s.ctsTicks,s.durationTicks]),d.samples.map(s=>[s.dtsTicks,s.ctsTicks,s.durationTicks]));assert.equal(retimed.samples[1].ptsUs,Math.round((d.samples[1].dtsTicks+d.samples[1].ctsTicks)*1000000/90001));
  const appendFragment=Buffer.concat([bytes,Buffer.from([0,0,0,8,109,111,111,102])]);await assert.rejects(parse(appendFragment),/Fragmented MP4/);
  const movieRotate=bytes.slice();new DataView(movieRotate.buffer).setUint32(boxData(movieRotate,'mvhd')+36,0);await assert.rejects(parse(movieRotate),/movie rotation/);
  const quicktime=bytes.slice();quicktime.set(Buffer.from('qt  '),boxData(quicktime,'ftyp'));await assert.rejects(parse(quicktime),/ISO MP4 file type/);
  const invalidVersion=bytes.slice();invalidVersion[boxData(invalidVersion,'stts')]=1;await assert.rejects(parse(invalidVersion),/version\/flags/);
  const changedDescription=bytes.slice();new DataView(changedDescription.buffer).setUint32(boxData(changedDescription,'stsc')+16,2);await assert.rejects(parse(changedDescription),/sample\/configuration/);
  const falseAllSync=bytes.slice();falseAllSync.set(Buffer.from('free'),boxData(falseAllSync,'stss')-4);await assert.rejects(parse(falseAllSync),/verified single-picture closed IDR/);
  const encrypted=bytes.slice();encrypted.set(Buffer.from('encv'),boxData(encrypted,'stsd')+12);await assert.rejects(parse(encrypted),/protected sample descriptions/);
  const duplicatePts=bytes.slice(),cttsAt=boxData(duplicatePts,'ctts');assert.ok(new DataView(duplicatePts.buffer).getUint32(cttsAt+4)>1);new DataView(duplicatePts.buffer).setUint32(cttsAt+20,d.samples[0].ptsUs-d.samples[1].dtsUs);await assert.rejects(parse(duplicatePts),/clock is ambiguous/);
  const trakStart=boxData(bytes,'trak')-8,trakSize=new DataView(bytes.buffer).getUint32(trakStart),track=bytes.slice(trakStart,trakStart+trakSize),moovEnd=d.moov.offset+d.moov.size,multiple=Buffer.concat([bytes.subarray(0,moovEnd),track,bytes.subarray(moovEnd)]);multiple.writeUInt32BE(d.moov.size+track.length,d.moov.offset);await assert.rejects(parse(multiple),/one explicit MP4 video track|track IDs must be unique/);
  const fakeKey=bytes.slice(),first=d.samples[0];let at=first.offset;const width=codec==='h264'?(d.description[4]&3)+1:(d.description[21]&3)+1;while(at<first.offset+first.size){let n=0;for(let i=0;i<width;i++)n=n*256+fakeKey[at++];const type=codec==='h264'?fakeKey[at]&31:fakeKey[at]>>1&63;if(codec==='h264'?type===5:type===19||type===20){fakeKey[at]=codec==='h264'?(fakeKey[at]&224)|1:(fakeKey[at]&129)|(1<<1);break;}at+=n;}await assert.rejects(parse(fakeKey),/verified single-picture closed IDR/);
});
test('MP4 transport projects rational clocks without replacing source ticks',()=>{assert.equal(mp4TicksToUs(3,75),40000);assert.equal(mp4TicksToUs(1,3),333333);assert.equal(mp4TicksToUs(2,3),666667);assert.equal(mp4TicksToUs(-2,3),-666667);assert.throws(()=>mp4TicksToUs(Number.MAX_SAFE_INTEGER,1),/overflowing MP4 clock/);});

test('MP4 identity edit and unscored audio are self-contained; time remapping and external audio are rejected',{timeout:60000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-mp4-edits-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'identity.mp4');
 execFileSync('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=25','-f','lavfi','-i','sine=sample_rate=48000','-t','0.32','-vf','setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv','-c:v','libx264','-threads','1','-bf','0','-g','8','-c:a','aac','-use_editlist','0','-video_track_timescale','1000000','-movie_timescale','1000000','-movflags','+faststart+write_colr',file],{stdio:'pipe'});
 const bytes=new Uint8Array(await readFile(file)),d=(await parse(bytes)).document;assert.equal(d.samples.length,8);
 // Add a single duration-preserving identity edit to the video track. All
 // physical chunks are shifted together, so this is a valid complete file.
 const trak=boxData(bytes,'trak')-8,tkhd=boxData(bytes,'tkhd'),mvhd=boxData(bytes,'mvhd'),movieScale=new DataView(bytes.buffer).getUint32(mvhd+12),segment=d.durationTicks*movieScale/d.timescale;assert.ok(Number.isSafeInteger(segment),JSON.stringify({duration:d.durationTicks,movieScale,timescale:d.timescale,segment}));
 const edit=Buffer.alloc(36);edit.writeUInt32BE(36,0);edit.write('edts',4);edit.writeUInt32BE(28,8);edit.write('elst',12);edit.writeUInt32BE(1,20);edit.writeUInt32BE(segment,24);edit.writeInt16BE(1,32);
 const at=trak+new DataView(bytes.buffer).getUint32(trak),identity=Buffer.concat([bytes.subarray(0,at),edit,bytes.subarray(at)]);identity.writeUInt32BE(identity.readUInt32BE(d.moov.offset)+edit.length,d.moov.offset);identity.writeUInt32BE(identity.readUInt32BE(trak)+edit.length,trak);identity.writeUInt32BE(segment,tkhd+20);
 // This fixture uses stco in both video and audio sample tables.
 for(let i=4;i<identity.length-12;i++)if(identity.toString('ascii',i,i+4)==='stco'){const count=identity.readUInt32BE(i+8);for(let j=0;j<count;j++){const p=i+12+j*4;identity.writeUInt32BE(identity.readUInt32BE(p)+edit.length,p);}}
 const accepted=(await parse(identity)).document;assert.deepEqual(accepted.samples.map(s=>[s.dtsTicks,s.ctsTicks,s.durationTicks]),d.samples.map(s=>[s.dtsTicks,s.ctsTicks,s.durationTicks]));
 const remapped=Buffer.from(identity);remapped.writeInt32BE(1,at+28);await assert.rejects(parse(remapped),/edit remapping/);
 let urls=0;const external=Buffer.from(bytes);for(let i=4;i<external.length-8;i++)if(external.toString('ascii',i,i+4)==='url '){urls++;if(urls===2)external[i+7]=0;}assert.equal(urls,2);await assert.rejects(parse(external),/self-contained/);
});

test('MP4 preparation rejects SPS/HVCC pixel-domain disagreement and unsupported encoded formats',{timeout:60000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'vp-mp4-pixels-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [codec,format]of [['h264','yuv420p10le'],['hevc','yuv422p10le'],['hevc','yuv420p12le']]){
  const file=join(dir,codec+'-'+format+'.mp4');execFileSync('ffmpeg',['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=25','-frames:v','2','-vf','setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv','-c:v',codec==='h264'?'libx264':'libx265','-threads','1',...(codec==='hevc'?['-x265-params','pools=1:frame-threads=1:open-gop=0:log-level=error','-tag:v','hvc1']:[]),'-pix_fmt',format,'-use_editlist','0','-video_track_timescale','1000000','-movflags','+faststart+write_colr',file],{stdio:'pipe'});await assert.rejects(parse(new Uint8Array(await readFile(file))),/H2648 or HEVC8\/10 YUV420/);
 }
});
