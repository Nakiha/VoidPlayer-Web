import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {measureSsim,SSIM_VARIANT} from '../../shared/analysis/quality/ssim.ts';
import {frame} from '../helpers/quality-numeric-frame.ts';
// @ts-ignore independent test-only reference
import {referencePattern,ssimOracle} from '../helpers/ssim-oracle.mjs';
const ff=(args:string[])=>execFileSync('ffmpeg',['-hide_banner','-nostdin',...args],{encoding:'utf8',timeout:30000,stdio:'pipe'});
const golden=JSON.parse(await readFile(new URL('../helpers/ssim-ffmpeg-reference.json',import.meta.url),'utf8'));
for(const depth of [8,10] as const)test(`SSIM ${depth}-bit fixed reference and live FFmpeg, full/offset ROI/grid`,{timeout:90000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-ssim-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const [a,b]=referencePattern(depth),reference=frame(depth,{width:32,height:32}),distorted=frame(depth,{width:32,height:32});reference.pixels.set(a);distorted.pixels.set(b);
 const files=[path.join(dir,'a.yuv'),path.join(dir,'b.yuv')];await writeFile(files[0],a);await writeFile(files[1],b);
 const version=ff(['-version']).split('\n')[0];t.diagnostic(version);
 const input=(file:string)=>['-f','rawvideo','-pixel_format',depth===8?'yuv420p':'yuv420p10le','-video_size','32x32','-framerate','1','-i',file];
 for(const roi of [{x:0,y:0,width:32,height:32},{x:2,y:4,width:24,height:20}]) {
  const result=measureSsim({domain:'source-yuv-code-values',reference,distorted,roi,...(roi.x===0?{spatial:{blockWidth:16,blockHeight:16}}:{})},{variant:SSIM_VARIANT});
  for(const value of [result,...(result.spatial?.blocks??[])]) {
   const r=value.roi,crop=`crop=${r.width}:${r.height}:${r.x}:${r.y}`;
   const output=ff(['-v','error',...input(files[0]),...input(files[1]),'-filter_complex_threads','1','-filter_complex',`[0:v]${crop}[a];[1:v]${crop}[b];[a][b]ssim=stats_file=-`,'-frames:v','1','-f','null','-']);
   const stats=Object.fromEntries([...output.matchAll(/(Y|U|V|All):(-?[0-9.]+)/g)].map(m=>[m[1],Number(m[2])]));
   const oracle=ssimOracle(a,b,depth,32,32,r);
   for(const [key,p] of Object.entries({Y:value.planes.y.score,U:value.planes.u.score,V:value.planes.v.score,All:value.aggregate.score}))assert.ok(Math.abs(stats[key]-p)<=.00001,`${depth} ${key}: ${output} vs ${p}`);
   assert.ok(Math.abs(value.aggregate.score-oracle.all)<=1e-12);
   const fixed=golden.cases.find((c:any)=>c.depth===depth&&JSON.stringify(c.roi)===JSON.stringify(r));assert.ok(fixed);
   assert.equal(createHash('sha256').update(a).digest('hex'),fixed.referenceSha256);assert.equal(createHash('sha256').update(b).digest('hex'),fixed.distortedSha256);
   for(const [key,p] of Object.entries({Y:value.planes.y.score,U:value.planes.u.score,V:value.planes.v.score,All:value.aggregate.score}))assert.ok(Math.abs(fixed.stats[key]-p)<=.00001,`fixed ${key}`);
  }
 }
});
