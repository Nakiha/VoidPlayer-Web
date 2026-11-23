import type {LibraryIndexReference} from '../../../shared/media/io/library-reference-types.ts';
export type {LibraryIndexReference} from '../../../shared/media/io/library-reference-types.ts';
import {MediaOpenError} from '../../../shared/media/io/media-errors.ts';

/** A reference carried only by the library loading path. Its fields are not
 * proof: each consumer verifies the application's own origin and metadata. */

export function ownLibraryIndexReference(id:string,version:string):LibraryIndexReference {
  const origin=globalThis.location?.origin;
  if(!origin||!/^https?:$/.test(new URL(origin).protocol)||!/^[0-9a-f]{24}$/.test(id)||!/^[0-9a-f]{24}$/.test(version))
    throw new MediaOpenError('input','A verified application library source is required');
  return {origin,id,version};
}
/** Media URLs on this service stay server-indexed when reopened from a saved workspace. */
export function libraryIndexReferenceFromUrl(url: string): LibraryIndexReference | undefined {
  const origin = globalThis.location?.origin;
  if (!origin) return;
  const source = new URL(url, origin), id = /^\/api\/media\/([0-9a-f]{24})\/content$/.exec(source.pathname)?.[1], versions = source.searchParams.getAll('v');
  if (!id) return;
  if (source.origin !== origin || versions.length !== 1 || source.username || source.password)
    throw new MediaOpenError('input', '媒体库播放需要当前服务提供的版本化链接。');
  return ownLibraryIndexReference(id, versions[0]);
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
    || !['flv', 'isobmff', 'mpegts', 'matroska', 'annexb', 'other'].includes(container))
    throw new MediaOpenError('input', '服务端媒体信息与当前版本不一致。');
  return container;
}
