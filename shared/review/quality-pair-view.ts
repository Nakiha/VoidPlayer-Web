import { requireInspectionGeometry } from '../analysis/quality/frame-pair.ts';
import type { HevcGeometry } from '../media/codecs/hevc-geometry.ts';
import { qualityEvidenceList } from './quality-evidence.ts';
import type { QualityEvidence } from './quality-evidence.ts';
import type { SourceBinding } from '../analysis/quality/frame-pair.ts';
import type { InspectedFramePair } from '../analysis/quality/frame-pair.ts';
import type { PresentedFrameToken } from '../analysis/bitstream/contract.ts';
import type { FrameDescription } from '../media/frame-description.ts';
import { mediaIndexIdentityKey } from '../media/indexing/media-index-identity.ts';
import { validateDescription } from '../media/frame-description.ts';

export function qualityFactKey(value:unknown):string {
  return JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
}
export const PAIR_VIEW_SIDES = ['reference','distorted'] as const;
export type PairViewPresentation = Pick<PresentedFrameToken,'commit'|'picture'|'sourcePtsUs'|'geometry'> & {sourceBinding:SourceBinding;sourceGeometry:HevcGeometry};
export type PairViewSide = typeof PAIR_VIEW_SIDES[number];
export type PairViewReference = {space:string;annotationId:string;evidenceId:string};
export function pairViewReference(input:PairViewReference):PairViewReference {
  if(!input || ![input.space,input.annotationId,input.evidenceId].every(v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(v)))throw new Error('Invalid shared evidence reference.');
  return {space:input.space,annotationId:input.annotationId,evidenceId:input.evidenceId};
}
/** No probing, job reads or local-session dependency; GUI and Agent use this URL. */
export function qualityPairViewUrl(input:PairViewReference,origin:string) {
  const r=pairViewReference(input),url=new URL('/quality.html',origin);
  url.search=new URLSearchParams(r).toString();return url.href;
}
/** No crop/SAR/rotation inference. FLV closed-AU inspection has no container
 * rotation transform, and v1 accepts only the identity visible-pixel geometry. */
export function requirePairViewGeometry(d:FrameDescription,rotation=0) {
  validateDescription(d);
  const r=d.visibleRect;
  if(rotation!==0||r.x!==0||r.y!==0||r.width!==d.width||r.height!==d.height||d.codedWidth!==d.width||d.codedHeight!==d.height||d.displayWidth!==d.width||d.displayHeight!==d.height)
    throw new Error('This viewer requires an uncropped, square-pixel, unrotated frame; crop/SAR/rotation is unsupported.');
}
function verifySourceGeometry(g:HevcGeometry,d:FrameDescription) {
  requireInspectionGeometry(g);
  if(g.codedWidth!==d.codedWidth||g.codedHeight!==d.codedHeight||g.width!==d.width||g.height!==d.height||g.x!==d.visibleRect.x||g.y!==d.visibleRect.y)throw new Error('Exact SPS geometry differs from the decoded frame.');
}
export function pairViewEvidence(input:QualityEvidence,origin:string):QualityEvidence {
  const evidence=qualityEvidenceList([input],true)[0];
  if(evidence.serviceOrigin!==origin||evidence.verification!=='server-verified')throw new Error('Only evidence confirmed by this originating shared service can open original frames. Historical copies retain facts only.');
  for(const side of PAIR_VIEW_SIDES)requirePairViewGeometry(evidence.value.result.provenance[side].decoded.description);
  return evidence;
}
/** A different decoder, output geometry/color/storage or packet is not the
 * original measurement's reproducible frame, even when its PTS happens to match. */
export function verifyInspectedPair(evidence:QualityEvidence,pair:InspectedFramePair) {
  if(qualityFactKey(pair.decoder)!==qualityFactKey(evidence.value.result.decoder))throw new Error('Original decoder build is unavailable.');
  for(const [i,side] of PAIR_VIEW_SIDES.entries()) {
    const expected=evidence.value.result.provenance[side],actual=pair.provenance[side],frame=pair.frames[i];
    verifySourceGeometry(pair.sourceGeometry?.[side],frame.description);
    requirePairViewGeometry(frame.description);
    if(qualityFactKey(actual)!==qualityFactKey(expected)||frame.pts!==expected.sourcePtsUs||qualityFactKey(frame.description)!==qualityFactKey(expected.decoded.description))
      throw new Error('Original packet, frame identity or decoded geometry/color changed.');
  }
}
export function verifyPairViewPresentation(evidence:QualityEvidence,side:PairViewSide,token:PairViewPresentation|null) {
  const p=evidence.value.result.provenance[side],d=p.decoded.description,b=token?.sourceBinding;
  if(!token||!b||!token.picture||qualityFactKey(token.picture)!==qualityFactKey(p.picture)||token.sourcePtsUs!==p.sourcePtsUs
    ||b.mediaId!==p.mediaId||b.mediaVersion!==p.mediaVersion||b.size!==p.size||b.indexBuildId!==p.indexBuildId
    ||mediaIndexIdentityKey(b.indexIdentity)!==mediaIndexIdentityKey(p.indexIdentity))throw new Error('Presented frame lacks the original source/cache/picture binding.');
  verifySourceGeometry(token.sourceGeometry,d);
  requirePairViewGeometry({...d,...token.geometry},token.geometry.rotation);
  if(qualityFactKey(token.geometry)!==qualityFactKey({codedWidth:d.codedWidth,codedHeight:d.codedHeight,visibleRect:d.visibleRect,displayWidth:d.displayWidth,displayHeight:d.displayHeight,rotation:0}))throw new Error('Presented geometry differs from the original measurement.');
}
