// Reproducible public synthetic fixtures; never reads user media.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../../..'),dir=await mkdtemp(path.join(tmpdir(),'vp-discovery-fixtures-'));
try{const data=JSON.parse(await readFile(path.join(root,'test/helpers/quality-http-samples.json'),'utf8')),samples=[];
 for(const [codec,depth,tagged]of [['h264',8,true],['hevc',10,true],['h264',8,false]]){
  const original=data.samples.find(s=>s.codec===codec&&s.depth===depth&&s.tagged===tagged);if(!original)throw Error('Missing original synthetic source');
  const label=`${codec}-${depth}-${tagged?'tagged':'untagged'}`,input=path.join(dir,label+'.flv');await writeFile(input,Buffer.from(original.flv,'base64'));
  for(const extension of tagged?['flv','mp4','mkv','ts']:['mp4']){
   const output=extension==='flv'?input:path.join(dir,label+'.'+extension);
   if(extension!=='flv')execFileSync('ffmpeg',['-v','error','-i',input,'-map','0:v:0','-c','copy','-y',output]);
   const bytes=await readFile(output),oracle=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{encoding:'utf8'}));
   samples.push({name:`${label}.${extension}`,codec,depth,tagged,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.toString('base64'),
    oracle:{format:oracle.format.format_name,streams:oracle.streams.map(s=>({codec:s.codec_name,type:s.codec_type,width:s.width,height:s.height,pixelFormat:s.pix_fmt,
      timeBase:s.time_base,duration:s.duration??null,colorTransfer:s.color_transfer??null,colorPrimaries:s.color_primaries??null,colorMatrix:s.color_space??null}))}});
  }
 }
 const subtitle=path.join(dir,'synthetic.srt');await writeFile(subtitle,'1\n00:00:00,000 --> 00:00:01,900\nSynthetic metadata track\n');
 for(const extension of ['mp4','mkv']){
  const output=path.join(dir,'h264-8-multitrack.'+extension);execFileSync('ffmpeg',['-v','error','-i',path.join(dir,'h264-8-tagged.flv'),'-f','lavfi','-i','sine=frequency=1000:sample_rate=44100','-f','srt','-i',subtitle,
   '-map','0:v:0','-map','1:a:0','-map','2:s:0','-t','2','-c:v','copy','-c:a','aac','-c:s',extension==='mp4'?'mov_text':'srt','-y',output]);
  const bytes=await readFile(output),oracle=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{encoding:'utf8'}));
  samples.push({name:path.basename(output),codec:'h264',depth:8,tagged:true,multitrack:true,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.toString('base64'),
   oracle:{format:oracle.format.format_name,streams:oracle.streams.map(s=>({codec:s.codec_name,type:s.codec_type,width:s.width,height:s.height,pixelFormat:s.pix_fmt,timeBase:s.time_base,duration:s.duration??null,
    colorTransfer:s.color_transfer??null,colorPrimaries:s.color_primaries??null,colorMatrix:s.color_space??null}))}});
 }
 const audioSamples=[];
 for(const [codec,encoder]of [['mp3','libmp3lame'],['aac','aac']]){
  const output=path.join(dir,`${codec}-audio-only.flv`);execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.5','-c:a',encoder,'-f','flv','-y',output]);
  const bytes=await readFile(output),oracle=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-of','json',output],{encoding:'utf8'}));
  audioSamples.push({name:path.basename(output),codec,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.toString('base64'),oracle:oracle.streams.map(s=>({codec:s.codec_name,sampleRate:Number(s.sample_rate),channels:s.channels}))});
 }
 await writeFile(path.join(root,'test/helpers/library-discovery-samples.json'),JSON.stringify({schema:'voidplayer-library-discovery-fixtures',version:1,
  generator:execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\n')[0],recipe:'Remux existing public synthetic quality-http-samples without re-encoding or retagging video; audio-only cases are generated from public sine waves. ffprobe stream metadata is the independent oracle.',samples,audioSamples},null,2)+'\n');
 console.log(`Generated ${samples.length} bounded discovery fixtures`);
}finally{await rm(dir,{recursive:true,force:true});}
