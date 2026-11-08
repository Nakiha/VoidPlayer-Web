import {dropSlots} from '../../shared/review/drop-slots.ts';
import { log } from '../logging/log.ts';
import type { Slot } from '../../shared/review/model.ts';
import { dropEntryHandle } from '../services/file-handles.ts';
import type { FsFileHandle } from '../services/file-handles.ts';
import { LocalInputError, nonVideoMime, selectVideoInputs, type LocalItem } from './video-input.ts';
import { t, msg } from '../i18n.ts';

function droppedItems(transfer: DataTransfer): Promise<LocalItem<FsFileHandle>[]> {
  const files = Array.from(transfer.files);
  const items = Array.from(transfer.items ?? []).filter(item => item.kind === 'file');
  if (!items.length) return Promise.resolve(files.map(file => ({file})));
  return Promise.all(items.map(async (item, index): Promise<LocalItem<FsFileHandle> | null> => {
    let entry: FileSystemEntry | null | undefined;
    try { entry = item.webkitGetAsEntry?.(); } catch { /* Some browsers expose handles only. */ }
    if (entry?.isDirectory) return {directory:entry.name};
    let file: File | null | undefined;
    try { file = item.getAsFile?.(); } catch { /* Use the drop-time FileList or handle. */ }
    file ??= items.length === files.length ? files[index] : undefined;
    const handle = await dropEntryHandle(item);
    if (handle?.kind === 'directory') return {directory:handle.name};
    if (file) return {file, handle:handle ?? undefined};
    if (handle?.kind === 'file') {
      try { return {file:await handle.getFile(), handle}; } catch { return {unreadable:handle.name}; }
    }
    return null;
  })).then(results => results.filter(item => item !== null));
}

type FileOrigin = 'drop' | 'launch';
export interface LocalFileActions {
  document?: { accepts(files: File[]): boolean; load(files: File[], origin: FileOrigin): Promise<void> };
  loaded(): Slot[];
  load(files: File[], slots: Slot[], handles: (FsFileHandle | undefined)[], origin: FileOrigin): Promise<void>;
  error(error: unknown): void;
}

async function openItems(items: LocalItem<FsFileHandle>[], actions: LocalFileActions, origin: FileOrigin) {
  const documents: File[] = [];
  const videos = items.filter(item => {
    if ('file' in item && actions.document?.accepts([item.file])) { documents.push(item.file); return false; }
    return true;
  });
  const accepted = await selectVideoInputs(videos, actions.error);
  const files = accepted.map(item => item.file);
  log.info('ui', origin === 'drop' ? '接收文件拖入' : '接收系统打开的文件', { files, documents });
  if (documents.length && actions.document) {
    try { await actions.document.load([...documents, ...files], origin); return; }
    catch (error) {
      if (!(error instanceof LocalInputError)) throw error;
      actions.error(error);
    }
  }
  if (files.length) await actions.load(files, dropSlots(files.length, actions.loaded()), accepted.map(item => item.handle), origin);
}

interface FileLaunchQueue { setConsumer(consume: (launch: { files: readonly FsFileHandle[] }) => void): void }
export function bindFileLaunch(actions: LocalFileActions, ready: Promise<void>, signal: AbortSignal) {
  const queue = (window as Window & { launchQueue?: FileLaunchQueue }).launchQueue;
  if (!queue) return;
  let pending = ready;
  queue.setConsumer(({ files }) => {
    if (!files.length || signal.aborted) return;
    pending = pending.then(async () => {
      if (signal.aborted) return;
      const items = await Promise.all(files.map(async (handle): Promise<LocalItem<FsFileHandle>> => {
        if (handle.kind === 'directory') return { directory: handle.name };
        try { return { file: await handle.getFile(), handle }; }
        catch { return { unreadable: handle.name }; }
      }));
      if (!signal.aborted) await openItems(items, actions, 'launch');
    }).catch(actions.error);
  });
}

/** Keep File access inside the drop event, before the browser protects it again. */
export function bindFileDrop(root: EventTarget, options: LocalFileActions & { hover(slots: Slot[], nonVideo?: boolean): void }) {
  let depth = 0;
  const clear = () => { depth = 0; options.hover([]); };
  const isFile = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const over = (event: DragEvent) => {
    if (!isFile(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const items = Array.from(event.dataTransfer?.items ?? []).filter(item => item.kind === 'file');
    const count = items.filter(item => !nonVideoMime(item.type ?? '')).length;
    if (items.length && !count) { options.hover([], true); return; }
    let slots: Slot[] = [];
    try { slots = dropSlots(Math.max(1, count), options.loaded()); } catch { /* Refused drops have no target preview. */ }
    options.hover(slots);
  };
  const enter = (event: DragEvent) => { if (isFile(event)) { depth++; over(event); } };
  const leave = (event: DragEvent) => { if (isFile(event) && --depth <= 0) clear(); };
  const drop = (event: DragEvent) => {
    if (!isFile(event)) return;
    event.preventDefault();
    clear();
    void (async () => {
      const items = await droppedItems(event.dataTransfer!);
      if (!items.length) throw new LocalInputError(t(msg('input.emptyDrop', '未收到可打开的文件。请直接拖入视频文件。')));
      await openItems(items, options, 'drop');
    })().catch(options.error);
  };
  const handlers = { dragenter: enter, dragover: over, dragleave: leave, drop, dragend: clear };
  for (const [name, handler] of Object.entries(handlers)) root.addEventListener(name, handler as EventListener);
  const escape = (event: Event) => { if ((event as KeyboardEvent).key === 'Escape') clear(); };
  root.addEventListener('keydown', escape);
  const windowTarget = typeof window === 'undefined' ? undefined : window;
  windowTarget?.addEventListener('blur', clear);
  return () => {
    for (const [name, handler] of Object.entries(handlers)) root.removeEventListener(name, handler as EventListener);
    root.removeEventListener('keydown', escape);
    windowTarget?.removeEventListener('blur', clear);
    clear();
  };
}
