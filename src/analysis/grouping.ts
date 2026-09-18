// 跨轨时间分组：合并显示不以严格一一配对为前提。
// 各轨样本先投影到公共会话时间域，按 (axisUs, trackOrder, decodeOrdinal, sampleId)
// 稳定排序，再以组锚点为基准归并，避免链式吸附。
// 同轨重复时间戳保留多个成员，不覆盖；缺席轨道留空，不复制、不填零。

import type { Slot } from '../model.ts';

export interface GroupSampleRef {
  sampleId: string;
  axisUs: number;
  /** 可信展示 PTS（会话时间），DTS 图点击仍用它定位；预滚/无映射为 null。 */
  sessionPtsUs: number | null;
  sizeBytes: number | null;
  key: boolean | null;
  decodeOrdinal: number;
  mediaId: string;
  sourceVersion: string;
  indexRevision: number;
}

export interface TimeGroup {
  key: string;
  anchorUs: number;
  /** 分组成员的真实时间跨度（min/max），不是几何分配单元。 */
  startUs: number;
  endUs: number;
  memberMinUs: number;
  memberMaxUs: number;
  membersByTrack: ReadonlyMap<Slot, readonly GroupSampleRef[]>;
}

export interface GroupInputTrack {
  slot: Slot;
  samples: readonly GroupSampleRef[];
}

/**
 * 跨轨时间事件归并。
 * @param toleranceUs 同组允许的最大整体跨度（锚点起算），不是两两相邻阈值。
 *   默认从时间量化误差级起步，不得为凑齐 AB 放大到半帧。
 */
export function groupSamples(
  tracks: readonly GroupInputTrack[],
  toleranceUs: number,
): TimeGroup[] {
  const tol = Math.max(0, Math.floor(toleranceUs));
  type Event = {
    t: number; trackOrder: number; slot: Slot; ref: GroupSampleRef;
  };
  const events: Event[] = [];
  tracks.forEach((track, trackOrder) => {
    for (const ref of track.samples) {
      if (!Number.isFinite(ref.axisUs)) continue;
      events.push({ t: ref.axisUs, trackOrder, slot: track.slot, ref });
    }
  });
  events.sort((a, b) =>
    a.t - b.t ||
    a.trackOrder - b.trackOrder ||
    a.ref.decodeOrdinal - b.ref.decodeOrdinal ||
    (a.ref.sampleId < b.ref.sampleId ? -1 : a.ref.sampleId > b.ref.sampleId ? 1 : 0),
  );
  const groups: TimeGroup[] = [];
  let current: {
    anchorUs: number; minUs: number; maxUs: number;
    members: Map<Slot, GroupSampleRef[]>;
  } | null = null;
  const flush = () => {
    if (!current) return;
    const membersByTrack = new Map<Slot, readonly GroupSampleRef[]>();
    for (const [slot, list] of current.members) {
      // 同轨内按 (axisUs, decodeOrdinal, sampleId) 稳定，保持重复项可区分。
      const sorted = [...list].sort((a, b) =>
        a.axisUs - b.axisUs || a.decodeOrdinal - b.decodeOrdinal ||
        (a.sampleId < b.sampleId ? -1 : a.sampleId > b.sampleId ? 1 : 0),
      );
      membersByTrack.set(slot, sorted);
    }
    const anchorUs = current.anchorUs;
    groups.push({
      key: `g:${anchorUs}`,
      anchorUs,
      startUs: current.minUs,
      endUs: current.maxUs,
      memberMinUs: current.minUs,
      memberMaxUs: current.maxUs,
      membersByTrack,
    });
    current = null;
  };
  for (const event of events) {
    if (!current) {
      current = {
        anchorUs: event.t, minUs: event.t, maxUs: event.t,
        members: new Map([[event.slot, [event.ref]]]),
      };
      continue;
    }
    // 锚点起算的整体跨度约束：0/1.9/3.8ms 在 2ms 容差下分成两组，不链式吸附。
    if (event.t - current.anchorUs <= tol) {
      const list = current.members.get(event.slot);
      if (list) list.push(event.ref);
      else current.members.set(event.slot, [event.ref]);
      if (event.t < current.minUs) current.minUs = event.t;
      if (event.t > current.maxUs) current.maxUs = event.t;
    } else {
      flush();
      current = {
        anchorUs: event.t, minUs: event.t, maxUs: event.t,
        members: new Map([[event.slot, [event.ref]]]),
      };
    }
  }
  flush();
  return groups;
}

/** 严格时间对应（correspondence）统计：只用于 tooltip/状态，不控制是否合并。 */
export function correspondenceCoverage(
  pairsLength: number,
  aLength: number,
  bLength: number,
): { coverageA: number; coverageB: number } {
  return {
    coverageA: aLength > 0 ? pairsLength / aLength : 0,
    coverageB: bLength > 0 ? pairsLength / bLength : 0,
  };
}

/** 共享时间桶宽度：所有轨道同一会话域、同一宽度，避免跨轨错位。 */
export function sharedBucketWidthUs(rangeStart: number, rangeEnd: number, pixelWidth: number): number {
  return Math.max(1, Math.floor((rangeEnd - rangeStart) / Math.max(1, Math.floor(pixelWidth))) || 1);
}
