/** Explicit synthetic fixture regeneration. Runtime tests need no PATH tools. */
import {writeFile,readFile,mkdir} from 'node:fs/promises';import path from 'node:path';import {spawnSync,execFileSync} from 'node:child_process';import {gzipSync} from 'node:zlib';import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..'),dir=path.join(root,'.run/cambi-fixtures');await mkdir(dir,{recursive:true});const sha=b=>createHash('sha256').update(b).digest('hex');const samples=[];
for(const depth of [8,10])for(const pattern of ['banded','smooth','texture','grain','flat']){
 const w=640,h=352,count=4,frameBytes=w*h*3/2*(depth===8?1:2),raw=Buffer.alloc(frameBytes*count);let seed=123;
 for(let f=0;f<count;f++)for(let i=0;i<w*h*3/2;i++){const x=i%w,y=Math.floor(i/w);let n;
  if(i>=w*h)n=128;else if(pattern==='banded')n=100+Math.floor(x/24);else if(pattern==='flat')n=100;else if(pattern==='smooth')n=80+(x*140/w);else if(pattern==='texture')n=16+((x*31+y*17+f*11)%220);else{seed=(Math.imul(seed,1664525)+1013904223)>>>0;n=100+Math.floor(x/24)+(seed%15)-7;}
  if(depth===8)raw[f*frameBytes+i]=Math.round(n);else raw.writeUInt16LE(Math.round(n*4),(f*frameBytes/2+i)*2);
 }
 const name=`${pattern}-${depth}`,rawPath=path.join(dir,name+'.yuv'),flvPath=path.join(dir,name+'.flv');await writeFile(rawPath,raw);
 const codec=depth===8?'libx264':'libx265',args=['-v','error','-f','rawvideo','-pixel_format',depth===8?'yuv420p':'yuv420p10le','-video_size',`${w}x${h}`,'-framerate','4','-i',rawPath,'-c:v',codec,'-preset','ultrafast','-threads','1',...(depth===8?['-qp','0','-x264-params','keyint=4:min-keyint=4:scenecut=0:bframes=0:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0']:['-x265-params','lossless=1:keyint=4:min-keyint=4:scenecut=0:bframes=0:colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0:pools=none:frame-threads=1']),'-vf','setsar=1','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-chroma_sample_location','left','-f','flv','-y',flvPath];
 const r=spawnSync('ffmpeg',args,{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);const flv=await readFile(flvPath);
 // Independently reconstruct encoded pixels and pin those bytes as the oracle.
 const decoded=execFileSync('ffmpeg',['-v','error','-i',flvPath,'-f','rawvideo','-pix_fmt',depth===8?'yuv420p':'yuv420p10le','-threads','1','-'],{maxBuffer:8*1024*1024});
 samples.push({pattern,depth,codec:depth===8?'h264':'hevc',width:w,height:h,frames:count,flv:flv.toString('base64'),flvSha256:sha(flv),rawGzip:gzipSync(decoded).toString('base64'),rawSha256:sha(decoded),rawBytes:decoded.length});
}
await writeFile(path.join(root,'test/helpers/native-cambi-samples.json'),JSON.stringify({generator:'scripts/native/make-cambi-samples.mjs',description:'Original synthetic limited SDR gradients/texture/grain; decoded oracle from FFmpeg; no external/private media',ffmpeg:execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\n')[0],samples})+'\n');
