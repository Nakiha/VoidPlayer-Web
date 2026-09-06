import { log } from './log.ts';
import { SLOTS } from './model.ts';
import type { Slot } from './model.ts';

export function dropSlots(count: number, loaded: Slot[], target?: Slot): Slot[] {
  if (!Number.isInteger(count) || count < 1 || count > SLOTS.length) throw new Error('请拖入一到四个视频文件。');
  // Explicit target first; otherwise use vacant tracks before replacing any.
  const candidates = [...(target ? [target] : []), ...SLOTS.filter(slot => !loaded.includes(slot)), ...SLOTS];
  return [...new Set(candidates)].slice(0, count);
}

/** Keep File access inside the drop event, before the browser protects it again. */
export function bindFileDrop(root: EventTarget, options: {
  document?: { accepts(files: File[]): boolean; load(files: File[]): Promise<void> };
  target(event: DragEvent): Slot | undefined;
  loaded(): Slot[];
  hover(slots: Slot[]): void;
  load(files: File[], slots: Slot[]): Promise<void>;
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
    options.hover(count > SLOTS.length ? [] : dropSlots(Math.max(1, count), options.loaded(), options.target(event)));
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
      const slots = dropSlots(files.length, options.loaded(), options.target(event));
      void options.load(files, slots).catch(options.error);
    } catch (error) { options.error(error); }
  };
  const handlers = { dragenter: enter, dragover: over, dragleave: leave, drop, dragend: clear };
  for (const [name, handler] of Object.entries(handlers)) root.addEventListener(name, handler as EventListener);
  return () => {
    for (const [name, handler] of Object.entries(handlers)) root.removeEventListener(name, handler as EventListener);
    clear();
  };
}
