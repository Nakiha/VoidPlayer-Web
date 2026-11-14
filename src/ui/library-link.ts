import { t, msg } from '../i18n.ts';
import type { LibraryEntry } from '../services/library.ts';
import { createShareUrl } from '../../shared/review/uri-binary.ts';
import { emptyUriState } from '../../shared/review/uri-state.ts';

export type LibraryLocation = { root: string; directory: string; all: boolean };

function validate(location: LibraryLocation): LibraryLocation {
  const { root, directory, all } = location;
  if (root && !/^[a-zA-Z0-9_-]{1,64}$/.test(root)) throw new Error(t(msg("libraryLink.invalidRoot", "媒体库标识无效")));
  if (directory && (!root || directory.startsWith('/') || directory.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')))) throw new Error(t(msg("libraryLink.invalidDirectory", "媒体库目录无效")));
  return { root: all ? '' : root, directory: all ? '' : directory, all };
}

/** Compact, service-relative text for the editable location field and clipboard. */
export function libraryLocationExpression(location: LibraryLocation): string {
  const { root, directory, all } = validate(location);
  return all ? 'library:*' : root ? `library:${root}${directory ? `/${directory}` : ''}` : 'library:/';
}

/** Accept the compact expression and older HTTP deep links. */
export function parseLibraryLocationInput(value: string, base: string): LibraryLocation {
  const input = value.trim();
  if (/^library:/i.test(input)) {
    const path = input.slice('library:'.length);
    if (!path) throw new Error(t(msg("libraryLink.incompletePath", "媒体库路径不完整")));
    if (path === '*') return { root: '', directory: '', all: true };
    if (path === '/') return { root: '', directory: '', all: false };
    const slash = path.indexOf('/');
    return validate({ root: slash < 0 ? path : path.slice(0, slash), directory: slash < 0 ? '' : path.slice(slash + 1), all: false });
  }
  return parseLibraryLocationLink(input, base);
}

/** A location link names the library root by stable ID, not its display name. */
export function libraryLocationLink(location: LibraryLocation, base: string): string {
  const url = new URL('/', base);
  const {root,directory,all} = validate(location);
  url.searchParams.set('library',all ? '*' : root);
  // "1" was the legacy panel switch; keep this unusual configured ID distinct.
  if (!all && root === '1') url.searchParams.set('root',root);
  if (directory) url.searchParams.set('dir',directory);
  return url.href;
}

export function parseLibraryLocationLink(value: string, base: string): LibraryLocation {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(t(msg("libraryLink.pasteLink", "请粘贴复制的媒体库链接"))); }
  if (url.origin !== new URL(base).origin) throw new Error(t(msg("libraryLink.otherService", "链接来自另一个媒体服务，请在浏览器中打开该链接")));
  if (url.pathname !== '/' || !url.searchParams.has('library')) throw new Error(t(msg("libraryLink.notLocationLink", "这不是媒体库位置链接")));
  const scope = url.searchParams.get('library')!, legacy = scope === '1';
  const all = scope === '*' || legacy && url.searchParams.get('all') === '1';
  const root = all ? '' : legacy ? url.searchParams.get('root') ?? '' : scope;
  const directory = all ? '' : url.searchParams.get('dir') ?? '';
  return validate({ root, directory, all });
}

/** Explicit file actions use the same version-pinned share ABI and directory layout. */
export function libraryFileLink(entry: LibraryEntry, base: string): string {
  const directory = entry.rootId && entry.name.includes('/') ? entry.name.slice(0, entry.name.lastIndexOf('/')) : '';
  return createShareUrl({ ...emptyUriState(), tracks: [{ slot: 'A', id: entry.id, version: entry.version ?? '', offsetUs: 0, visible: true }],
    layout: { panels: { inspector: false, subtracks: false, sources: true, analysis: false }, selected: 'A', dockHeight: 180,
      marksExpanded: false, sources: { tab: 'available', query: '', root: entry.rootId ?? '', directory, search: '', all: false } } }, base).href;
}
