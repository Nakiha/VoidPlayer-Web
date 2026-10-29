import { avcGeometry } from '../../media/codecs/avc-geometry.ts';
import { hevcGeometry, hevcFieldPictures } from '../../media/codecs/hevc-geometry.ts';
import {qualitySourceIndex,isMp4QualityDocument,qualityIndexPacketCount} from './source-index.ts';
import type {QualityIndexDocument,QualityVideoIndex} from './source-index.ts';
import { FramePairError, PAIR_LIMITS, forwardPacketPlan, gopPacketPlan, FORWARD_PAIR_LIMITS, requireInspectionGeometry, type PairTarget } from './frame-pair.ts';
import type {FlvIndex} from '../../media/containers/flv-demux.ts';
import type { LibraryPairBinding } from './library-pair.ts';
import {nativeConfigurationHex} from '../../media/codecs/native-picture-identity.ts';

export const QUALITY_SELECTION_LIMITS = Object.freeze({page:50, inspected:2048, bytes:65536});
export type QualityFrameQuery = {afterAu:number;limit:number;buildId?:string};
export type QualityFramePage = {
  schema:'voidplayer-psnr-frame-candidates';version:1;source:LibraryPairBinding;
  codec:'h264'|'hevc';geometry:{width:number;height:number;codedWidth:number;codedHeight:number;sarNum:number;sarDen:number;sarSpecified:boolean};
  inspection:{supported:boolean;reason:string|null};
  eligibility:'cached-au-candidate-execution-verifies-closed-start-and-output-identity';
  entries:PairTarget[];nextAu:number|null;inspected:number;
  presentedInput?:{protocol:'webcodecs-associated-chunk-v1';configurationHex:string;
    packets:{au:number;configuration:number;offset:number;size:number;pts:number;dts:number}[]};
};
export function qualityFrameQuery(query:QualityFrameQuery) {
  if(!Number.isSafeInteger(query.afterAu)||query.afterAu<0||query.afterAu>PAIR_LIMITS.maxIndexPackets
    ||!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>QUALITY_SELECTION_LIMITS.page
    ||(query.afterAu>0&&!query.buildId)||query.buildId!==undefined&&!/^[a-zA-Z0-9._-]{1,128}$/.test(query.buildId))
    throw new FramePairError('invalid-request','Invalid bounded PSNR frame query; pagination requires its original build ID');
  return query;
}
/** Reuse cached-window admission without dropping the caller's raw AU fact. */
export function qualityTargetForAu(source:LibraryPairBinding,index:QualityVideoIndex,au:number,counts:Map<number,number>):{target:PairTarget|null;reason:string|null}{
  const p=index.packets[au];
  if(!p||(p.configuration??0)!==0||counts.get(p.pts)!==1||p.size>PAIR_LIMITS.maxPacketBytes)return {target:null,reason:'AU configuration, unique PTS or packet budget unsupported'};
    const target:PairTarget={...structuredClone(source.binding),sourcePtsUs:p.pts,picture:{sourceVersion:`${source.binding.mediaId}@${source.binding.mediaVersion}`,
      stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}};
    let startAu=au;for(;startAu>0&&!index.packets[startAu].key&&au-startAu+1<=FORWARD_PAIR_LIMITS.packetsPerSide;startAu--){/* bounded cached scan */}
    let endAu=startAu;while(endAu+1<index.packets.length&&!index.packets[endAu+1].key&&endAu-startAu+1<=FORWARD_PAIR_LIMITS.packetsPerSide)endAu++;
    // Equal PTS/DTS says nothing about decoder buffering. Prefer explicit
    // token attribution for every complete bounded GOP, even with zero CTS.
    if(endAu-startAu+1<=FORWARD_PAIR_LIMITS.packetsPerSide){
      target.decode={mode:'packet-identity-gop-v1',startAu,endAu};
      try{const plan=gopPacketPlan(index,target,counts);if(plan.some(p=>p.size>PAIR_LIMITS.maxPacketBytes)||plan.reduce((n,p)=>n+p.size+(index.mp4?0:23),0)>PAIR_LIMITS.maxReadBytes)return {target:null,reason:'Dependency packet/read budget or unsupported decode window'};}
      catch(error){if(error instanceof FramePairError&&['unsupported-source','invalid-request'].includes(error.code)){if(p.key&&!index.mp4)delete target.decode;else return {target:null,reason:'Dependency packet/read budget or unsupported decode window'};}else throw error;}
    }else if(index.mp4)return {target:null,reason:'MP4 complete GOP exceeds the packet identity window budget'};
    else if(!p.key){
      if(startAu<0||au-startAu+1>FORWARD_PAIR_LIMITS.packetsPerSide)return {target:null,reason:'Dependency packet/read budget or unsupported decode window'};
      target.decode={mode:'forward-one-output-per-au-v1',startAu};
      try{const plan=forwardPacketPlan(index,target,counts);if(plan.some(p=>p.size>PAIR_LIMITS.maxPacketBytes)||plan.reduce((n,p)=>n+p.size+(index.mp4?0:23),0)>PAIR_LIMITS.maxReadBytes)return {target:null,reason:'Dependency packet/read budget or unsupported decode window'};}
      catch(error){if(error instanceof FramePairError&&error.code==='unsupported-source')return {target:null,reason:'Dependency packet/read budget or unsupported decode window'};throw error;}
    }
  return {target,reason:null};
}

/** Cached facts, not a decoder/preflight. Never infer correspondence, closed
 * random access, color completeness or decoded-picture identity from a key flag. */
export function qualityFrameCandidates(source:LibraryPairBinding,doc:QualityIndexDocument,query:QualityFrameQuery):QualityFramePage {
  qualityFrameQuery(query);
  if(query.buildId&&query.buildId!==source.binding.indexBuildId)throw new FramePairError('identity-mismatch','Quality cache changed during frame selection');
  if(!doc||(!isMp4QualityDocument(doc)&&!Array.isArray(doc.packets)))throw new FramePairError('invalid-request','Invalid quality cache document');
  if(qualityIndexPacketCount(doc)>PAIR_LIMITS.maxIndexPackets||JSON.stringify(doc).length>PAIR_LIMITS.maxIndexBytes)throw new FramePairError('budget-exceeded','PSNR selection cache budget exceeded');
  if(!isMp4QualityDocument(doc)&&(doc.configurations||doc.truncatedAt!==undefined||doc.recoveredGaps))throw new FramePairError('unsupported-source','PSNR selection requires a complete single-configuration unrecovered FLV cache');
  const index=qualitySourceIndex(doc,source.binding.size);
  if(index.codec!=='h264'&&index.codec!=='hevc')throw new FramePairError('unsupported-source','PSNR selection supports H.264/HEVC only');
  const g=index.codec==='h264'?avcGeometry(index.description,true):hevcGeometry(index.description,true);
  if(!g||('interlaced'in g&&g.interlaced)||(index.codec==='hevc'&&hevcFieldPictures(index.description)))
    throw new FramePairError('unsupported-source','Progressive source SPS geometry is required');
  if(g.codedWidth*g.codedHeight>PAIR_LIMITS.maxPixels)throw new FramePairError('budget-exceeded','Source geometry exceeds the PSNR pixel budget');
  let inspection:QualityFramePage['inspection']={supported:true,reason:null};
  try{requireInspectionGeometry(g);}catch(error){inspection={supported:false,reason:(error as Error).message};}
  const counts=new Map<number,number>();for(const p of index.packets)counts.set(p.pts,(counts.get(p.pts)??0)+1);
  const entries:PairTarget[]=[];let au=query.afterAu,inspected=0;
  for(;au<index.packets.length&&inspected<QUALITY_SELECTION_LIMITS.inspected&&entries.length<query.limit;au++,inspected++){
    const p=index.packets[au];
    if((p.configuration??0)!==0||counts.get(p.pts)!==1||p.size>PAIR_LIMITS.maxPacketBytes)continue;
    const {target}=qualityTargetForAu(source,index,au,counts);if(!target)continue;
    entries.push(target);
  }
  const page:QualityFramePage={schema:'voidplayer-psnr-frame-candidates',version:1,source:structuredClone(source),codec:index.codec,
    geometry:{width:g.width,height:g.height,codedWidth:g.codedWidth,codedHeight:g.codedHeight,sarNum:g.sarNum,sarDen:g.sarDen,sarSpecified:g.sarSpecified===true},inspection,
    eligibility:'cached-au-candidate-execution-verifies-closed-start-and-output-identity',entries,nextAu:au<index.packets.length?au:null,inspected};
  const configurationHex=nativeConfigurationHex(index.description);
  if(configurationHex&&!index.mp4)page.presentedInput={protocol:'webcodecs-associated-chunk-v1',configurationHex,
    packets:entries.map(target=>{const au=target.picture.au,p=index.packets[au];return {au,configuration:p.configuration??0,offset:p.offset,size:p.size,pts:p.pts,dts:p.dts};})};
  if(JSON.stringify(page).length>QUALITY_SELECTION_LIMITS.bytes)throw new FramePairError('budget-exceeded','PSNR selection response budget exceeded');
  return page;
}
