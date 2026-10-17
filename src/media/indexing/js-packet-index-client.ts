import {MediaIndexClient} from './media-index-client.ts';
import {JS_TS_MEDIA_INDEX_IDENTITY,JS_MATROSKA_MEDIA_INDEX_IDENTITY} from '../../../shared/media/indexing/media-index-identity.ts';
import { parseJsPacketIndex } from '../../../shared/media/indexing/js-packet-index-parser.ts';
import {sealJsIndex} from '../../../shared/media/indexing/js-index-proof.ts';
import {MediaOpenError} from '../../../shared/media/io/media-errors.ts';
import {onLoadAbort} from '../../../shared/media/io/media-abort.ts';
import type {MediaIndexScanProgress} from '../../../shared/media/indexing/media-index-types.ts';
import {TsCombinationNotMigrated} from '../../../shared/media/containers/ts-packet-source.ts';
import { verifyLibraryIndexReference } from './library-index-reference.ts';
import { type LibraryIndexReference } from '../../../shared/media/io/library-reference-types.ts';
/** Authority is this authenticated, source/version-bound server endpoint. Raw
 * snapshots received from arbitrary callers never get this runtime proof. */
export async function loadServerJsIndex(url:string,version:string,size:number,format:'ts'|'matroska',signal:AbortSignal,progress?:(p:MediaIndexScanProgress)=>void,reference?:LibraryIndexReference){
  signal.throwIfAborted();if(!reference)return;
  await verifyLibraryIndexReference(url,version,size,reference,signal);
  const identity=format==='ts'?JS_TS_MEDIA_INDEX_IDENTITY:JS_MATROSKA_MEDIA_INDEX_IDENTITY;
  const client=new MediaIndexClient(url,identity.kind,64*1024*1024+1024,120000,true,identity,progress),detach=onLoadAbort(signal,()=>client.close());
  try{if(!client.hasEndpoint)return;signal.throwIfAborted();const value=await client.read();signal.throwIfAborted();
    if(!value&&client.failureReason?.code==='js-combination-not-migrated')throw new TsCombinationNotMigrated(client.failureReason.message);
    const index=parseJsPacketIndex(value,version,size);
    if(!index||(index.kind==='js-ts-packets')!==(format==='ts'))throw new MediaOpenError('input','Server JS packet index unavailable or source/build mismatch; container fallback forbidden');
    return sealJsIndex(index);
  }finally{detach();client.close();}
}
