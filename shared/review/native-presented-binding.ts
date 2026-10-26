import {nativeLibraryTransport} from './native-presented-frame.ts';
import type {NativePresentedFrame} from './native-presented-frame.ts';
import type {QualityFramePage} from '../analysis/quality/selection.ts';
import {FramePairError,pairBudget,type PairTarget} from '../analysis/quality/frame-pair.ts';
import {FLV_MEDIA_INDEX_IDENTITY,mediaIndexIdentityKey} from '../media/indexing/media-index-identity.ts';
/** Join an explicitly captured successful presentation to an existing trusted
 * cache. Only the selected AU is considered; clocks are consistency checks,
 * never a cache search or cross-source correspondence rule. */
export function bindNativePresentedFrame(frame:NativePresentedFrame,page:QualityFramePage,expectedOrigin:string):PairTarget {
  const fail=(message:string):never=>{throw new FramePairError('identity-mismatch',message);};
  const b=page?.source?.binding,producer=page?.source?.producer,p=frame?.input;
  if(frame?.schema!=='voidplayer-native-presented-input'||frame.version!==1||frame.binding!=='unbound'
    ||!frame.instance||!Number.isSafeInteger(frame.commit)||frame.commit<1||!Number.isSafeInteger(frame.sourceGeneration)||frame.sourceGeneration<1
    ||p?.protocol!=='webcodecs-associated-chunk-v1'||!Number.isSafeInteger(p.epoch)||p.epoch<1
    ||page?.schema!=='voidplayer-psnr-frame-candidates'||page.version!==1||!b||!producer
    ||frame.source?.kind!=='library'||frame.source.id!==b.mediaId||frame.sourceVersion!==`${b.mediaId}@${b.mediaVersion}`
    ||producer.producer!=='server-flv-scan-v1'||producer.sourceVersion!==frame.sourceVersion||producer.size!==b.size
    ||mediaIndexIdentityKey(b.indexIdentity)!==mediaIndexIdentityKey(FLV_MEDIA_INDEX_IDENTITY))fail('Presented source/cache identity differs');
  const transport=nativeLibraryTransport(frame.source.url,{origin:expectedOrigin,id:b.mediaId,version:b.mediaVersion},expectedOrigin);
  if(!transport||transport.sourceVersion!==frame.sourceVersion)fail('Presented transport is not the version-locked application library source');
  const d=frame.geometry,g=page.geometry;
  if(!page.inspection?.supported||!g||g.sarSpecified!==true||!Number.isSafeInteger(g.sarNum)||!Number.isSafeInteger(g.sarDen)||g.sarNum!==g.sarDen||g.sarNum<1
    // A native resource can have allocation padding outside its exact visible
    // rectangle (e.g. Chromium 96x66 for an uncropped 96x64 SPS). This does not
    // change source geometry or ROI coordinates; missing pixels still reject.
    ||!d||d.rotation!==0||d.visibleRect.x!==0||d.visibleRect.y!==0||d.codedWidth<g.codedWidth||d.codedHeight<g.codedHeight
    ||d.visibleRect.width!==g.width||d.visibleRect.height!==g.height||d.displayWidth!==g.width||d.displayHeight!==g.height)
    fail('Presented geometry cannot be joined without guessing crop, SAR or rotation');
  const witness=page.presentedInput;
  if(!witness||witness.protocol!==p.protocol||witness.configurationHex!==p.configurationHex)
    return fail('Decoder configuration differs from the cached source');
  const selected=page.entries.filter(t=>t.picture.au===p.au),packets=witness.packets.filter(w=>w.au===p.au);
  if(selected.length!==1||packets.length!==1)fail('Exact presented AU is unavailable or ineligible');
  const target=selected[0],w=packets[0];
  if(['au','configuration','offset','size','pts','dts'].some(key=>p[key as keyof typeof w]!==w[key as keyof typeof w])
    ||target.sourcePtsUs!==p.pts||target.picture.configuration!==p.configuration
    ||target.mediaId!==b.mediaId||target.mediaVersion!==b.mediaVersion||target.indexBuildId!==b.indexBuildId
    ||target.size!==b.size||mediaIndexIdentityKey(target.indexIdentity)!==mediaIndexIdentityKey(b.indexIdentity))
    fail('Presented input does not match the exact cached packet');
  pairBudget({pairing:'caller-specified',reference:target,distorted:target,roi:{x:0,y:0,width:2,height:2}});
  return structuredClone(target);
}
