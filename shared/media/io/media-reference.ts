import type { MediaInfo } from '../types.ts';
import { LibraryAccessError } from './source-access.ts';

/** Add actions/query parameters without corrupting a version-pinned media URL. */
export function mediaActionUrl(source: string, action: 'metadata' | 'location' | 'reveal' | 'download', base: string) {
  const url = new URL(source, base);
  url.hash = '';
  if (action === 'download') url.searchParams.set('download', '1');
  else {
    url.pathname = url.pathname.replace(/\/content$/, '');
    if (action !== 'metadata') url.pathname += `/${action}`;
    else url.searchParams.delete('v');
    url.searchParams.delete('download');
  }
  return url.href;
}
export function referenceVersion(url?: string) {
  if (!url) return undefined;
  try { return new URL(url, 'http://localhost').searchParams.get('v') || undefined; } catch { return undefined; }
}

/** Resolve a stable asset, then verify the exact content revision saved by the caller. */
export async function pinLibraryReference(info: MediaInfo, base: string, request: typeof fetch = fetch, signal?: AbortSignal) {
  if (!info.source) throw new Error('缺少媒体库引用。');
  const original = new URL(info.source.url, base), version = referenceVersion(original.href);
  if (!/^\/api\/media\/[0-9a-f]{24}\/content$/.test(original.pathname) || !version || !/^[0-9a-f]{24}$/.test(version))
    throw new LibraryAccessError('changed',info.name,'媒体库引用需要固定版本的内容链接。');
  const response = await request(mediaActionUrl(original.href,'metadata',base), {
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),cache:'no-store',
  }).catch(error => {if (signal?.aborted) throw error;throw new LibraryAccessError('unavailable',info.name);});
  if (response.status === 404) throw new LibraryAccessError('missing',info.name,'',response.status);
  if (!response.ok) throw new LibraryAccessError('unavailable',info.name,'',response.status);
  const entry = await response.json() as MediaInfo & {version?:string;state?:string};
  if (entry?.id !== info.source.id || entry.version !== version || entry.size !== info.size)
    throw new LibraryAccessError('changed',info.name,'媒体身份或内容版本已发生变化。');
  if (entry.state === 'missing') throw new LibraryAccessError('missing',info.name);
  if (entry.state !== 'ready') throw new Error(`片源 ${info.name} 仍在写入，请稍后重试。`);
  original.searchParams.delete('download'); original.hash = '';
  return {kind:'library' as const,id:entry.id,url:original.href,mtimeChanged:false};
}
