import {SLOTS} from './model.ts';
import type {Slot} from './model.ts';
export function dropSlots(count: number, loaded: Slot[], target?: Slot): Slot[] {
  if (!Number.isInteger(count) || count < 1 || count > SLOTS.length) throw new Error('请拖入一到八个视频文件。');
  // Explicit target first; otherwise use vacant tracks before replacing any.
  const candidates = [...(target ? [target] : []), ...SLOTS.filter(slot => !loaded.includes(slot)), ...SLOTS];
  return [...new Set(candidates)].slice(0, count);
}
