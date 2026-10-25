import { avcGeometry } from '../../media/codecs/avc-geometry.ts';
import { hevcGeometry, hevcFieldPictures } from '../../media/codecs/hevc-geometry.ts';
import { parseFlvIndex, type FlvIndexDocument } from '../../media/indexing/flv-index-cache.ts';
import { FramePairError, PAIR_LIMITS, requireInspectionGeometry, type PairTarget } from './frame-pair.ts';
import type { LibraryPairBinding } from './library-pair.ts';

export const QUALITY_SELECTION_LIMITS = Object.freeze({page:50, inspected:2048, bytes:65536});
export type QualityFrameQuery = {afterAu:number;limit:number;buildId?:string};
export type QualityFramePage = {
  schema:'voidplayer-psnr-frame-candidates';version:1;source:LibraryPairBinding;
  codec:'h264'|'hevc';geometry:{width:number;height:number;codedWidth:number;codedHeight:number;sarNum:number;sarDen:number;sarSpecified:boolean};
  inspection:{supported:boolean;reason:string|null};
  eligibility:'container-key-candidate-execution-verifies-closed-au-and-pixels';
  entries:PairTarget[];nextAu:number|null;inspected:number;
};
export function qualityFrameQuery(query:QualityFrameQuery) {
  if(!Number.isSafeInteger(query.afterAu)||query.afterAu<0||query.afterAu>PAIR_LIMITS.maxIndexPackets
    ||!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>QUALITY_SELECTION_LIMITS.page
    ||(query.afterAu>0&&!query.buildId)||query.buildId!==undefined&&!/^[a-zA-Z0-9._-]{1,128}$/.test(query.buildId))
    throw new FramePairError('invalid-request','Invalid bounded PSNR frame query; pagination requires its original build ID');
  return query;
}
/** Cached facts, not a decoder/preflight. Never infer correspondence, closed
 * random access, color completeness or decoded-picture identity from a key flag. */
export function qualityFrameCandidates(source:LibraryPairBinding,doc:FlvIndexDocument,query:QualityFrameQuery):QualityFramePage {
  qualityFrameQuery(query);
  if(query.buildId&&query.buildId!==source.binding.indexBuildId)throw new FramePairError('identity-mismatch','Quality cache changed during frame selection');
  if(!doc||!Array.isArray(doc.packets))throw new FramePairError('invalid-request','Invalid quality cache document');
  if(doc.packets.length>PAIR_LIMITS.maxIndexPackets||JSON.stringify(doc).length>PAIR_LIMITS.maxIndexBytes)
    throw new FramePairError('budget-exceeded','PSNR selection cache budget exceeded');
  if(doc.configurations||doc.truncatedAt!==undefined||doc.recoveredGaps)
    throw new FramePairError('unsupported-source','PSNR selection requires a complete single-configuration unrecovered FLV cache');
  const index=parseFlvIndex(doc,source.binding.size);
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
    if(!p.key||(p.configuration??0)!==0||counts.get(p.pts)!==1||p.size>PAIR_LIMITS.maxPacketBytes)continue;
    entries.push({...structuredClone(source.binding),sourcePtsUs:p.pts,picture:{sourceVersion:`${source.binding.mediaId}@${source.binding.mediaVersion}`,
      stream:'video',configuration:0,au,picture:0,layer:0,field:'frame'}});
  }
  const page:QualityFramePage={schema:'voidplayer-psnr-frame-candidates',version:1,source:structuredClone(source),codec:index.codec,
    geometry:{width:g.width,height:g.height,codedWidth:g.codedWidth,codedHeight:g.codedHeight,sarNum:g.sarNum,sarDen:g.sarDen,sarSpecified:g.sarSpecified===true},inspection,
    eligibility:'container-key-candidate-execution-verifies-closed-au-and-pixels',entries,nextAu:au<index.packets.length?au:null,inspected};
  if(JSON.stringify(page).length>QUALITY_SELECTION_LIMITS.bytes)throw new FramePairError('budget-exceeded','PSNR selection response budget exceeded');
  return page;
}
