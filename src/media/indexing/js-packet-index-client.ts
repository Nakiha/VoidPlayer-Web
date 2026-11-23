import {MediaIndexClient} from './media-index-client.ts';
import type { JsPacketFormat } from '../../../shared/media/containers/matroska-packet-index.ts';
import { JS_PACKET_IDENTITIES, jsPacketIndexIdentity } from '../../../shared/media/indexing/media-index-identity.ts';
import { parseJsPacketIndex } from '../../../shared/media/indexing/js-packet-index-parser.ts';
import {sealJsIndex} from '../../../shared/media/indexing/js-index-proof.ts';
import {MediaOpenError} from '../../../shared/media/io/media-errors.ts';
import {onLoadAbort} from '../../../shared/media/io/media-abort.ts';
import type {MediaIndexScanProgress} from '../../../shared/media/indexing/media-index-types.ts';
import {TsCombinationNotMigrated} from '../../../shared/media/containers/ts-packet-source.ts';
import { libraryIndexReferenceFromUrl } from './library-index-reference.ts';
import { type LibraryIndexReference } from '../../../shared/media/io/library-reference-types.ts';
/** Authority is this authenticated, source/version-bound server endpoint. Raw
 * snapshots received from arbitrary callers never get this runtime proof. */
export async function loadServerJsIndex(url:string,version:string,size:number,format:JsPacketFormat,signal:AbortSignal,progress?:(p:MediaIndexScanProgress)=>void,reference?:LibraryIndexReference){
  signal.throwIfAborted();if(!reference)return;
  const own = libraryIndexReferenceFromUrl(url);
  if (!own || own.origin !== reference.origin || own.id !== reference.id || own.version !== reference.version
    || version !== `${own.id}@${own.version}` || !Number.isSafeInteger(size) || size <= 0)
    throw new MediaOpenError('input','JS index authority is not the application library source');
  // The versioned index route resolves the ready file. Its document binds the source version and byte size below.
  const identity = JS_PACKET_IDENTITIES[format];
  const client=new MediaIndexClient(url,identity.kind,64*1024*1024+1024,120000,true,identity,progress),detach=onLoadAbort(signal,()=>client.close());
  try{if(!client.hasEndpoint)return;signal.throwIfAborted();const value=await client.read();signal.throwIfAborted();
    if(!value&&client.failureReason?.code==='js-combination-not-migrated')throw new TsCombinationNotMigrated(client.failureReason.message);
    const index=parseJsPacketIndex(value,version,size);
    if(!index||jsPacketIndexIdentity(index) !== identity)throw new MediaOpenError('input','Server JS packet index unavailable or source/build mismatch; container fallback forbidden');
    return sealJsIndex(index);
  }finally{detach();client.close();}
}
