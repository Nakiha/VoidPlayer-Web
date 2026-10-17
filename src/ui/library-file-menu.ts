import { t, msg } from '../i18n.ts';
import { mediaUrl } from '../library.ts';
import type { LibraryEntry } from '../library.ts';
import { mediaActionUrl } from '../../shared/media/io/media-reference.ts';
import { libraryLocationExpression } from './library-link.ts';
import { installContextMenu } from './context-menu.ts';
import type { WorkbenchAction } from './workbench/shared.ts';

/** File actions stay separate from loading and session state. */
export function installLibraryFileMenu(host: HTMLElement, act: WorkbenchAction, notify: (message: string) => void, signal: AbortSignal) {
  const entries = new WeakMap<HTMLElement, LibraryEntry>();
  const copy = (value: string | Promise<string>) => {
    // Safari requires clipboard.write in the click task. A promised ClipboardItem
    // preserves that activation while the server resolves the absolute path.
    void act(async () => {
      const write = typeof value === 'string' ? navigator.clipboard.writeText(value)
      : navigator.clipboard.write([new ClipboardItem({ 'text/plain': value.then(text => new Blob([text], { type: 'text/plain' })) })]);
      await write; notify(t(msg('libraryFileMenu.copied', '已拷贝')));
    }, 'ui.library-copy');
  };
  const menu = installContextMenu(host, {
    id: 'library-file-menu', selector: '.source-row', signal,
    actions(row) {
      const entry = entries.get(row);
      if (!entry) return [];
      const source = mediaUrl(entry.id, entry.version);
      return [
        { id: 'copy-name', label: t(msg('libraryFileMenu.copyName', '拷贝文件名')), glyph: 'copy', run: () => copy(entry.name.split('/').at(-1)!) },
        { id: 'copy-path', label: t(msg('sourceActions.copyAbsolutePath', '拷贝绝对路径')), glyph: 'copy', run: () => copy((async () => {
          const response = await fetch(mediaActionUrl(source, 'location', location.href), { cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
          const body = await response.json();
          if (!response.ok || typeof body.absolutePath !== 'string') throw new Error(t(msg('libraryFileMenu.pathUnavailable', '无法获取文件绝对路径')));
          return body.absolutePath as string;
        })()) },
        { id: 'copy-library-path', label: t(msg('libraryFileMenu.copyLibraryPath', '拷贝媒体库路径')), glyph: 'film', disabled: !entry.rootId, run: () => copy(libraryLocationExpression({ root: entry.rootId!, directory: entry.name, all: false })) },
        { id: 'download', label: t(msg('sourceActions.downloadFile', '下载文件')), glyph: 'download', disabled: entry.state !== undefined && entry.state !== 'ready', run: () => {
          const link = document.createElement('a');
          link.href = mediaActionUrl(source, 'download', location.href); link.download = entry.name.split('/').at(-1)!;
          link.click();
        } },
      ];
    },
  });
  return { register(row: HTMLElement, entry: LibraryEntry) { entries.set(row, entry); row.tabIndex = 0; row.setAttribute('aria-haspopup', 'menu'); }, close: menu.close };
}
