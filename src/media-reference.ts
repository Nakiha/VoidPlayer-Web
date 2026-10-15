import type { MediaInfo } from './model.ts';
import { describeMediaMismatch, matchMediaIdentity } from './media-identity.ts';
import { LibraryAccessError } from './source-access.ts';

/** Add actions/query parameters without corrupting a version-pinned media URL. */
export function mediaActionUrl(source: string, action: 'metadata' | 'location' | 'reveal' | 'download', base: string) {
  const url = new URL(source, base);
  url.hash = '';
  if (action === 'download') url.searchParams.set('download', '1');
  else { url.pathname += `/${action}`; url.searchParams.delete('download'); }
  return url.href;
}
export function referenceVersion(url?: string) {
  if (!url) return undefined;
  try { return new URL(url, 'http://localhost').searchParams.get('v') || undefined; } catch { return undefined; }
}

/** Migrate legacy references only after matching their recorded file metadata.
 * Identity is (basename, size); a bare lastModified drift is accepted with a
 * warning flag instead of failing. The pinned byte request validates again
 * after opening the actual file. */
export async function pinLibraryReference(info: MediaInfo, base: string, request: typeof fetch = fetch, signal?: AbortSignal) {
  if (!info.source) throw new Error('缺少媒体库引用。');
  const original = new URL(info.source.url, base);
  const response = await request(mediaActionUrl(original.href, 'metadata', base), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: 'no-store' }).catch(error => { if (signal?.aborted) throw error; throw new LibraryAccessError('unavailable', info.name); });
  if (response.status === 404) throw new LibraryAccessError('missing', info.name, '', response.status);
  if (!response.ok) throw new LibraryAccessError('unavailable', info.name, '', response.status);
  const entry = await response.json();
  if (!entry || typeof entry.id !== 'string' || !/^[0-9a-f]{24}$/.test(entry.id) || typeof entry.version !== 'string' || !/^[0-9a-f]{24}$/.test(entry.version)) throw new Error('片源服务缺少版本信息，请升级服务后重试。');
  const match = matchMediaIdentity(info, { name: entry.name ?? info.name, size: entry.size, lastModified: entry.lastModified });
  if (!match.ok) throw new LibraryAccessError('changed', info.name, describeMediaMismatch(info.name, match.mismatches));
  if (entry.state === 'missing') throw new LibraryAccessError('missing', info.name);
  if (entry.state !== 'ready') throw new Error(`片源 ${info.name} 仍在写入，请稍后重试。`);
  original.pathname = original.pathname.replace(/[^/]+$/, entry.id);
  original.searchParams.delete('download'); original.searchParams.set('v', entry.version); original.hash = '';
  return { kind: 'library' as const, id: entry.id, url: original.href, mtimeChanged: match.mtimeChanged };
}
