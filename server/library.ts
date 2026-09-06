import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Server-side media library: an explicit whitelist of folders exposed over a
// narrow read-only API. No arbitrary path access, no writes, no transcoding.

export const MEDIA_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.avi', '.flv'];

export interface LibraryEntry {
  id: string;
  /** POSIX-style path relative to its whitelisted root, for display only. */
  name: string;
  /** Display label of the whitelisted root (its basename). */
  root: string;
  rootIndex: number;
  size: number;
  lastModified: number;
}

export interface Library {
  roots: string[];
  entries: LibraryEntry[];
  truncated: boolean;
}

const MAX_ENTRIES = 5000;
const MAX_DEPTH = 6;

export function mediaId(root: string, rel: string): string {
  return createHash('sha256').update(`${root}\n${rel}`).digest('hex').slice(0, 24);
}

/** Walk whitelisted roots and list media files. Never follows symlinked dirs. */
export async function scanLibrary(roots: string[]): Promise<Library> {
  const entries: LibraryEntry[] = [];
  let truncated = false;
  const walk = async (rootIndex: number, dir: string, depth: number): Promise<void> => {
    const root = roots[rootIndex];
    if (depth > MAX_DEPTH) return;
    if (entries.length >= MAX_ENTRIES) { truncated = true; return; }
    let children;
    try { children = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const child of children) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; return; }
      if (child.name.startsWith('.')) continue;
      const abs = path.join(dir, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) { await walk(rootIndex, abs, depth + 1); continue; }
      if (!child.isFile() || !MEDIA_EXTENSIONS.includes(path.extname(child.name).toLowerCase())) continue;
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      entries.push({ id: mediaId(root, rel), name: rel, root: path.basename(root), rootIndex, size: stat.size, lastModified: Math.round(stat.mtimeMs) });
    }
  };
  for (let i = 0; i < roots.length; i++) await walk(i, roots[i], 0);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { roots: roots.map(r => path.basename(r)), entries, truncated };
}

/** A per-service snapshot shared by listing, Range reads and source actions. */
export class MediaLibraryIndex {
  private snapshot: Library | null = null;
  private entries = new Map<string, LibraryEntry>();
  private refreshedAt = -Infinity;
  private pending: Promise<Library> | null = null;
  readonly roots: string[];
  private options: { ttlMs?: number; scan?: typeof scanLibrary; now?: () => number };
  constructor(roots: string[], options: { ttlMs?: number; scan?: typeof scanLibrary; now?: () => number } = {}) {
    this.options = options;
    this.roots = roots.map(root => path.resolve(root));
  }
  get ready() { return this.snapshot !== null; }
  async list(force = false): Promise<Library> {
    const now = this.options.now ?? Date.now;
    if (this.pending) return this.pending.then(value => structuredClone(value));
    if (!force && this.snapshot && now() - this.refreshedAt < (this.options.ttlMs ?? 30000)) return structuredClone(this.snapshot);
    this.pending = (this.options.scan ?? scanLibrary)(this.roots).then(library => {
      this.snapshot = structuredClone(library);
      this.entries = new Map(this.snapshot.entries.map(entry => [entry.id, entry]));
      this.refreshedAt = now(); return this.snapshot;
    }).finally(() => { this.pending = null; });
    return this.pending.then(value => structuredClone(value));
  }
  async resolve(id: string): Promise<string | null> {
    if (!/^[0-9a-f]{24}$/.test(id)) return null;
    // Do not clone the potentially large listing on every Range request.
    if (this.pending || !this.snapshot || (this.options.now ?? Date.now)() - this.refreshedAt >= (this.options.ttlMs ?? 30000)) await this.list();
    const entry = this.entries.get(id);
    if (!entry) return null;
    const rootReal = await fs.realpath(this.roots[entry.rootIndex]).catch(() => null);
    if (!rootReal) return null;
    const real = await fs.realpath(path.join(rootReal, entry.name)).catch(() => null);
    if (!real || (real !== rootReal && !real.startsWith(rootReal + path.sep))) return null;
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile() || stat.size !== entry.size || Math.round(stat.mtimeMs) !== entry.lastModified) return null;
    return real;
  }
}

/** Standalone resolution helper; servers should keep one MediaLibraryIndex. */
export async function resolveMediaPath(roots: string[], id: string): Promise<string | null> {
  return new MediaLibraryIndex(roots).resolve(id);
}
