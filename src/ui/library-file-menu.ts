import { t, msg } from '../i18n.ts';
import { mediaUrl } from '../services/library.ts';
import type { LibraryEntry } from '../services/library.ts';
import { mediaActionUrl } from '../../shared/media/io/media-reference.ts';
import { libraryLocationExpression } from './library-link.ts';
import { installContextMenu } from './context-menu.ts';
import type { ContextMenuAction } from './context-menu.ts';
export type LibraryMenuAction = (action: () => unknown | Promise<unknown>, name?: string, data?: unknown) => Promise<void>;
type LocalMenuFile = { name: string; file?: File; remove(): void; disabled(): boolean };

export async function writeClipboardText(value:string|Promise<string>) {
  if (typeof value==='string') return navigator.clipboard.writeText(value);
  const blob=value.then(text=>new Blob([text],{type:'text/plain'}));
  return navigator.clipboard.write([new ClipboardItem({'text/plain':blob})]);
}

export async function libraryAbsolutePath(signal:AbortSignal,rootId:string,directory='') {
  const response = await fetch(`/api/library/roots/${encodeURIComponent(rootId)}/location`, {
    cache:'no-store', signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),
  });
  const body = await response.json();
  if (!response.ok || typeof body.absolutePath !== 'string') throw new Error(t(msg('libraryFileMenu.mountPathUnavailable', '无法获取挂载路径')));
  if (!directory) return body.absolutePath as string;
  const separator = !body.absolutePath.startsWith('/') ? '\\' : '/';
  return body.absolutePath.replace(/[\\/]+$/, '') + separator + directory.split('/').join(separator);
}

/** File actions invoke workbench callbacks; this menu never owns session state. */
export function installLibraryFileMenu(host: HTMLElement, act: LibraryMenuAction, notify: (message: string) => void, signal: AbortSignal) {
  const entries = new WeakMap<HTMLElement, {entry?: LibraryEntry; playback: () => ContextMenuAction | undefined; local?: LocalMenuFile} | {rootId:string}>();
  const copy = (value: string | Promise<string>) => {
    // Safari requires clipboard.write in the click task. A promised ClipboardItem
    // preserves that activation while the server resolves the absolute path.
    void act(async () => {
      await writeClipboardText(value); notify(t(msg('libraryFileMenu.copied', '已拷贝')));
    }, 'ui.library-copy');
  };
  const menu = installContextMenu(host, {
    id: 'library-file-menu', selector: '.source-row', signal, popover: 'manual',
    focusTarget: row => row.querySelector<HTMLElement>('button.source-open') ?? row,
    actions(row) {
      const root = row.dataset.rootId;
      const directory = row.dataset.libraryPath ?? '';
      const copyLibraryPath: ContextMenuAction = {
        id:'copy-library-path', label:t(msg('libraryFileMenu.copyLibraryPath', '拷贝媒体库路径')), glyph:'film',
        run:() => copy(libraryLocationExpression({root:root!,directory,all:false})),
      };
      if (root && row.dataset.libraryKind === 'directory') return [
        {id:'copy-path', label:t(msg('sourceActions.copyAbsolutePath', '拷贝绝对路径')), glyph:'copy', disabled:row.dataset.storage === 'provider', run:() => copy(libraryAbsolutePath(signal,root,directory))},
        copyLibraryPath,
      ];
      const record = entries.get(row);
      if (!record) return [];
      if ('rootId' in record) return [
        {id:'copy-mount-path', label:t(msg('libraryFileMenu.copyMountPath', '拷贝挂载路径')), glyph:'copy', disabled:row.dataset.storage === 'provider', run:() => copy(libraryAbsolutePath(signal,record.rootId))},
        copyLibraryPath,
      ];
      const {entry, local} = record, playback = record.playback();
      if (local) {
        const path=(local.file as (File & {path?:string})|undefined)?.path;
        const absolute=typeof path==='string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) && !/^[A-Za-z]:[\\/]fakepath[\\/]/i.test(path);
        return [
          ...(playback ? [playback] : []),
          { id: 'copy-name', label: t(msg('libraryFileMenu.copyName', '拷贝文件名')), glyph: 'copy', run: () => copy(local.name) },
          { id:'copy-path',label:t(msg('sourceActions.copyAbsolutePath','拷贝绝对路径')),glyph:'copy',disabled:!absolute,
            hint:absolute?undefined:t(msg('sourceActions.noAbsolutePath','浏览器未提供本地绝对路径；从本机媒体库打开可使用路径和定位')),
            run:()=>{if (absolute) copy(path);} },
          { id: 'remove-file', label: t(msg('sources.removeFile', '移除文件')), glyph: 'trash', disabled: local.disabled(), run: local.remove },
        ];
      }
      if (!entry) return playback ? [playback] : [];
      const source = mediaUrl(entry.id, entry.version);
      return [
        ...(playback ? [playback] : []),
        { id: 'copy-name', label: t(msg('libraryFileMenu.copyName', '拷贝文件名')), glyph: 'copy', run: () => copy(entry.name.split('/').at(-1)!) },
        { id: 'copy-path', label: t(msg('sourceActions.copyAbsolutePath', '拷贝绝对路径')), glyph: 'copy', disabled:entry.storage === 'provider', run: () => copy((async () => {
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
  return { register(row: HTMLElement, entry: LibraryEntry | undefined, playback: () => ContextMenuAction | undefined, local?: LocalMenuFile) {
    entries.set(row, {entry, playback, local}); row.tabIndex = -1; row.setAttribute('aria-haspopup', 'menu');
  }, registerMount(row: HTMLElement, rootId: string) {
    entries.set(row, {rootId}); row.setAttribute('aria-haspopup', 'menu');
  }, close: menu.close };
}
