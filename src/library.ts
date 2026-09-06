import type { MediaSource } from './media.ts';
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
}

export interface LibraryListing {
  roots: string[];
  truncated: boolean;
  entries: LibraryEntry[];
}

/** Returns null when no media-library service is reachable. */
export async function fetchLibrary(refresh = false): Promise<LibraryListing | null> {
  try {
    const response = await fetch(refresh ? '/api/library?refresh=1' : '/api/library', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || !Array.isArray(body.entries)) return null;
    return body as LibraryListing;
  } catch {
    return null;
  }
}

export function mediaUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

export async function openLibraryItem(entry: LibraryEntry): Promise<MediaSource> {
  contextLog().info('media', '从媒体库载入', { id: entry.id, name: entry.name, root: entry.root, size: entry.size });
  const source = await openMediaFromUrl(mediaUrl(entry.id), entry);
  source.info.source = { kind: 'library', id: entry.id, url: mediaUrl(entry.id) };
  return source;
}
