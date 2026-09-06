import type { MediaInfo } from './model.ts';

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
 * The pinned byte request validates again after opening the actual file. */
export async function pinLibraryReference(info: MediaInfo, base: string, request: typeof fetch = fetch) {
  if (!info.source) throw new Error('缺少媒体库引用。');
  const original = new URL(info.source.url, base);
  const response = await request(mediaActionUrl(original.href, 'metadata', base), { signal: AbortSignal.timeout(10000), cache: 'no-store' }).catch(() => { throw new Error(`无法连接片源服务 ${original.origin}，请检查网络和服务的访问设置。`); });
  if (!response.ok) throw new Error(`片源 ${info.name} 无法打开（HTTP ${response.status}）。请检查服务连接与媒体库索引。`);
  const entry = await response.json();
  if (!entry || typeof entry.id !== 'string' || !/^[0-9a-f]{24}$/.test(entry.id) || typeof entry.version !== 'string' || !/^[0-9a-f]{24}$/.test(entry.version)) throw new Error('片源服务缺少版本信息，请升级服务后重试。');
  const version = referenceVersion(original.href);
  if (entry.size !== info.size || (version ? entry.version !== version : entry.lastModified !== info.lastModified)) throw new Error(`片源 ${info.name} 已发生变化，无法按原工作区还原。请重新选择片源并检查标注。`);
  if (entry.state !== 'ready') throw new Error(`片源 ${info.name} ${entry.state === 'pending' ? '仍在写入，请稍后重试' : '已从媒体库移除'}。`);
  original.pathname = original.pathname.replace(/[^/]+$/, entry.id);
  original.searchParams.delete('download'); original.searchParams.set('v', entry.version); original.hash = '';
  return { kind: 'library' as const, id: entry.id, url: original.href };
}
