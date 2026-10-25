import test from 'node:test';
import assert from 'node:assert/strict';
import {measureSsim,SSIM_VARIANT,ssimPlan} from '../../shared/analysis/quality/ssim.ts';
import {measurePsnr} from '../../shared/analysis/quality/psnr.ts';
import {validateSsim} from '../../shared/analysis/quality/ssim-evidence.ts';
import {frame} from '../helpers/quality-numeric-frame.ts';
// @ts-ignore test-only independent JS oracle
import {ssimOracle,referencePattern} from '../helpers/ssim-oracle.mjs';
const variant={variant:SSIM_VARIANT},roi={x:0,y:0,width:32,height:32};
function pair(depth:8|10=8){const [a,b]=referencePattern(depth),reference=frame(depth,{width:32,height:32}),distorted=frame(depth,{width:32,height:32});reference.pixels.set(a);distorted.pixels.set(b);return {domain:'source-yuv-code-values' as const,reference,distorted,roi};}
function near(a:number,b:number){assert.ok(Math.abs(a-b)<=1e-12,`${a} vs ${b}`);}
for(const depth of [8,10] as const)test(`SSIM ${depth}-bit full/ROI/grid exactly matches independent BigInt windows`,()=>{
 const request={...pair(depth),spatial:{blockWidth:16,blockHeight:16}},s=measureSsim(request,variant);
 for(const value of [s,...s.spatial!.blocks]) {
  const oracle=ssimOracle(request.reference.pixels,request.distorted.pixels,depth,32,32,value.roi);
  for(const key of ['y','u','v'] as const){near(value.planes[key].score,oracle[key].score);assert.deepEqual({...value.planes[key],score:0},{...oracle[key],score:0});}
  near(value.aggregate.score,oracle.all);
 }
 validateSsim(s,measurePsnr(request));assert.deepEqual(JSON.parse(JSON.stringify(s)),s);
 const cropped=measureSsim({...request,roi:{x:2,y:4,width:24,height:20},spatial:undefined},variant);
 near(cropped.aggregate.score,ssimOracle(request.reference.pixels,request.distorted.pixels,depth,32,32,cropped.roi).all);
 assert.deepEqual(cropped.planes.u.coverage,{x:2,y:4,width:24,height:16});assert.equal(cropped.planes.y.windows,20);assert.equal(cropped.planes.u.windows,2);
});
test('known FFmpeg constants, perfect score, negative score without clamp, and limited-range peak',()=>{
 const reference=frame(8,{width:16,height:16,value:()=>0}),distorted=frame(8,{width:16,height:16,value:()=>1});
 const request={domain:'source-yuv-code-values' as const,reference,distorted,roi:{x:0,y:0,width:16,height:16}};
 const s=measureSsim(request,variant);assert.equal(s.window.c1,416);assert.equal(s.window.c2,235963);near(s.aggregate.score,13/141);assert.equal(measureSsim({...request,distorted:reference},variant).aggregate.score,1);
 const a=frame(10,{width:32,height:32,value:(_c,x,y)=>(x+y)%2?1023:0}),b=frame(10,{width:32,height:32,value:(_c,x,y)=>(x+y)%2?0:1023});assert.ok(measureSsim({...pair(10),reference:a,distorted:b},variant).aggregate.score<-.99);
});
test('padded stride, cropped visible plane and nonzero byteOffset do not alter SSIM',()=>{
 const base=pair(10);const padded=(source:typeof base.reference)=>frame(10,{width:32,height:32,codedWidth:36,codedHeight:36,cropX:2,cropY:2,padding:14,byteOffset:7,value:(c,x,y)=>{
  const scale=c?2:1,xx=x-2/scale,yy=y-2/scale;if(xx<0||yy<0||xx>=32/scale||yy>=32/scale)return 1000;
  const p=source.description.yuv!.planes[c],i=p.offset+yy*p.stride+xx*2;return source.pixels[i]+source.pixels[i+1]*256;
 }});
 assert.deepEqual(measureSsim({...base,reference:padded(base.reference),distorted:padded(base.distorted)},variant),measureSsim(base,variant));
});
test('strict optional variant, ROI, actual clipped blocks and work budgets reject before execution',()=>{
 for(const invalid of [{variant:'gaussian'},{variant:SSIM_VARIANT,extra:true},null])assert.throws(()=>ssimPlan(roi,invalid as never));
 for(const small of [{...roi,width:14},{...roi,x:1}])assert.throws(()=>ssimPlan(small,variant));
 assert.throws(()=>ssimPlan({...roi,width:34},variant,{blockWidth:16,blockHeight:16}),/block-minimum-16/);
 assert.throws(()=>ssimPlan({x:0,y:0,width:16384,height:16384},variant),/budget-exceeded/);
 const bad=pair(10);bad.distorted.pixels[0]=255;bad.distorted.pixels[1]=255;assert.throws(()=>measureSsim(bad,variant),/ssim.sample/);
});
test('imported SSIM geometry/constants/coverage/window counts/grid/ranking cannot be forged structurally',()=>{
 const request={...pair(),spatial:{blockWidth:16,blockHeight:16}},s=measureSsim(request,variant),psnr=measurePsnr(request);
 const changes=[(v:any)=>v.variant='gaussian',(v:any)=>v.window.c1++,(v:any)=>v.planes.u.coverage.height-=8,(v:any)=>v.planes.v.windows++,
 (v:any)=>v.aggregate.score=.99,(v:any)=>v.spatial.blocks[0].roi.x=2,(v:any)=>v.spatial.worst.reverse(),(v:any)=>v.work.sampleVisits++];
 for(const mutate of changes){const bad=structuredClone(s);mutate(bad);assert.throws(()=>validateSsim(bad,psnr));}
});

test('varied non-multiple window dimensions retain BigInt reference and semantic object order',()=>{
 for(const depth of [8,10] as const)for(let i=0;i<24;i++){
  const width=16+2*(i%13),height=16+2*(i%9),[a,b]=referencePattern(depth,width,height),reference=frame(depth,{width,height}),distorted=frame(depth,{width,height});reference.pixels.set(a);distorted.pixels.set(b);
  const request={domain:'source-yuv-code-values' as const,reference,distorted,roi:{x:0,y:0,width,height}},s=measureSsim(request,variant);near(s.aggregate.score,ssimOracle(a,b,depth,width,height,request.roi).all);
  const reordered=structuredClone(s);reordered.roi={height,width,y:0,x:0};validateSsim(reordered,measurePsnr(request));
 }
});
test('maximum admitted 4096x2304 10-bit pair and 64 blocks have finite exact equality and bounded scratch',()=>{
 const reference=frame(10,{width:4096,height:2304,value:()=>1023}),request={domain:'source-yuv-code-values' as const,reference,distorted:reference,roi:{x:0,y:0,width:4096,height:2304},spatial:{blockWidth:512,blockHeight:288}};
 const s=measureSsim(request,variant);assert.equal(s.aggregate.score,1);assert.equal(s.spatial!.blocks.length,64);assert.ok(s.spatial!.blocks.every(b=>b.aggregate.score===1));assert.deepEqual(s.spatial!.worst,[0,1,2,3,4,5,6,7]);assert.equal(s.work.scratchBytes,65536);assert.ok(s.work.sampleVisits<=33_554_432&&s.work.windows<=2_097_152);
});
