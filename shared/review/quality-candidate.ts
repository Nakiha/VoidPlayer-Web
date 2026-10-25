import { qualityEvidenceValue } from './quality-evidence.ts';
import type { QualityEvidence } from './quality-evidence.ts';
import type { AnnotationDocument } from './annotation-record.ts';
import type { Mark, MediaInfo } from './model.ts';

/** Only the host-resolved immutable result supplies source/clock/ROI facts.
 * Text and severity are explicit caller input, never inferred from a score. */
export function qualityCandidateDocument(id:string,input:{text:string;severity:number},evidence:QualityEvidence,
  actor:NonNullable<Mark['author']>,now:string,origin:'human'|'agent'):AnnotationDocument {
  const value=qualityEvidenceValue(evidence.value),r=value.result,context=value.annotationContext;
  if(!context)throw new Error('This older result has no recorded annotation context; use an explicit legacy annotation or a new measurement.');
  const primary=evidence.ref.side,other=primary==='reference'?'distorted':'reference';
  const media:MediaInfo[]=(['reference','distorted']as const).map(side=>{
    const p=r.provenance[side],a=context[side],d=p.decoded.description;
    return {id:`quality-${side}`,name:a.name,size:p.size,lastModified:a.lastModified,codec:a.codec,decoder:'ffmpeg-wasm',
      width:d.width,height:d.height,firstPtsUs:a.firstPtsUs,durationUs:a.indexedDurationUs,
      source:{kind:'library',id:p.mediaId,url:`${evidence.serviceOrigin}/api/media/${p.mediaId}?v=${p.mediaVersion}`}};
  });
  const frame=(side:typeof primary)=>({ptsUs:r.provenance[side].sourcePtsUs-context[side].firstPtsUs,
    sourcePtsUs:r.provenance[side].sourcePtsUs,durationUs:context[side].frameDurationUs});
  const d=r.provenance[primary].decoded.description,roi=r.metric.roi;
  return {media,mark:{id,text:input.text.trim(),severity:input.severity,origin,createdAt:now,author:{...actor},slot:'H',
    mediaId:`quality-${primary}`,frame:frame(primary),comparison:[{slot:'G',mediaId:`quality-${other}`,frame:frame(other)}],
    region:{left:roi.x/d.width,top:roi.y/d.height,width:roi.width/d.width,height:roi.height/d.height},resolved:false,
    qualityCandidate:{schema:'voidplayer-quality-candidate',version:1,assessment:'not-subjectively-assessed'}}};
}
