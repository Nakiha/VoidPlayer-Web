import type {LibraryIndexReference} from '../../../shared/media/io/library-reference-types.ts';
export type {LibraryIndexReference} from '../../../shared/media/io/library-reference-types.ts';
import {MediaOpenError} from '../../../shared/media/io/media-errors.ts';

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
    ||!/^[0-9a-f]{24}$/.test(reference.id)||!reference.version||source.pathname!==`/api/media/${reference.id}/content`
    ||source.searchParams.get('v')!==reference.version||version!==`${reference.id}@${reference.version}`)
    throw new MediaOpenError('input','JS index authority is not the application library source');
  source.pathname=source.pathname.replace(/\/content$/, '');
  const response=await fetch(source,{cache:'no-store',credentials:'same-origin',redirect:'error',signal});
  if(!response.ok||new URL(response.url).origin!==origin)throw new MediaOpenError('input','Library source metadata unavailable');
  const metadata=await response.json();signal.throwIfAborted();
  if(metadata.id!==reference.id||metadata.version!==reference.version||metadata.size!==size||metadata.state!=='ready')
    throw new MediaOpenError('input','Library source metadata or version changed');
}

/** Media URLs on this service stay server-indexed when reopened from a saved workspace. */
export function libraryIndexReferenceFromUrl(url: string): LibraryIndexReference | undefined {
  const origin = globalThis.location?.origin;
  if (!origin) return;
  const source = new URL(url, origin), id = /^\/api\/media\/([0-9a-f]{24})\/content$/.exec(source.pathname)?.[1], version = source.searchParams.get('v');
  if (!id) return;
  if (source.origin !== origin || !version || source.username || source.password)
    throw new MediaOpenError('input', '媒体库播放需要当前服务提供的版本化链接。');
  return ownLibraryIndexReference(id, version);
}

export async function loadLibraryPlaybackContainer(url: string, size: number, reference: LibraryIndexReference, signal?: AbortSignal) {
  const own = libraryIndexReferenceFromUrl(url);
  if (!own || own.id !== reference.id || own.version !== reference.version || own.origin !== reference.origin)
    throw new MediaOpenError('input', '媒体库播放引用无效。');
  const source = new URL(url, own.origin);
  source.pathname = source.pathname.replace(/\/content$/, '/container');
  const response = await fetch(source, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal });
  if (!response.ok) throw new MediaOpenError('input', `服务端媒体识别失败（${response.status}）。`);
  const value = await response.json();
  const container: import('../../../shared/media/containers/container-header.ts').ContainerKind = value.container;
  if (value.id !== own.id || value.version !== own.version || value.size !== size
    || !['flv', 'isobmff', 'mpegts', 'matroska', 'other'].includes(container))
    throw new MediaOpenError('input', '服务端媒体信息与当前版本不一致。');
  return container;
}
