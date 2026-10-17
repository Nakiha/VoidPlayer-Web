import type {LibraryIndexReference} from '../shared/media/io/library-reference-types.ts';
export type {LibraryIndexReference} from '../shared/media/io/library-reference-types.ts';
import {MediaOpenError} from '../shared/media/io/media-errors.ts';

/** A reference carried only by the library loading path. Its fields are not
 * proof: each consumer verifies the application's own origin and metadata. */

export function ownLibraryIndexReference(id:string,version:string):LibraryIndexReference {
  const origin=globalThis.location?.origin;
  if(!origin||!/^https?:$/.test(new URL(origin).protocol)||!/^[0-9a-f]{24}$/.test(id)||!version)
    throw new MediaOpenError('input','A verified application library source is required');
  return {origin,id,version};
}
export async function verifyLibraryIndexReference(url:string,version:string,size:number,reference:LibraryIndexReference,signal:AbortSignal){
  signal.throwIfAborted();
  const origin=globalThis.location?.origin,source=new URL(url,globalThis.location?.href);
  if(!origin||reference.origin!==origin||source.origin!==origin||source.username||source.password
    ||!/^[0-9a-f]{24}$/.test(reference.id)||!reference.version||source.pathname!==`/api/media/${reference.id}`
    ||source.searchParams.get('v')!==reference.version||version!==`${reference.id}@${reference.version}`)
    throw new MediaOpenError('input','JS index authority is not the application library source');
  source.pathname+='/metadata';
  const response=await fetch(source,{cache:'no-store',credentials:'same-origin',redirect:'error',signal});
  if(!response.ok||new URL(response.url).origin!==origin)throw new MediaOpenError('input','Library source metadata unavailable');
  const metadata=await response.json();signal.throwIfAborted();
  if(metadata.id!==reference.id||metadata.version!==reference.version||metadata.size!==size||metadata.state!=='ready')
    throw new MediaOpenError('input','Library source metadata or version changed');
}
