import {analysisIndexIdentity} from './products.ts';
import type {ProductIndexIdentity} from './products.ts';
import { groupAnalysisGops, viewportAnalysisGops } from './stream.ts';
import type { AnalysisPacket } from './types.ts';
import type { AnalysisStreamTarget, AnalysisGop } from './contract.ts';
import { validateStream } from './contract.ts';
export interface DemandPlan {
  sourceVersion:string; buildId:string; indexIdentity:ProductIndexIdentity; firstPtsUs:number;
  groups:(AnalysisGop & {ptsMin:number;ptsMax:number;dtsMin:number|null;dtsMax:number|null})[];
  selected: number[];
  times:[number,number,number|null][];
}
/** Exact packet clocks for selected GOPs, conservative exclusion bounds for
 * every other GOP. Oversized plans simply do not enable request coalescing. */
export function makeDemandPlan(packets:readonly AnalysisPacket[],target:AnalysisStreamTarget,buildId:string):DemandPlan|null {
  if (!target.window) return null;
  const groups=groupAnalysisGops(packets), selected=viewportAnalysisGops(packets,target.firstPtsUs,target.window).map(g=>g.startAu), set=new Set(selected);
  if(groups.length>2048 || groups.reduce((n,g)=>n+(set.has(g.startAu)?g.endAu-g.startAu:0),0)>8192) return null;
  const plan:DemandPlan={sourceVersion:target.sourceVersion,buildId,indexIdentity:analysisIndexIdentity(target.indexIdentity),firstPtsUs:target.firstPtsUs,selected,times:[],groups:[]};
  for(const group of groups) {
    let ptsMin=Infinity,ptsMax=-Infinity,dtsMin=Infinity,dtsMax=-Infinity;
    for(let au=group.startAu;au<group.endAu;au++) {const p=packets[au];ptsMin=Math.min(ptsMin,p.pts);ptsMax=Math.max(ptsMax,p.pts);if(p.dts!==null){dtsMin=Math.min(dtsMin,p.dts);dtsMax=Math.max(dtsMax,p.dts);}if(set.has(group.startAu))plan.times.push([au,p.pts,p.dts]);}
    plan.groups.push({...group,ptsMin,ptsMax,dtsMin:Number.isFinite(dtsMin)?dtsMin:null,dtsMax:Number.isFinite(dtsMax)?dtsMax:null});
  }
  if(JSON.stringify(plan).length>256*1024)return null;
  return plan;
}
export function validateDemandPlan(plan:DemandPlan,target:AnalysisStreamTarget) {
  validateStream(target);
  if(!plan || plan.sourceVersion!==target.sourceVersion || plan.firstPtsUs!==target.firstPtsUs || typeof plan.buildId!=='string' || !plan.buildId || plan.buildId.length>128 || JSON.stringify(plan.indexIdentity)!==JSON.stringify(analysisIndexIdentity(target.indexIdentity)) || !Array.isArray(plan.groups)||plan.groups.length>2048||!Array.isArray(plan.times)||plan.times.length>8192||!Array.isArray(plan.selected)||plan.selected.length>2048)throw Error('Invalid analysis demand identity');
  let end=0;const selected=new Set(plan.selected),seen=new Set<number>();
  for(const g of plan.groups){if(![g.startAu,g.endAu,g.configuration,g.ptsMin,g.ptsMax].every(Number.isSafeInteger)||g.startAu!==end||g.endAu<=g.startAu||g.endAu>250000||g.configuration<0||g.configuration>255||g.ptsMax<g.ptsMin||(g.dtsMin!==null&&!Number.isSafeInteger(g.dtsMin))||(g.dtsMax!==null&&!Number.isSafeInteger(g.dtsMax)))throw Error('Invalid demand GOP');end=g.endAu;}
  if(selected.size!==plan.selected.length||plan.selected.some(au=>!plan.groups.some(g=>g.startAu===au)))throw Error('Invalid demand selection');
  for(const row of plan.times){if(!Array.isArray(row)||row.length!==3||!Number.isSafeInteger(row[0])||!Number.isSafeInteger(row[1])||(row[2]!==null&&!Number.isSafeInteger(row[2]))||seen.has(row[0])||!plan.groups.some(g=>selected.has(g.startAu)&&row[0]>=g.startAu&&row[0]<g.endAu))throw Error('Invalid demand clocks');seen.add(row[0]);}
  if(plan.groups.reduce((n,g)=>n+(selected.has(g.startAu)?g.endAu-g.startAu:0),0)!==seen.size)throw Error('Incomplete demand clock coverage');
}
export function demandKey(plan:DemandPlan,window:NonNullable<AnalysisStreamTarget['window']>):string|null {
  const start=window.startUs+plan.firstPtsUs,end=window.endUs+plan.firstPtsUs,original=new Set(plan.selected),selected=new Set<number>();
  for(const g of plan.groups){if(original.has(g.startAu))continue;const min=window.axis==='pts'?g.ptsMin:g.dtsMin,max=window.axis==='pts'?g.ptsMax:g.dtsMax;if(min!==null&&max!==null&&min<end&&max>=start)return null;}
  for(const [au,pts,dts] of plan.times){const time=window.axis==='pts'?pts:dts;if(time!==null&&time>=start&&time<end){const g=plan.groups.find(g=>au>=g.startAu&&au<g.endAu)!;selected.add(g.startAu);}}
  return selected.size?JSON.stringify([...selected].sort((a,b)=>a-b)):null;
}
