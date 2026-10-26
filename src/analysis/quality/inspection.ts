import { inspectFramePair, FramePairError, PAIR_LIMITS } from '../../../shared/analysis/quality/frame-pair.ts';
import type { CachedPairSource, FramePairRequest } from '../../../shared/analysis/quality/frame-pair.ts';
import type {QualityIndexDocument} from '../../../shared/analysis/quality/source-index.ts';
import type { LibraryPairBinding } from '../../../shared/analysis/quality/library-pair.ts';
import type { QualityEvidence } from '../../../shared/review/quality-evidence.ts';
import { PAIR_VIEW_SIDES, pairViewEvidence, qualityFactKey, verifyInspectedPair } from '../../../shared/review/quality-pair-view.ts';
import { RangeReader } from '../../../shared/media/io/range-reader.ts';
import { coreAssetUrl } from '../../media/decoding/core-url.ts';
import { openPairDecoder } from './wasm-decoder.ts';

async function json(url:string,limit:number,signal:AbortSignal,actor?:string):Promise<any> {
  const response=await fetch(url,{signal,cache:'no-store',headers:actor?{'x-voidplayer-actor':actor}:{}});
  if(!response.ok){await response.body?.cancel();throw new FramePairError('source-changed',`Original source/cache is unavailable (HTTP ${response.status})`);}
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty inspection response');
  const chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw new FramePairError('budget-exceeded','Inspection response byte budget exceeded');chunks.push(next.value);}}
  finally {await reader.cancel();reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
/** Runs only in the admitted killable one-shot Worker. GETs only; no build=1,
 * POST, job lookup or score call. Source/cache proof is checked again at publication. */
export async function inspectLibraryEvidence(input:QualityEvidence,base:string,signal:AbortSignal) {
  if(!globalThis.crypto?.subtle)throw new FramePairError('unsupported-source','Original-frame inspection requires HTTPS or localhost for cache digest verification');
  const origin=new URL(base).origin,evidence=pairViewEvidence(input,origin),expected=evidence.value;
  const pair=await inspectLibrarySelection({pairing:'caller-specified',reference:expected.result.provenance.reference,distorted:expected.result.provenance.distorted,roi:expected.result.metric.roi},[expected.sources.reference,expected.sources.distorted],base,signal);
  verifyInspectedPair(evidence,pair);return pair;
}
/** Explicit caller-selected AU targets. Does not accept ordinary playback PTS as identity. */
export async function inspectLibrarySelection(request:FramePairRequest,bindings:[LibraryPairBinding,LibraryPairBinding],base:string,signal:AbortSignal,actor?:string){
  if(!globalThis.crypto?.subtle)throw new FramePairError('unsupported-source','Source inspection requires HTTPS or localhost');
  const origin=new URL(base).origin,expected={sources:{reference:bindings[0],distorted:bindings[1]}};
  const sources:CachedPairSource<QualityIndexDocument>[]=[];
  const sourceUrl=(side:typeof PAIR_VIEW_SIDES[number])=>new URL(`/api/media/${expected.sources[side].binding.mediaId}`,origin);
  const proof=async(side:typeof PAIR_VIEW_SIDES[number])=>{
    const url=sourceUrl(side);url.pathname+='/psnr-source';url.searchParams.set('v',expected.sources[side].binding.mediaVersion);
    const current=await json(url.href,16384,signal,actor) as LibraryPairBinding;
    if(qualityFactKey(current)!==qualityFactKey(expected.sources[side]))throw new FramePairError('identity-mismatch','Original source version, index namespace/build or producer evidence changed');
    return current;
  };
  try {
    for(const side of PAIR_VIEW_SIDES) {
      const current=await proof(side),url=sourceUrl(side);url.searchParams.set('v',current.binding.mediaVersion);
      const indexUrl=new URL(url);indexUrl.pathname+='/frame-index';
      const identity=current.binding.indexIdentity;
      for(const [key,value] of Object.entries({kind:identity.kind,stream:identity.streamKey,schema:String(identity.schemaVersion),indexer:identity.indexerBuild}))indexUrl.searchParams.set(key,value);
      const document=await json(indexUrl.href,PAIR_LIMITS.maxIndexBytes+1024,signal,actor);
      if(document.epoch!==current.producer.epoch||!document.index)throw new FramePairError('cache-miss','Original cached index is unavailable');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(document.index)))),b=>b.toString(16).padStart(2,'0')).join('');
      if(digest!==current.producer.documentSha256)throw new FramePairError('identity-mismatch','Cached index differs from the original producer document');
      const reader=new RangeReader({url:url.href,size:current.binding.size});
      sources.push({digest:async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes))),b=>b.toString(16).padStart(2,'0')).join(''),binding:()=>structuredClone(current.binding),index:document.index,read:(offset,length)=>reader.readMetadata(offset,length),close:()=>reader.close()});
    }
    const pair=await inspectFramePair(request,[sources[0],sources[1]],budget=>openPairDecoder(coreAssetUrl('vendor/voidplayer-core/voidplayer-core.js',base),undefined,budget.maxHeapBytes),signal);
    for(const side of PAIR_VIEW_SIDES)await proof(side);
    signal.throwIfAborted();return pair;
  } finally {for(const source of sources)source.close();}
}
