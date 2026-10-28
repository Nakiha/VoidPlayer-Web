import path from 'node:path';import {readFile,mkdir,writeFile} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
import {startService} from '../../server/runtime.ts';import {nativeFixture,sha,until} from './native-vmaf.mjs';
export {sha,until};
export async function xpsnrComponent(){const directory=path.resolve(process.env.VOIDPLAYER_XPSNR_COMPONENT??'.run/components/xpsnr');return {directory,manifestSha256:sha(await readFile(path.join(directory,'manifest.json')))};}
export async function xpsnrFixture(options={}){
 const f=await nativeFixture({...options,component:false,start:async(config,...args)=>{if(options.component!==false)config.nativeXpsnr=await xpsnrComponent();return (options.start??startService)(config,...args);}});
 const input=f.input?{schema:'voidplayer-native-xpsnr-job',version:1,client:f.input.client,plan:f.input.plan,recipe:'ffmpeg-xpsnr-reference-first-temporal-v1',cadenceUs:f.input.cadenceUs,metrics:f.input.metrics,budget:f.input.budget}:undefined;
 return {...f,input,wait:id=>until(()=>f.json('/api/quality/xpsnr/jobs/'+id),j=>!['queued','preparing','running','cancelling'].includes(j.state),'XPSNR completion')};
}
/** Independent CLI consumes fixed native-decoded YUV rather than pipeline raw files. */
export async function xpsnrOracle(f,depth){
 const {directory}=await xpsnrComponent(),out=path.join(f.directory,'xpsnr-oracle');await mkdir(out,{recursive:true});for(const role of ['reference','distorted'])await writeFile(path.join(out,role+'.yuv'),f.oracles[role]);
 const args=['-hide_banner','-nostdin','-loglevel','info','-cpuflags','0','-filter_complex_threads','1'];
 for(const role of ['reference','distorted'])args.push('-threads','1','-f','rawvideo','-pixel_format',depth===8?'yuv420p':'yuv420p10le','-video_size','128x96','-framerate','4','-i',role+'.yuv');
 args.push('-filter_complex','[0:v][1:v]xpsnr=stats_file=oracle.txt:shortest=1:repeatlast=0[out]','-map','[out]','-threads','1','-f','null','-');execFileSync(path.join(directory,'ffmpeg-xpsnr'),args,{cwd:out,stdio:'pipe'});return readFile(path.join(out,'oracle.txt'),'utf8');
}
