import { AdminError } from '../../admin-error.ts';
import { PAIR_LIMITS, pairBudget } from '../../../shared/analysis/quality/frame-pair.ts';
import type { FramePairRequest } from '../../../shared/analysis/quality/frame-pair.ts';

export function qualityKeys(value:unknown,allowed:string[]) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))
    throw new AdminError(400,'Unknown or invalid quality request fields.','invalid-request');
}
export function libraryPairRequest(value:unknown):FramePairRequest {
  qualityKeys(value,['pairing','reference','distorted','roi','spatial','ssim','budget']);const request=value as FramePairRequest;
  for(const target of [request.reference,request.distorted]){
    qualityKeys(target,['mediaId','mediaVersion','size','indexIdentity','indexBuildId','picture','sourcePtsUs','decode']);
    if(target.decode!==undefined)qualityKeys(target.decode,['mode','startAu']);
    qualityKeys(target.picture,['sourceVersion','stream','configuration','au','picture','layer','field']);
    qualityKeys(target.indexIdentity,['kind','streamKey','schemaVersion','indexerBuild']);
  }
  qualityKeys(request.roi,['x','y','width','height']);
  if(request.budget!==undefined)qualityKeys(request.budget,[...Object.keys(PAIR_LIMITS),'maxSamples','maxInputBytes']);
  pairBudget(request);return request;
}

