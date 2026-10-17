import {encodeBase64} from './ffmpeg-index-cache.ts';
import type {FfmpegIndexMetadata} from './ffmpeg-index-cache.ts';
/** In-band NAL bytes captured during the existing metadata scan. Prefixes are
 * normalized to Annex-B; this is explicitly not a container avcC record. */
export function ffmpegAnalysisConfiguration(core: any, heap: () => Uint8Array, ctx: number): FfmpegIndexMetadata['analysisConfiguration'] {
  if(typeof core._vp_identity_config_bytes!=='function')return undefined;
  const size=core._vp_identity_config_bytes(ctx),ptr=core._vp_identity_config(ctx);
  if(!size)return undefined;
  if(size<1 || size>8200 || ptr<1 || ptr+size>heap().length)throw new Error('Invalid captured codec configuration');
  return {framing:'annexb',source:'in-band-nal',data:encodeBase64(heap().slice(ptr,ptr+size))};
}
