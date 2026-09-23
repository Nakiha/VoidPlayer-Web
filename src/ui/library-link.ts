export type LibraryLocation = { root: string; directory: string; all: boolean };

function validate(location: LibraryLocation): LibraryLocation {
  const { root, directory, all } = location;
  if (root && !/^[a-zA-Z0-9_-]{1,64}$/.test(root)) throw new Error('媒体库标识无效。');
  if (directory && (!root || directory.startsWith('/') || directory.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\')))) throw new Error('媒体库目录无效。');
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
    if (!path) throw new Error('媒体库路径不完整。');
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
  url.searchParams.set('library', '1');
  if (location.all) url.searchParams.set('all', '1');
  else {
    if (location.root) url.searchParams.set('root', location.root);
    if (location.directory) url.searchParams.set('dir', location.directory);
  }
  return url.href;
}

export function parseLibraryLocationLink(value: string, base: string): LibraryLocation {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请粘贴复制的媒体库链接。'); }
  if (url.origin !== new URL(base).origin) throw new Error('链接来自另一个媒体服务，请在浏览器中打开该链接。');
  if (url.pathname !== '/' || url.searchParams.get('library') !== '1') throw new Error('这不是媒体库位置链接。');
  const all = url.searchParams.get('all') === '1';
  const root = all ? '' : url.searchParams.get('root') ?? '';
  const directory = all ? '' : url.searchParams.get('dir') ?? '';
  return validate({ root, directory, all });
}
