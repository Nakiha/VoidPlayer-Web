// Explicit synthetic fixture regeneration. Browser/media tests consume the
// committed bytes and hashes; they never regenerate their expected outputs.
import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import {tmpdir} from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {demuxFlv} from '../../../shared/media/containers/flv-demux.ts';import {avcGeometry} from '../../../shared/media/codecs/avc-geometry.ts';import {hevcGeometry} from '../../../shared/media/codecs/hevc-geometry.ts';
const [ffmpeg,ffprobe]=process.argv.slice(2);assert.ok(ffmpeg&&ffprobe,'Pass explicit ffmpeg and ffprobe paths');const directory=await mkdtemp(path.join(tmpdir(),'vp-native-presented-fixtures-')),samples=[];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try{for(const [codec,depth]of [['h264',8],['hevc',8],['hevc',10]]){
 const width=96,height=64,frames=16,step=depth===8?1:2,frame=width*height*3/2*step,data=Buffer.alloc(frame*frames);
 for(let n=0;n<frames;n++)for(let i=0;i<width*height*3/2;i++){const x=i%width,y=Math.floor(i/width),v=i>=width*height?128:y<32?((n>>(Math.floor(x/12)%4))&1?192:48):64+n*8;if(depth===8)data[n*frame+i]=v;else data.writeUInt16LE(v*4,n*frame+i*2);}
 const file=path.join(directory,'source.flv'),params='b-adapt=0:scenecut=0:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0';
 execFileSync(ffmpeg,['-v','error','-y','-f','rawvideo','-pix_fmt',depth===8?'yuv420p':'yuv420p10le','-s',`${width}x${height}`,'-r','10','-i','pipe:0','-an','-c:v',codec==='h264'?'libx264':'libx265','-threads','1','-preset','medium','-bf','2','-g','16',...(codec==='h264'?['-x264-params',params]:['-x265-params',params+':pools=none:frame-threads=1:log-level=error']),'-vf','setsar=1/1',file],{input:data});
 const flv=await readFile(file),index=await demuxFlv({size:flv.length,read:async(o,n)=>flv.subarray(o,o+n)}),g=codec==='h264'?avcGeometry(index.description,true):hevcGeometry(index.description,true);assert.equal(g.sarSpecified,true);assert.equal(g.sarNum,g.sarDen);assert.equal(g.width,g.codedWidth);assert.equal(g.height,g.codedHeight);
 const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_frames','-show_streams','-select_streams','v:0','-of','json',file]));const stream=probe.streams[0];for(const field of ['color_space','color_transfer','color_primaries'])assert.equal(stream[field],'bt709');assert.equal(stream.pix_fmt,depth===8?'yuv420p':'yuv420p10le');
 const displayAuOrder=probe.frames.map(f=>{const at=Number(f.pkt_pos),matches=index.packets.map((p,i)=>({p,i})).filter(({p})=>p.offset>at&&p.offset-at<32);assert.equal(matches.length,1,'FFprobe must identify one exact original tag');return matches[0].i;});assert.equal(new Set(displayAuOrder).size,frames);
 const raw=execFileSync(ffmpeg,['-v','error','-i',file,'-pix_fmt',depth===8?'yuv420p':'yuv420p10le','-fps_mode','passthrough','-f','rawvideo','pipe:1']);assert.equal(raw.length,frame*frames);
 samples.push({codec,depth,width,height,frames,profile:stream.profile,level:stream.level,displayAuOrder,barcode:{columns:[6,18,30,42],y:8,threshold:128,displayCodes:Array.from({length:frames},(_,i)=>i)},flv:flv.toString('base64'),flvSha256:sha(flv),native:raw.toString('base64'),nativeSha256:sha(raw)});
}
 const fieldPath=path.join(directory,'field.flv');execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=10','-frames:v','4','-c:v','libx264','-threads','1','-flags','+ilme+ildct','-x264-params','tff=1:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0',fieldPath]);
 const fieldBytes=await readFile(fieldPath),fieldIndex=await demuxFlv({size:fieldBytes.length,read:async(o,n)=>fieldBytes.subarray(o,o+n)});assert.equal(avcGeometry(fieldIndex.description,true).interlaced,true);
 const field={flv:fieldBytes.toString('base64'),sha256:sha(fieldBytes),interlacedSps:true};
 await writeFile(new URL('../../../test/helpers/native-presented-samples.json',import.meta.url),JSON.stringify({schema:'voidplayer-native-presented-fixtures',version:1,
 generator:{ffmpeg:execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split('\n')[0],ffprobe:execFileSync(ffprobe,['-version'],{encoding:'utf8'}).split('\n')[0],pattern:'unique-per-display-frame-gray-bits-v1'},samples,field},null,2)+'\n');
console.log(samples.map(s=>({codec:s.codec,depth:s.depth,profile:s.profile,sha256:s.flvSha256})));
}finally{await rm(directory,{recursive:true,force:true});}
