import {dropSlots} from '../../shared/review/drop-slots.ts';
import { log } from '../logging/log.ts';
import type { Slot } from '../../shared/review/model.ts';
import { dropFileHandles } from '../services/file-handles.ts';
import type { FsFileHandle } from '../services/file-handles.ts';

/** Keep File access inside the drop event, before the browser protects it again. */
export function bindFileDrop(root: EventTarget, options: {
  document?: { accepts(files: File[]): boolean; load(files: File[]): Promise<void> };
  loaded(): Slot[];
  hover(slots: Slot[]): void;
  load(files: File[], slots: Slot[], handles?: (FsFileHandle | undefined)[]): Promise<void>;
  error(error: unknown): void;
}) {
  let depth = 0;
  const clear = () => { depth = 0; options.hover([]); };
  const isFile = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const over = (event: DragEvent) => {
    if (!isFile(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const count = Array.from(event.dataTransfer?.items ?? []).filter(item => item.kind === 'file').length;
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
    const files = Array.from(event.dataTransfer?.files ?? []);
    log.info('ui', '接收文件拖入', { files });
    try {
      if (options.document?.accepts(files)) { void options.document.load(files).catch(options.error); return; }
      dropSlots(files.length, options.loaded());
      const items = Array.from(event.dataTransfer?.items ?? []);
      void (async () => {
        // Handles must be captured inside the drop event; misalignment or any
        // failure simply means this drop will not be silently restorable.
        let handles: (FsFileHandle | undefined)[] | undefined;
        try {
          const captured = await dropFileHandles(items);
          if (captured.length === files.length) handles = captured;
        } catch { handles = undefined; }
        // Other actions may have filled a track while handles were captured.
        await options.load(files, dropSlots(files.length, options.loaded()), handles);
      })().catch(options.error);
    } catch (error) { options.error(error); }
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
