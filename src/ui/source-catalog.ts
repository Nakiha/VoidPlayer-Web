import type { MediaInfo } from '../../shared/review/model.ts';
import type { LibraryEntry } from '../services/library.ts';
import type { LibraryAccessProblem } from '../../shared/media/io/source-access.ts';

export type RecentSource = { key: string; name: string; size: number; lastModified: number; libraryId?: string; libraryRootId?: string; version?: string; openedAt?: number };
export type SourceItem = RecentSource & { file?: File; library?: LibraryEntry; libraryProblem?: LibraryAccessProblem };
const HISTORY_LIMIT = 100;
// Each library root and the browser's local files have their own retention.
function limitHistory(history: RecentSource[]) {
  const counts = new Map<string, number>();
  return history.filter(item => {
    const scope = item.libraryId ? `library:${item.libraryRootId ?? 'legacy'}` : 'local';
    const count = (counts.get(scope) ?? 0) + 1; counts.set(scope, count);
    return count <= HISTORY_LIMIT;
  });
}
import {sourceKey} from '../../shared/media/io/source-identity.ts';
export {sourceKey} from '../../shared/media/io/source-identity.ts';

/** Keeps source access separate from decoded-frame resources. History stores
 * metadata only; a past local file requires a fresh browser file selection. */
export class SourceCatalog {
  private local = new Map<string, File>();
  private library: LibraryEntry[] = [];
  private history: RecentSource[];
  private recentLibrary = new Map<string, LibraryEntry>();
  private recentProblems = new Map<string, LibraryAccessProblem>();
  private activeRoots?: Set<string>;
  constructor(stored: unknown = [], privateOptions: { isolateLibraries?: boolean } = {}) {
    if (privateOptions.isolateLibraries) this.activeRoots = new Set();
    this.history = [];
    if (Array.isArray(stored)) for (const entry of stored) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isFinite(entry.lastModified)) continue;
      const libraryId = typeof entry.libraryId === 'string' && entry.libraryId ? entry.libraryId : undefined;
      const libraryRootId = libraryId && typeof entry.libraryRootId === 'string' && entry.libraryRootId.length <= 200 && entry.libraryRootId ? entry.libraryRootId : undefined;
      const version = typeof entry.version === 'string' && /^[0-9a-f]{24}$/.test(entry.version) ? entry.version : undefined;
      const openedAt = Number.isFinite(entry.openedAt) ? (entry.openedAt as number) : undefined;
      // Recompute keys so existing v1 metadata histories migrate on read.
      const clean: RecentSource = { key: sourceKey(entry, libraryId, version), name: entry.name, size: entry.size, lastModified: entry.lastModified,
        ...(libraryId ? { libraryId } : {}), ...(libraryRootId ? { libraryRootId } : {}), ...(version ? { version } : {}), ...(openedAt !== undefined ? { openedAt } : {}) };
      if (!this.history.some(h => h.key === clean.key)) this.history.push(clean);
    }
    this.history = limitHistory(this.history);
  }
  setLibraryRoots(ids: string[]) {
    const next = new Set(ids);
    const changed = !this.activeRoots || next.size !== this.activeRoots.size || [...next].some(id => !this.activeRoots!.has(id));
    if (changed) { this.activeRoots = next; this.recentLibrary.clear(); this.recentProblems.clear(); }
    return changed;
  }
  /** Unscoped v1 references are only adopted after this service resolves their
   * exact ID. Other libraries' history remains saved but is never requested. */
  referencesToResolve() {
    return this.history.filter(item => item.libraryId && (!this.activeRoots || !item.libraryRootId || this.activeRoots.has(item.libraryRootId)));
  }
  setLibrary(entries: LibraryEntry[]) { this.library = entries; }
  setRecentLibrary(entries: [string, LibraryEntry][], problems: [string, LibraryAccessProblem][] = []) {
    this.recentLibrary = new Map(entries);
    this.recentProblems = new Map(problems);
    for (const [, entry] of entries) this.recentLibrary.set(entry.id, entry);
    const history = new Map<string, RecentSource>();
    for (const item of this.history) {
      const entry = item.libraryId ? this.recentLibrary.get(item.libraryId) : undefined;
      const scoped = entry?.rootId && (!this.activeRoots || this.activeRoots.has(entry.rootId)) && (!item.libraryRootId || item.libraryRootId === entry.rootId) ? { ...item, libraryRootId: entry.rootId } : item;
      const current = entry && entry.size === item.size && entry.lastModified === item.lastModified && (!item.version || entry.version === item.version)
        ? { ...scoped, libraryId: entry.id, version: entry.version, key: sourceKey(entry, entry.id) } : scoped;
      if (!history.has(current.key)) history.set(current.key, current);
    }
    this.history = limitHistory([...history.values()]);
  }
  addFile(file: File) { this.local.set(sourceKey(file), file); this.remember(file); }
  remember(entry: { name: string; size: number; lastModified: number; version?: string }, libraryId?: string, version = entry.version, rootId?: string) {
    const key = sourceKey(entry, libraryId, version);
    const openedAt = Date.now();
    const libraryRootId = libraryId ? rootId ?? this.recentLibrary.get(libraryId)?.rootId ?? this.library.find(item => item.id === libraryId)?.rootId ?? this.history.find(item => item.libraryId === libraryId)?.libraryRootId : undefined;
    this.history = [{ key, name: entry.name, size: entry.size, lastModified: entry.lastModified, openedAt,
      ...(libraryId ? { libraryId } : {}), ...(libraryRootId ? { libraryRootId } : {}), ...(version ? { version } : {}) },
    ...this.history.filter(h => h.key !== key)];
    this.history = limitHistory(this.history);
  }
  recent() { return this.history.filter(item => !this.activeRoots || !item.libraryId || !!item.libraryRootId && this.activeRoots.has(item.libraryRootId)).map(h => this.resolve(h)); }
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
      const libraryProblem = library ? undefined : candidate ? candidate.state === 'missing' ? 'missing' : 'changed' : this.recentProblems.get(h.libraryId) ?? 'unavailable';
      return { ...h, library, libraryProblem };
    }
    return { ...h, file: this.local.get(h.key) };
  }
}

/** Library identity is server-issued; same-named files in distinct roots stay distinct. */
export function sourceInUse(item: SourceItem, tracks: MediaInfo[]) {
  const id = item.library?.id ?? item.libraryId;
  return tracks.some(track => id ? track.source?.id === id : !track.source && sourceKey(track) === item.key);
}
