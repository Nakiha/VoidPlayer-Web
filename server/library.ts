import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Server-side media library: an explicit whitelist of folders exposed over a
// narrow read-only API. No arbitrary path access, no writes, no transcoding.

export const MEDIA_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.avi'];

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

/** Resolve an id back to an absolute path, refusing anything outside the whitelist. */
export async function resolveMediaPath(roots: string[], id: string): Promise<string | null> {
  if (!/^[0-9a-f]{24}$/.test(id)) return null;
  const library = await scanLibrary(roots);
  const entry = library.entries.find(e => e.id === id);
  if (!entry) return null;
  // Defense in depth: the id maps to a scanned entry, but re-verify the real
  // path still sits under the same whitelisted root before opening it.
  // (realpath both sides: e.g. macOS /tmp is a symlink to /private/tmp.)
  const rootReal = await fs.realpath(roots[entry.rootIndex]).catch(() => null);
  if (!rootReal) return null;
  const real = await fs.realpath(path.join(rootReal, entry.name)).catch(() => null);
  if (!real || (real !== rootReal && !real.startsWith(rootReal + path.sep))) return null;
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile() || stat.size !== entry.size) return null;
  return real;
}
