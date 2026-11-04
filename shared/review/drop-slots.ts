import {SLOTS} from './model.ts';
import type {Slot} from './model.ts';
export function dropSlots(count: number, loaded: Slot[]): Slot[] {
  if (!Number.isInteger(count) || count < 1 || count > SLOTS.length) throw new Error('请拖入一到八个视频文件。');
  const vacant = SLOTS.filter(slot => !loaded.includes(slot));
  if (count > vacant.length) throw new Error(`空轨道不足：当前有 ${vacant.length} 条空轨道，无法添加 ${count} 个视频。请先关闭部分视频。`);
  return vacant.slice(0, count);
}
