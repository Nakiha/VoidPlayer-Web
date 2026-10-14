import type {TsPacketReader} from './ts-packet-source.ts';
import {parseTsPacketIndex} from './ts-packet-index.ts';
import {parseMatroskaPacketIndex} from './matroska-packet-index.ts';
import type {JsPacketIndex} from './matroska-packet-index.ts';
import {isSealedJsIndex,sealJsIndex} from './js-index-proof.ts';
import {MediaOpenError} from './media-errors.ts';
import {abortableWait} from './media-abort.ts';

export const JS_PACKET_CACHE_DATABASE='voidplayer-js-packet-index-v1';
const maximumBytes=64*1024*1024;
const request=<T>(req:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
const completed=(tx:IDBTransaction)=>new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error??new Error('Index cache transaction aborted'));});
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
async function database(){
  if(typeof indexedDB==='undefined'||!globalThis.crypto?.subtle)return;
  const req=indexedDB.open(JS_PACKET_CACHE_DATABASE,1);req.onupgradeneeded=()=>{for(const name of ['indexes','keys','entries'])req.result.createObjectStore(name);};
  return request(req);
}
async function key(db:IDBDatabase){
  const candidate=await crypto.subtle.generateKey({name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const tx=db.transaction('keys','readwrite'),done=completed(tx),store=tx.objectStore('keys');
  let stored=await request(store.get('complete-scan')) as CryptoKey|undefined;
  if(!stored){stored=candidate;store.put(stored,'complete-scan');}await done;return stored;
}
export function parseJsPacketIndex(value:unknown,version:string,size:number){return parseTsPacketIndex(value,version,size)??parseMatroskaPacketIndex(value,version,size);}
const cacheKey=(version:string,format:'ts'|'matroska')=>`${format}:${version}`;
/** Only a completed parser can write. HMAC authority is a separately persisted
 * non-extractable key; editing payload/completeness/checksum cannot mint a new
 * complete-scan receipt. Loading verifies schema/build/source/content identity. */
export async function saveLocalJsIndex(index:JsPacketIndex){
  if(!isSealedJsIndex(index)||!index.sourceVersion.startsWith('local-js-v1:'))return;
  let db:IDBDatabase|undefined;
  try{const payload=JSON.stringify(index);if(payload.length>maximumBytes)return;db=await database();if(!db)return;
    const mac=await crypto.subtle.sign('HMAC',await key(db),new TextEncoder().encode(payload)),id=cacheKey(index.sourceVersion,index.kind==='js-ts-packets'?'ts':'matroska');
    const tx=db.transaction(['indexes','entries'],'readwrite'),done=completed(tx),entries=tx.objectStore('entries'),indexes=tx.objectStore('indexes');
    const current=await request(entries.getAll()) as {id:string;bytes:number;at:number}[];
    let total=payload.length;const previous=current.filter(e=>e.id!==id).sort((a,b)=>b.at-a.at);let count=1;
    for(const e of previous){if(++count>32||total+e.bytes>256*1024*1024){entries.delete(e.id);indexes.delete(e.id);}else total+=e.bytes;}
    indexes.put({payload,mac},id);entries.put({id,bytes:payload.length,at:Date.now()},id);await done;
  }catch{/* Optional local storage failures keep the independently scanned JS path. */}finally{db?.close();}
}
export async function loadLocalJsIndex(reader:TsPacketReader,version:string,format:'ts'|'matroska',signal:AbortSignal,identityAlreadyVerified=false){
  if(!version.startsWith('local-js-v1:'))return;
  let db:IDBDatabase|undefined;
  try{
    if(!identityAlreadyVerified&&await localJsSourceVersion(reader,signal)!==version)throw new MediaOpenError('input','JS source changed before index reuse');
    signal.throwIfAborted();db=await database();if(!db)return;
    const id=cacheKey(version,format),tx=db.transaction('indexes'),record=await request(tx.objectStore('indexes').get(id));
    if(!record)return;
    if(typeof record.payload!=='string'||record.payload.length>maximumBytes||!(record.mac instanceof ArrayBuffer)
      ||!await crypto.subtle.verify('HMAC',await key(db),record.mac,new TextEncoder().encode(record.payload)))return;
    signal.throwIfAborted();const parsed=parseJsPacketIndex(JSON.parse(record.payload),version,reader.size);
    if(!parsed||(parsed.kind==='js-ts-packets')!==(format==='ts'))return;
    return sealJsIndex(parsed);
  }catch(error){signal.throwIfAborted();if(error instanceof MediaOpenError)throw error;return;}finally{db?.close();}
}
