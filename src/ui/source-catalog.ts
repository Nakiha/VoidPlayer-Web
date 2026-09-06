import type { MediaInfo } from '../model.ts';
import type { LibraryEntry } from '../library.ts';

export type RecentSource = { key: string; name: string; size: number; lastModified: number; libraryId?: string; version?: string };
export type SourceItem = RecentSource & { file?: File; library?: LibraryEntry };
const HISTORY_LIMIT = 40;
// Identity and fingerprint are both required: distinct roots must not collapse,
// and a replaced library file must not inherit access from an old history item.
export const sourceKey = (entry: { name: string; size: number; lastModified: number; version?: string }, libraryId?: string, version = entry.version) =>
  JSON.stringify([libraryId ?? null, entry.name, entry.size, entry.lastModified, version ?? null]);

/** Keeps source access separate from decoded-frame resources. History stores
 * metadata only; a past local file requires a fresh browser file selection. */
export class SourceCatalog {
  private local = new Map<string, File>();
  private library: LibraryEntry[] = [];
  private history: RecentSource[];
  private recentLibrary = new Map<string, LibraryEntry>();
  constructor(stored: unknown = []) {
    this.history = [];
    if (Array.isArray(stored)) for (const entry of stored.slice(0, HISTORY_LIMIT)) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isFinite(entry.lastModified)) continue;
      const libraryId = typeof entry.libraryId === 'string' && entry.libraryId ? entry.libraryId : undefined;
      const version = typeof entry.version === 'string' && /^[0-9a-f]{24}$/.test(entry.version) ? entry.version : undefined;
      // Recompute keys so existing v1 metadata histories migrate on read.
      const clean: RecentSource = { key: sourceKey(entry, libraryId, version), name: entry.name, size: entry.size, lastModified: entry.lastModified,
        ...(libraryId ? { libraryId } : {}), ...(version ? { version } : {}) };
      if (!this.history.some(h => h.key === clean.key)) this.history.push(clean);
    }
  }
  setLibrary(entries: LibraryEntry[]) { this.library = entries; }
  setRecentLibrary(entries: [string, LibraryEntry][]) {
    this.recentLibrary = new Map(entries);
    for (const [, entry] of entries) this.recentLibrary.set(entry.id, entry);
    const history = new Map<string, RecentSource>();
    for (const item of this.history) {
      const entry = item.libraryId && this.recentLibrary.get(item.libraryId);
      const current = entry && entry.size === item.size && entry.lastModified === item.lastModified && (!item.version || entry.version === item.version)
        ? { ...item, libraryId: entry.id, version: entry.version, key: sourceKey(entry, entry.id) } : item;
      if (!history.has(current.key)) history.set(current.key, current);
    }
    this.history = [...history.values()];
  }
  addFile(file: File) { this.local.set(sourceKey(file), file); this.remember(file); }
  remember(entry: { name: string; size: number; lastModified: number; version?: string }, libraryId?: string, version = entry.version) {
    const key = sourceKey(entry, libraryId, version);
    this.history = [{ key, name: entry.name, size: entry.size, lastModified: entry.lastModified,
      ...(libraryId ? { libraryId } : {}), ...(version ? { version } : {}) },
    ...this.history.filter(h => h.key !== key)].slice(0, HISTORY_LIMIT);
  }
  recent() { return this.history.map(h => this.resolve(h)); }
  available() {
    const items = new Map<string, SourceItem>();
    for (const file of this.local.values()) items.set(sourceKey(file), this.resolve({ key: sourceKey(file), name: file.name, size: file.size, lastModified: file.lastModified }));
    for (const entry of this.library) {
      const key = sourceKey(entry, entry.id);
      items.set(key, { key, name: entry.name, size: entry.size, lastModified: entry.lastModified, libraryId: entry.id, version: entry.version, library: entry });
    }
    return [...items.values()];
  }
  serializable() { return this.history.map(h => ({ ...h })); }
  private resolve(h: RecentSource): SourceItem {
    // Match both server id and fingerprint: a reused id must not silently load
    // changed bytes when the user chooses an old history entry.
    if (h.libraryId) {
      const candidate = this.recentLibrary.get(h.libraryId) ?? this.library.find(e => e.id === h.libraryId);
      const library = candidate && candidate.state !== 'missing' && candidate.size === h.size && candidate.lastModified === h.lastModified && (!h.version || candidate.version === h.version) ? candidate : undefined;
      return { ...h, library };
    }
    return { ...h, file: this.local.get(h.key) };
  }
}

/** Library identity is server-issued; same-named files in distinct roots stay distinct. */
export function sourceInUse(item: SourceItem, tracks: MediaInfo[]) {
  const id = item.library?.id ?? item.libraryId;
  return tracks.some(track => id ? track.source?.id === id : !track.source && sourceKey(track) === item.key);
}
