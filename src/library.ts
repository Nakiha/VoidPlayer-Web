import type { MediaSource, MediaOpenProgress } from './media.ts';
import { openMediaFromUrl } from './media.ts';
import { contextLog } from './log.ts';

// Client side of the optional media-library service (browser/server/). The app
// works without it: when no service answers, the library is simply unavailable.

export interface LibraryEntry {
  id: string;
  name: string;
  root: string;
  size: number;
  lastModified: number;
  version?: string;
  state?: string;
  rootId?: string;
}

export function mediaUrl(id: string, version?: string): string {
  return `/api/media/${encodeURIComponent(id)}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
}

export async function openLibraryItem(entry: LibraryEntry, onProgress?: MediaOpenProgress): Promise<MediaSource> {
  if (entry.state && entry.state !== 'ready') throw new Error(entry.state === 'pending' ? '片源仍在写入，请稍后重试。' : '片源已从媒体库移除。');
  contextLog().info('media', '从媒体库载入', { id: entry.id, name: entry.name, root: entry.root, size: entry.size });
  const source = await openMediaFromUrl(mediaUrl(entry.id, entry.version), entry, undefined, onProgress);
  source.info.source = { kind: 'library', id: entry.id, url: mediaUrl(entry.id, entry.version) };
  return source;
}

export interface LibraryRoot { id: string; name: string; state: string; error: string | null; scannedAt: number | null }
export interface LibraryPage {
  entries: LibraryEntry[];
  directories: { rootId: string; path: string; name: string }[];
  roots: LibraryRoot[];
  total: number; offset: number; limit: number; nextOffset: number | null; revision: number;
  ready: boolean; scanning: boolean;
  job: { id: number; state: string; visited: number; files: number; errors: number; current_path: string | null } | null;
}
export interface LibraryQuery { root?: string; directory?: string; search?: string; recursive?: boolean; offset?: number; revision?: number; limit?: number }
export class LibraryChangedError extends Error {}
export async function fetchLibraryPage(query: LibraryQuery, signal?: AbortSignal): Promise<LibraryPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, typeof value === 'boolean' ? value ? '1' : '0' : String(value));
  const response = await fetch(`/api/library/browse?${params}`, { cache: 'no-store', signal });
  if (response.status === 409) throw new LibraryChangedError('媒体库已更新，已返回第一页');
  if (!response.ok) throw new Error(response.status === 404 ? '媒体服务需要升级，才能使用目录浏览' : '媒体库未连接，仍可添加本地文件');
  return response.json();
}
export async function fetchLibraryItem(id: string, signal?: AbortSignal): Promise<LibraryEntry | null> {
  const response = await fetch(`${mediaUrl(id)}/metadata`, { cache: 'no-store', signal });
  return response.ok ? response.json() : null;
}
export async function requestLibraryScan(action: 'refresh' | 'cancel') {
  const response = await fetch(`/api/library/scan?action=${action}`, { method: 'POST', headers: { 'x-voidplayer-action': 'scan' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('无法操作媒体扫描，请检查服务连接。');
}
