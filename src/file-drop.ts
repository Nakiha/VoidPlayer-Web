import type { Slot } from './model.ts';

export function dropSlots(count: number, loaded: Slot[], target?: Slot): Slot[] {
  if (count < 1 || count > 2) throw new Error('请拖入一到两个视频文件。');
  if (count === 2) return ['A', 'B'];
  return [target ?? (loaded.includes('A') ? 'B' : 'A')];
}

/** Keep File access inside the drop event, before the browser protects it again. */
export function bindFileDrop(root: EventTarget, options: {
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
    options.hover(count > 2 ? [] : dropSlots(Math.max(1, count), options.loaded(), options.target(event)));
  };
  const enter = (event: DragEvent) => { if (isFile(event)) { depth++; over(event); } };
  const leave = (event: DragEvent) => { if (isFile(event) && --depth <= 0) clear(); };
  const drop = (event: DragEvent) => {
    if (!isFile(event)) return;
    event.preventDefault();
    clear();
    const files = Array.from(event.dataTransfer?.files ?? []);
    try {
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
