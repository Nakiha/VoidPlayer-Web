import { ssimPlan, ssimPlanePlan, ssimConstants, SSIM_VARIANT, rankSsimBlocks } from './ssim.ts';
import type { SsimScore, SsimResult } from './ssim.ts';
import type { PsnrResult, PsnrRoi } from './psnr.ts';
function check(v:unknown):asserts v {if(!v)throw new Error('SSIM evidence is invalid or unsupported.');}
const keys=(v:unknown,expected:string)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===expected;
function same(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();
  return ak.length===bk.length&&ak.every((k,i)=>k===bk[i]&&same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
}
const near=(a:number,b:number)=>Number.isFinite(a)&&Math.abs(a-b)<=1e-12;
/** Structure/consistency only. It cannot authenticate imported numerical claims. */
export function validateSsim(value:unknown, psnr:PsnrResult):asserts value is SsimResult {
  const s=value as SsimResult;
  check(keys(s,`aggregate,bitDepth,color,domain,geometry,implementation,peak,planes,roi,schema,${s?.spatial===undefined?'':'spatial,'}variant,version,window,work`)&&s?.schema==='voidplayer-source-plane-ssim'&&s.version===1&&s.implementation==='cpu-f64-ffmpeg-uniform-v1'&&s.variant===SSIM_VARIANT
    &&s.domain===psnr.domain&&s.geometry===psnr.geometry&&same(s.roi,psnr.roi)&&s.bitDepth===psnr.bitDepth&&s.peak===psnr.peak&&same(s.color,psnr.color));
  check(same(s.window,{size:8,step:4,weight:'uniform',border:'valid-truncate-to-4',...ssimConstants(s.peak)}));
  const grid=psnr.spatial?{blockWidth:psnr.spatial.blockWidth,blockHeight:psnr.spatial.blockHeight}:undefined;
  const plan=ssimPlan(s.roi,{variant:SSIM_VARIANT},grid);
  check(same(s.work,plan.work));
  const score=(v:SsimScore,roi:PsnrRoi)=>{
    check(keys(v?.planes,'u,v,y')&&keys(v?.aggregate,'score,weighting'));
    for(const [c,key] of (['y','u','v'] as const).entries()) {
      const p=v?.planes?.[key],expected=ssimPlanePlan(roi,c);
      check(keys(p,'coverage,score,windows')&&Number.isFinite(p.score)&&p.score>=-1&&p.score<=1&&p.windows===expected.windows&&same(p.coverage,expected.coverage));
    }
    check(v.aggregate?.weighting==='y4-u1-v1-plane-mean'&&near(v.aggregate.score,(v.planes.y.score*4+v.planes.u.score+v.planes.v.score)/6));
  };
  score(s,s.roi);
  if(!plan.grid){check(s.spatial===undefined);return;}
  const g=s.spatial;
  check(keys(g,'blockHeight,blockWidth,blocks,columns,partition,ranking,rows,schema,version,worst')&&g?.schema==='voidplayer-ssim-block-grid'&&g.version===1&&g.partition==='roi-anchored-disjoint-even-grid'&&g.ranking==='aggregate-score-asc-row-major-ties'
    &&g.blockWidth===grid!.blockWidth&&g.blockHeight===grid!.blockHeight&&g.columns===plan.grid.columns&&g.rows===plan.grid.rows
    &&Array.isArray(g.blocks)&&g.blocks.length===plan.grid.blocks.length);
  for(const [i,b] of g.blocks.entries()){check(keys(b,'aggregate,index,planes,roi')&&b.index===i&&same(b.roi,plan.grid.blocks[i]));score(b,b.roi);}
  check(same(g.worst,rankSsimBlocks(g.blocks)));
}
