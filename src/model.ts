export type Slot = 'A' | 'B';
export type Region = { left: number; top: number; width: number; height: number };
export type FrameInfo = { ptsUs: number; sourcePtsUs: number; durationUs: number };
export type MediaInfo = {
  id: string; name: string; size: number; lastModified: number;
  codec: string; width: number; height: number; durationUs: number; firstPtsUs: number;
};
export type Mark = {
  id: string; text: string; severity: number; origin: 'human' | 'agent';
  createdAt: string; slot: Slot; mediaId: string; frame: FrameInfo;
  comparison: { slot: Slot; mediaId: string; frame: FrameInfo }[];
  region: Region | null;
};
export function timeUs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('时间必须是非负整数微秒。');
  }
  return value;
}
export function slotValue(value: unknown): Slot {
  if (value !== 'A' && value !== 'B') throw new Error('轨道必须是 A 或 B。');
  return value;
}
export function regionValue(value: unknown): Region | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new Error('标注区域无效。');
  const r = value as Region;
  if (![r.left, r.top, r.width, r.height].every(v => typeof v === 'number' && Number.isFinite(v)) ||
    r.left < 0 || r.top < 0 || r.width <= 0 || r.height <= 0 || r.left + r.width > 1.000001 || r.top + r.height > 1.000001) {
    throw new Error('标注区域必须位于画面内。');
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
export function stepTarget(frame: FrameInfo, direction: number, limitUs: number): number {
  if (direction !== -1 && direction !== 1) throw new Error('逐帧方向必须是 -1 或 1。');
  if (direction < 0) return Math.max(0, frame.ptsUs - 1);
  if (frame.durationUs <= 0) throw new Error('当前帧缺少时长，无法可靠地向后逐帧。');
  // WebCodecs timestamps are rounded to microseconds. Step just beyond the
  // rounded boundary so 30 fps (33,333.333… µs) cannot return the same frame.
  return Math.min(Math.max(0, limitUs - 1), frame.ptsUs + frame.durationUs + 1);
}
export function formatTime(us: number): string {
  const ms = Math.floor(Math.max(0, us) / 1000);
  return `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}.${(ms % 1000).toString().padStart(3, '0')}`;
}
