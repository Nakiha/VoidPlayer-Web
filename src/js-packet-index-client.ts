import {MediaIndexClient} from './media-index-client.ts';
import {JS_TS_MEDIA_INDEX_IDENTITY,JS_MATROSKA_MEDIA_INDEX_IDENTITY} from './media-index-identity.ts';
import {parseJsPacketIndex} from './js-packet-index-cache.ts';
import {sealJsIndex} from './js-index-proof.ts';
import {MediaOpenError} from './media-errors.ts';
import {onLoadAbort} from './media-abort.ts';
import type {MediaIndexScanProgress} from './media-index-types.ts';
/** Authority is this authenticated, source/version-bound server endpoint. Raw
 * snapshots received from arbitrary callers never get this runtime proof. */
export async function loadServerJsIndex(url:string,version:string,size:number,format:'ts'|'matroska',signal:AbortSignal,progress?:(p:MediaIndexScanProgress)=>void){
  const identity=format==='ts'?JS_TS_MEDIA_INDEX_IDENTITY:JS_MATROSKA_MEDIA_INDEX_IDENTITY;
  const client=new MediaIndexClient(url,identity.kind,64*1024*1024+1024,120000,true,identity,progress),detach=onLoadAbort(signal,()=>client.close());
  try{if(!client.hasEndpoint)return;signal.throwIfAborted();const value=await client.read();signal.throwIfAborted();const index=parseJsPacketIndex(value,version,size);
    if(!index||(index.kind==='js-ts-packets')!==(format==='ts'))throw new MediaOpenError('input','Server JS packet index unavailable or source/build mismatch; container fallback forbidden');
    return sealJsIndex(index);
  }finally{detach();client.close();}
}
