import type {NativePictureIdentity} from '../media/codecs/native-picture-identity.ts';
import type {PresentedFrameToken} from '../analysis/bitstream/contract.ts';
/** Local successful presentation evidence. This is deliberately NOT PairTarget:
 * a trusted current cache namespace/build must be joined explicitly. */
export interface NativePresentedFrame {
  schema:'voidplayer-native-presented-input';version:1;binding:'unbound';
  slot:string;instance:string;sourceGeneration:number;commit:number;
  source:{kind:'library';id:string;url:string};sourceVersion:string;
  input:NativePictureIdentity;geometry:PresentedFrameToken['geometry'];
}

/** Canonical version-locked same-service transport, never a lineage label.
 * The caller supplies the actual input URL and independently retained library
 * reference at open time. This performs no network or cache lookup. */
export function nativeLibraryTransport(url:string,reference:import('../media/io/library-reference-types.ts').LibraryIndexReference,expectedOrigin:string) {
  try {
    const source=new URL(url,expectedOrigin),origin=new URL(expectedOrigin).origin;
    if(!/^https?:$/.test(source.protocol)||reference.origin!==origin||source.origin!==origin
      ||source.username||source.password||source.hash||!/^[0-9a-f]{24}$/.test(reference.id)
      ||!/^[0-9a-f]{24}$/.test(reference.version)||source.pathname!==`/api/media/${reference.id}`
      ||source.searchParams.getAll('v').length!==1||source.searchParams.get('v')!==reference.version
      ||[...source.searchParams.keys()].some(key=>key!=='v'))return;
    return {source:{kind:'library' as const,id:reference.id,url:source.href},sourceVersion:`${reference.id}@${reference.version}`};
  }catch{return;}
}
