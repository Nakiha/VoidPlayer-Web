import { PsnrError, psnrGridPlan, validateSourcePlanePair } from './psnr.ts';
import type { PsnrRequest, PsnrRoi, PsnrColor } from './psnr.ts';

/** FFmpeg's approximation, NOT Gaussian-window Wang SSIM; F64 evaluation. */
export const SSIM_VARIANT = 'ffmpeg-uniform-8x8-step4-v1' as const;
export const SSIM_LIMITS = Object.freeze({minRoiDimension:16,maxSampleVisits:33_554_432,maxWindows:2_097_152,maxScratchBytes:262144});
export type SsimRequest = {variant:typeof SSIM_VARIANT};
export type SsimPlane = {score:number; windows:number; /** Absolute visible-luma coordinates, including for U/V. */ coverage:PsnrRoi};
export type SsimScore = {planes:{y:SsimPlane;u:SsimPlane;v:SsimPlane}; aggregate:{score:number;weighting:'y4-u1-v1-plane-mean'}};
export type SsimBlock = SsimScore & {index:number;roi:PsnrRoi};
export type SsimResult = SsimScore & {
  schema:'voidplayer-source-plane-ssim';version:1;implementation:'cpu-f64-ffmpeg-uniform-v1';variant:typeof SSIM_VARIANT;
  domain:'source-yuv-code-values';geometry:'unrotated-visible-pixel-grid';roi:PsnrRoi;bitDepth:8|10;peak:255|1023;color:PsnrColor;
  window:{size:8;step:4;weight:'uniform';border:'valid-truncate-to-4';c1:number;c2:number};
  spatial?:{schema:'voidplayer-ssim-block-grid';version:1;partition:'roi-anchored-disjoint-even-grid';
    ranking:'aggregate-score-asc-row-major-ties';blockWidth:number;blockHeight:number;columns:number;rows:number;blocks:SsimBlock[];worst:number[]};
  work:{sampleVisits:number;windows:number;scratchBytes:number};
};
function fail(field:string):never {throw new PsnrError('invalid-input',`ssim.${field}`);}
export function ssimConstants(peak:number) {return {c1:Math.floor(.01*.01*peak*peak*64+.5),c2:Math.floor(.03*.03*peak*peak*64*63+.5)};}
export function ssimPlanePlan(roi:PsnrRoi, component:number) {
  const divisor=component?2:1,columns=Math.floor(roi.width/divisor/4),rows=Math.floor(roi.height/divisor/4);
  return {columns,rows,windows:(columns-1)*(rows-1),coverage:{x:roi.x,y:roi.y,width:columns*4*divisor,height:rows*4*divisor}};
}
/** Pure admission, shared by HTTP/GUI/kernel, before any decoding or durable submission. */
export function ssimPlan(roi:PsnrRoi, request:SsimRequest, spatial?:PsnrRequest['spatial']) {
  if(!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).join(',')!=='variant' || request.variant!==SSIM_VARIANT)fail('variant');
  if(!roi || ![roi.x,roi.y,roi.width,roi.height].every(n=>Number.isSafeInteger(n)&&n>=0&&n%2===0)
    || roi.width<16 || roi.height<16 || roi.x+roi.width>16384 || roi.y+roi.height>16384)fail('roi-minimum-16');
  const grid=spatial===undefined?undefined:psnrGridPlan(roi,spatial);
  const regions=[roi,...(grid?.blocks??[])];
  if(regions.some(r=>r.width<16||r.height<16))fail('block-minimum-16');
  let sampleVisits=0,windows=0,scratchBytes=0;
  for(const r of regions)for(let c=0;c<3;c++) {
    const p=ssimPlanePlan(r,c);sampleVisits+=p.columns*p.rows*16;windows+=p.windows;
    scratchBytes=Math.max(scratchBytes,p.columns*4*2*8);
  }
  if(sampleVisits>SSIM_LIMITS.maxSampleVisits||windows>SSIM_LIMITS.maxWindows||scratchBytes>SSIM_LIMITS.maxScratchBytes)
    throw new PsnrError('budget-exceeded','ssim.work');
  return {grid,work:{sampleVisits,windows,scratchBytes}};
}
export function rankSsimBlocks(blocks:SsimBlock[]) {return blocks.map(b=>b.index).sort((a,b)=>blocks[a].aggregate.score-blocks[b].aggregate.score||a-b).slice(0,8);}

/** Two 4x4 tile rows, no full-frame allocation. Only complete valid windows enter the mean. */
export function measureSsim(request:PsnrRequest, options:SsimRequest):SsimResult {
  const {a,b,r}=validateSourcePlanePair(request),plan=ssimPlan(r,options,request.spatial);
  const bitDepth=a.layout.bitDepth as 8|10,peak=bitDepth===8?255:1023,bytes=bitDepth===8?1:2;
  const constants=ssimConstants(peak);
  function score(roi:PsnrRoi):SsimScore {
    const values:SsimPlane[]=[];
    for(let c=0;c<3;c++) {
      const p=ssimPlanePlan(roi,c),divisor=c?2:1;
      let previous=new Float64Array(p.columns*4),current=new Float64Array(p.columns*4),sum=0;
      const ap=a.layout.planes[c],bp=b.layout.planes[c];
      const ax=(a.description.visibleRect.x+roi.x)/divisor,ay=(a.description.visibleRect.y+roi.y)/divisor;
      const bx=(b.description.visibleRect.x+roi.x)/divisor,by=(b.description.visibleRect.y+roi.y)/divisor;
      for(let ty=0;ty<p.rows;ty++) {
        current.fill(0);
        for(let tx=0;tx<p.columns;tx++)for(let y=0;y<4;y++) {
          let ai=ap.offset+(ay+ty*4+y)*ap.stride+(ax+tx*4)*bytes,bi=bp.offset+(by+ty*4+y)*bp.stride+(bx+tx*4)*bytes;
          for(let x=0;x<4;x++,ai+=bytes,bi+=bytes) {
            const av=request.reference.pixels[ai]+(bytes===2?request.reference.pixels[ai+1]*256:0);
            const bv=request.distorted.pixels[bi]+(bytes===2?request.distorted.pixels[bi+1]*256:0);
            if(av>peak||bv>peak)fail('sample');
            const at=tx*4;current[at]+=av;current[at+1]+=bv;current[at+2]+=av*av+bv*bv;current[at+3]+=av*bv;
          }
        }
        if(ty)for(let tx=1;tx<p.columns;tx++) {
          const left=(tx-1)*4,right=tx*4;
          const x=previous[left]+previous[right]+current[left]+current[right];
          const y=previous[left+1]+previous[right+1]+current[left+1]+current[right+1];
          const squares=previous[left+2]+previous[right+2]+current[left+2]+current[right+2];
          const product=previous[left+3]+previous[right+3]+current[left+3]+current[right+3];
          sum+=((2*x*y+constants.c1)*(2*(64*product-x*y)+constants.c2))
            /((x*x+y*y+constants.c1)*(64*squares-x*x-y*y+constants.c2));
        }
        [previous,current]=[current,previous];
      }
      values.push({score:sum/p.windows,windows:p.windows,coverage:p.coverage});
    }
    return {planes:{y:values[0],u:values[1],v:values[2]},aggregate:{score:(values[0].score*4+values[1].score+values[2].score)/6,weighting:'y4-u1-v1-plane-mean'}};
  }
  const spatial=plan.grid?(()=>{
    const blocks=plan.grid!.blocks.map((roi,index)=>({index,roi,...score(roi)}));
    return {schema:'voidplayer-ssim-block-grid' as const,version:1 as const,partition:'roi-anchored-disjoint-even-grid' as const,
      ranking:'aggregate-score-asc-row-major-ties' as const,...request.spatial!,columns:plan.grid!.columns,rows:plan.grid!.rows,blocks,worst:rankSsimBlocks(blocks)};
  })():undefined;
  return {schema:'voidplayer-source-plane-ssim',version:1,implementation:'cpu-f64-ffmpeg-uniform-v1',variant:SSIM_VARIANT,
    domain:request.domain,geometry:'unrotated-visible-pixel-grid',roi:{...r},bitDepth,peak,color:{...a.color},
    window:{size:8,step:4,weight:'uniform',border:'valid-truncate-to-4',...constants},...score(r),...(spatial?{spatial}:{}),work:plan.work};
}
