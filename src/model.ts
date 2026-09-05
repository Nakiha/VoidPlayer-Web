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

// Fair multi-track step planner ported from native/renderer/track/track_step_policy.cpp.
// Every value is a session-relative frame start in integer microseconds; each file's
// first timestamp maps to zero, so there are no per-track offsets.

const FALLBACK_FRAME_DURATION_US = 33333;
const MAX_TRUSTED_FRAME_DURATION_US = 100000;

export function minFrameDurationUs(durationsUs: number[]): number {
  let min = Infinity;
  for (const duration of durationsUs) if (duration > 0) min = Math.min(min, duration);
  return min <= MAX_TRUSTED_FRAME_DURATION_US ? min : FALLBACK_FRAME_DURATION_US;
}

export type ForwardStepTrack = { currentUs: number; nextUs: number | null; nextNextUs: number | null };

// Candidate targets are the loaded tracks' next frame starts. A candidate is valid
// when no track would skip an intermediate frame or jump a suspicious gap; among
// valid candidates the planner maximizes the number of stepping tracks and breaks
// ties toward the earliest target. Returns null when no track can step.
export function planForwardStep(tracks: ForwardStepTrack[], frameDurationUs: number): number | null {
  const maxStepGapUs = frameDurationUs + Math.floor(frameDurationUs / 2) + 2000;
  const candidates = [...new Set(tracks.map(t => t.nextUs).filter((v): v is number => v != null))].sort((a, b) => a - b);
  let selected: number | null = null;
  let selectedCount = 0;
  for (const target of candidates) {
    let valid = true;
    let stepped = 0;
    for (const track of tracks) {
      if (track.nextUs == null || target < track.nextUs) continue;
      if (track.nextUs - track.currentUs > maxStepGapUs) { valid = false; break; }
      if (track.nextNextUs != null && target >= track.nextNextUs) { valid = false; break; }
      // nextNextUs == null means the next frame is the track's last one, so landing
      // past its start cannot skip an unknown intermediate frame. The native planner
      // invalidates this case because a missing next-next is only a lookahead miss.
      stepped++;
    }
    if (valid && stepped > 0 && (selected == null || stepped > selectedCount)) {
      selected = target;
      selectedCount = stepped;
    }
  }
  return selected;
}

export type BackwardStepTrack = { currentUs: number; previousUs: number | null };

// Mirror of planForwardStep: candidates are the tracks' previous frame starts,
// ties break toward the latest target.
export function planBackwardStep(tracks: BackwardStepTrack[]): number | null {
  const candidates = [...new Set(tracks.map(t => t.previousUs).filter((v): v is number => v != null))].sort((a, b) => b - a);
  let selected: number | null = null;
  let selectedCount = 0;
  for (const target of candidates) {
    let valid = true;
    let stepped = 0;
    for (const track of tracks) {
      if (target >= track.currentUs) continue;
      if (track.previousUs == null || target < track.previousUs) { valid = false; break; }
      stepped++;
    }
    if (valid && stepped > 0 && (selected == null || stepped > selectedCount)) {
      selected = target;
      selectedCount = stepped;
    }
  }
  return selected;
}
export function formatTime(us: number): string {
  const ms = Math.floor(Math.max(0, us) / 1000);
  return `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}.${(ms % 1000).toString().padStart(3, '0')}`;
}
