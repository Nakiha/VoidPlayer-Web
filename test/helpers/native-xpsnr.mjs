import path from 'node:path';import {readFile,mkdir,writeFile} from 'node:fs/promises';import {execFileSync} from 'node:child_process';
import {startService} from '../../server/runtime.ts';import {nativeFixture,sha,until} from './native-vmaf.mjs';
export {sha,until};
export async function xpsnrComponent(){const directory=path.resolve(process.env.VOIDPLAYER_XPSNR_COMPONENT??'.run/components/xpsnr');return {directory,manifestSha256:sha(await readFile(path.join(directory,'manifest.json')))};}
export async function xpsnrFixture(options={}){
 const f=await nativeFixture({...options,component:false,start:async(config,...args)=>{if(options.component===true)config.nativeXpsnr=await xpsnrComponent();return (options.start??startService)(config,...args);}});
 const input=f.input?{schema:'voidplayer-native-xpsnr-job',version:1,client:f.input.client,plan:f.input.plan,recipe:'ffmpeg-xpsnr-reference-first-temporal-v1',cadenceUs:f.input.cadenceUs,...(f.input.cadence?{cadence:f.input.cadence}:{}),metrics:f.input.metrics,budget:f.input.budget}:undefined;
 return {...f,input,wait:id=>until(()=>f.json('/api/quality/xpsnr/jobs/'+id),j=>!['queued','preparing','running','cancelling'].includes(j.state),'XPSNR completion')};
}
/** Committed independent official CLI output, selected by exact raw identity. */
export async function xpsnrOracle(f,depth){
 const oracle=JSON.parse(await readFile(new URL('./analysis-xpsnr-oracle.json',import.meta.url),'utf8'));
 const referenceSha256=sha(f.oracles.reference),distortedSha256=sha(f.oracles.distorted);
 const found=oracle.cases.find(c=>c.depth===depth&&c.referenceSha256===referenceSha256&&c.distortedSha256===distortedSha256&&c.rate.ticks/c.rate.timescale===(f.input?.cadence?.ticks/f.input?.cadence?.timescale||0.25));
 if(!found)throw Error('Missing committed official XPSNR pixels/rate');return found.text;
}
