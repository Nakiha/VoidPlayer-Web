import type {TsPacketReader} from './ts-packet-source.ts';
import {parseTsPacketIndex} from './ts-packet-index.ts';
import {parseMatroskaPacketIndex} from './matroska-packet-index.ts';
import type {JsPacketIndex} from './matroska-packet-index.ts';
import {isSealedJsIndex,sealJsIndex} from './js-index-proof.ts';
import {MediaOpenError} from './media-errors.ts';
import {abortableWait,abortableLoad} from './media-abort.ts';

export const JS_PACKET_CACHE_DATABASE='voidplayer-js-packet-index-v1';
const maximumBytes=64*1024*1024;
const request=<T>(req:IDBRequest<T>,signal?:AbortSignal)=>abortableWait(new Promise<T>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}),signal);
const completed=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error??new Error('Index cache transaction aborted'));});
function transaction(db:IDBDatabase,stores:string|string[],mode:IDBTransactionMode,signal?:AbortSignal){
  signal?.throwIfAborted();const tx=db.transaction(stores,mode);
  const abort=()=>{try{tx.abort();}catch{/* Already completed/aborted. */}};
  const settled=completed(tx).finally(()=>signal?.removeEventListener('abort',abort));
  signal?.addEventListener('abort',abort,{once:true});
  const done=abortableWait(settled,signal);
  // A request can reject before its caller reaches await done. The operation
  // still owns and observes the transaction's eventual completion/abort.
  void done.catch(()=>{});return {tx,done};
}
const hex=(bytes:ArrayBuffer)=>[...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');
/** Bounded-memory content identity. Every byte contributes; file name/mtime or
 * a few sampled ranges cannot authorize exact reuse of an immutable Blob. */
export async function localJsSourceVersion(reader:Pick<TsPacketReader,'size'|'read'>,signal:AbortSignal,onRead?:(bytes:number)=>void){
  const chunks:Uint8Array[]=[];
  if(!Number.isSafeInteger(reader.size)||reader.size<=0||reader.size>1024**4)throw new MediaOpenError('resource','JS content identity size budget');
  for(let at=0;at<reader.size;at+=1024*1024){signal.throwIfAborted();const n=Math.min(1024*1024,reader.size-at),bytes=await abortableWait(reader.read(at,n),signal);signal.throwIfAborted();if(bytes.length!==n)throw new MediaOpenError('input','Short JS identity read');chunks.push(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>)));onRead?.(at+n);}
  const roots=new Uint8Array(chunks.length*32);chunks.forEach((chunk,i)=>roots.set(chunk,i*32));
  const digest=hex(await crypto.subtle.digest('SHA-256',roots));signal.throwIfAborted();return `local-js-v1:${reader.size}:${digest}`;
}
async function database(signal?:AbortSignal){
  signal?.throwIfAborted();
  if(typeof indexedDB==='undefined'||!globalThis.crypto?.subtle)return;
  const req=indexedDB.open(JS_PACKET_CACHE_DATABASE,1);req.onupgradeneeded=()=>{if(signal?.aborted){req.transaction?.abort();return;}for(const name of ['indexes','keys','entries'])req.result.createObjectStore(name);};
  // IDBOpenDBRequest has no abort API. A result arriving after cancellation
  // must release its connection rather than start another cache operation.
  return abortableLoad(request(req),signal,db=>db.close());
}
async function key(db:IDBDatabase,signal?:AbortSignal){
  signal?.throwIfAborted();const candidate=await abortableWait(crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign','verify']),signal);
  const {tx,done}=transaction(db,'keys','readwrite',signal),store=tx.objectStore('keys');
  let stored=await request(store.get('complete-scan'),signal) as CryptoKey|undefined;
  signal?.throwIfAborted();
  if(!stored){stored=candidate;store.put(stored,'complete-scan');}await done;return stored;
}
export function parseJsPacketIndex(value:unknown,version:string,size:number){return parseTsPacketIndex(value,version,size)??parseMatroskaPacketIndex(value,version,size);}
const cacheKey=(version:string,format:'ts'|'matroska')=>`${format}:${version}`;
/** Only a completed parser can write. HMAC authority is a separately persisted
 * non-extractable key; editing payload/completeness/checksum cannot mint a new
 * complete-scan receipt. Loading verifies schema/build/source/content identity. */
export async function saveLocalJsIndex(index:JsPacketIndex,signal?:AbortSignal){
  signal?.throwIfAborted();
  if(!isSealedJsIndex(index)||!index.sourceVersion.startsWith('local-js-v1:'))return;
  let db:IDBDatabase|undefined;
  try{const payload=JSON.stringify(index);if(payload.length>maximumBytes)return;db=await database(signal);if(!db)return;
    const mac=await abortableWait(crypto.subtle.sign('HMAC',await key(db,signal),new TextEncoder().encode(payload)),signal),id=cacheKey(index.sourceVersion,index.kind==='js-ts-packets'?'ts':'matroska');
    const {tx,done}=transaction(db,['indexes','entries'],'readwrite',signal),entries=tx.objectStore('entries'),indexes=tx.objectStore('indexes');
    const current=await request(entries.getAll(),signal) as {id:string;bytes:number;at:number}[];
    signal?.throwIfAborted();
    let total=payload.length;const previous=current.filter(e=>e.id!==id).sort((a,b)=>b.at-a.at);let count=1;
    for(const e of previous){if(++count>32||total+e.bytes>256*1024*1024){entries.delete(e.id);indexes.delete(e.id);}else total+=e.bytes;}
    indexes.put({payload,mac},id);entries.put({id,bytes:payload.length,at:Date.now()},id);await done;
  }catch{signal?.throwIfAborted();/* Optional local storage failures keep the independently scanned JS path. */}finally{db?.close();}
}
export async function loadLocalJsIndex(reader:TsPacketReader,version:string,format:'ts'|'matroska',signal:AbortSignal,identityAlreadyVerified=false){
  if(!version.startsWith('local-js-v1:'))return;
  let db:IDBDatabase|undefined;
  try{
    if(!identityAlreadyVerified&&await localJsSourceVersion(reader,signal)!==version)throw new MediaOpenError('input','JS source changed before index reuse');
    signal.throwIfAborted();db=await database(signal);if(!db)return;
    const id=cacheKey(version,format),{tx,done}=transaction(db,'indexes','readonly',signal),record=await request(tx.objectStore('indexes').get(id),signal);await done;
    if(!record)return;
    if(typeof record.payload!=='string'||record.payload.length>maximumBytes||!(record.mac instanceof ArrayBuffer)
      ||!await abortableWait(crypto.subtle.verify('HMAC',await key(db,signal),record.mac,new TextEncoder().encode(record.payload)),signal))return;
    signal.throwIfAborted();const parsed=parseJsPacketIndex(JSON.parse(record.payload),version,reader.size);
    if(!parsed||(parsed.kind==='js-ts-packets')!==(format==='ts'))return;
    return sealJsIndex(parsed);
  }catch(error){signal.throwIfAborted();if(error instanceof MediaOpenError)throw error;return;}finally{db?.close();}
}
