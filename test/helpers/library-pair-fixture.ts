import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAnalysisInput } from '../../shared/analysis/bitstream/input.ts';
import { demuxFlv } from '../../shared/media/containers/flv-demux.ts';
import { wrapFlv } from './frame-pair-fixture.ts';
const ffmpeg=(args:string[])=>execFileSync('ffmpeg',['-hide_banner','-nostdin',...args],{timeout:30000,stdio:'pipe'});
export async function encodedPair(dir:string,codec:'h264'|'hevc',depth:8|10,tagged=true){
 if(process.versions.bun){
  const samples=JSON.parse(await readFile(new URL('./quality-http-samples.json',import.meta.url),'utf8'));
  const saved=samples.samples.find((sample:any)=>sample.codec===codec&&sample.depth===depth&&sample.tagged===tagged);
  if(!saved)throw new Error('Missing committed native quality fixture');
  const bytes=Buffer.from(saved.flv,'base64'),native=Buffer.from(saved.native,'base64');
  if(createHash('sha256').update(bytes).digest('hex')!==saved.flvSha256||createHash('sha256').update(native).digest('hex')!==saved.nativeSha256)
    throw new Error('Native quality fixture digest mismatch');
  const index=await demuxFlv({size:bytes.length,read:async(o,l)=>bytes.subarray(o,o+l)});
  return {bytes,native,configuration:index.description,packets:index.packets.map(packet=>bytes.subarray(packet.offset,packet.offset+packet.size))};
 }
 const format=depth===8?'yuv420p':'yuv420p10le',file=join(dir,`${codec}-${depth}-${tagged}.mp4`);
 const color=tagged?':colorprim=bt709:transfer=bt709:colormatrix=bt709:chromaloc=0':'';
 ffmpeg(['-v','error','-f','lavfi','-i','testsrc2=size=32x32:rate=1','-frames:v','2','-filter_threads','1','-pix_fmt',format,
 '-c:v',codec==='h264'?'libx264':'libx265','-threads','1',...(codec==='h264'?['-x264-params',`keyint=1${color}`]:['-x265-params',`keyint=1:open-gop=0:repeat-headers=0:pools=none:frame-threads=1:log-level=error${color}`]),file]);
 const mp4=await readFile(file),input=await openAnalysisInput({size:mp4.length,read:async(o,l)=>mp4.subarray(o,o+l),close(){}},new AbortController().signal);
 const configuration=input.configurations[0],packets=await Promise.all(input.packets.map(p=>input.readUnit(p)));input.close();
 return {bytes:wrapFlv(codec,configuration,packets,codec==='hevc'),configuration,packets,
 native:ffmpeg(['-v','error','-i',file,'-frames:v','2','-pix_fmt',format,'-f','rawvideo','-'])};
}
