// 码流分析的统一柱形几何：时间分组 → 柱形几何 → 绘图与命中共同消费。
// 各轨自身的帧间隔决定公共时间单元，跨轨的小幅错位不缩窄柱宽；缺席留空，不复制。
// 所有交互几何保持 CSS 像素，DPR 只影响栅格化。

import type { Slot } from '../model.ts';
import type { TimeGroup } from '../analysis/grouping.ts';

export interface Rect { x: number; y: number; width: number; height: number }

export interface SampleGlyph {
  kind: 'sample';
  slot: Slot;
  mediaId: string;
  sourceVersion: string;
  sampleId: string;
  indexRevision: number;
  /** 真正的轴时间，不因柱子侧向错开而改变。局部聚合时为聚合区间中心。 */
  axisUs: number;
  /** 可信展示 PTS（会话时间），点击定位用它；预滚/无映射为 null。聚合标记为 null（点击只放大）。 */
  sessionPtsUs: number | null;
  rect: Rect;
  interactionRect: Rect;
  key: boolean | null;
  sizeBytes: number;
  stackedCount: number;
  stackedIds: string[];
  /** 跨组局部聚合的时间区间（stackedCount>1 且跨多组时）；单组重复时间戳无此字段。 */
  clusterStartUs?: number;
  clusterEndUs?: number;
}

export interface BucketGlyph {
  kind: 'bucket';
  slot: Slot;
  bucketIndex: number;
  startUs: number;
  endUs: number;
  rect: Rect;
  interactionRect: Rect;
  count: number;
  maxBytes: number;
  sumBytes: number;
  keyCount: number;
  deltaCount: number;
  unknownCount: number;
  complete: boolean;
  maxSampleId: string | null;
}

export type AnalysisGlyph = SampleGlyph | BucketGlyph;

export interface SizeRow { y: number; h: number }

export type SizeScale = 'linear' | 'log';

/** 数据与刻度共用的纵轴映射：零在下，上限在上。对数模式为共同 log10(1+v) 基准。 */
export function valueToY(rowY: number, rowH: number, value: number, yMax: number, scale: SizeScale = 'linear'): number {
  if (!(yMax > 0)) return rowY + rowH - 4;
  if (scale === 'log') {
    if (!(value > 0)) return rowY + rowH - 4;
    const h = Math.max(1, (Math.log10(1 + Math.min(value, yMax)) / Math.log10(1 + yMax)) * (rowH - 8));
    return rowY + rowH - 4 - h;
  }
  const h = Math.max(1, (Math.min(value, yMax) / yMax) * (rowH - 8));
  return rowY + rowH - 4 - h;
}

export function barHeight(rowH: number, value: number, yMax: number, scale: SizeScale = 'linear'): number {
  if (!(yMax > 0)) return 1;
  if (scale === 'log') {
    if (!(value > 0)) return 1;
    return Math.max(1, (Math.log10(1 + Math.min(value, yMax)) / Math.log10(1 + yMax)) * (rowH - 6));
  }
  return Math.max(1, (Math.min(value, yMax) / yMax) * (rowH - 6));
}

const MAX_CELL_PX = 56;
/** 最小容量预算（CSS px），不是缩放后的柱宽上限。 */
export const TARGET_BAR_PX = 7;
const LANE_GAP_PX = 1;

/** All chart bars occupy the same fraction of their time cell, including buckets. */
export const chartBarWidth = (cellPx: number, minimum = 1): number => Math.max(minimum, cellPx * .7);
/** Gentle zoom growth preserves the hierarchy instead of matching bar widths. */
export const referenceNodeRadius = (cellPx: number): number => Math.min(12, Math.max(6, 5 + Math.log2(Math.max(1, cellPx / 12)) * 1.5));
const sampleLaneWidth = (barWidth: number): number => Math.max(2, barWidth + Math.min(LANE_GAP_PX, barWidth * .3 / .7));

export function representativeIntervalUs(times: readonly number[], fallback = 33_333, quantile = .5): number {
  const sorted = [...times].sort((a, b) => a - b);
  const intervals = sorted.slice(1).map((time, i) => time - sorted[i]).filter(n => n > 0).sort((a, b) => a - b);
  return intervals[quantile === .5 ? Math.floor(intervals.length / 2) : intervals.length <= 2 ? 0 : Math.ceil((intervals.length - 1) * quantile)] ?? fallback;
}

/** Leave half a frame cell and at least 8 CSS pixels before the first timestamp. */
export function paddedChartDomain(domain: { start: number; end: number }, frameUs: number, plotWidth: number, visibleSpan = domain.end - domain.start) {
  const padding = Math.ceil(Math.max(frameUs / 2, visibleSpan * 8 / Math.max(1, plotWidth - 8)));
  return { start: domain.start - padding, end: domain.end };
}

/** A synthetic configuration cell before media time; never a seekable frame. */
export function containerChartColumn(domain: { start: number; end: number }, frameUs: number) {
  return { timeUs: domain.start - frameUs, widthUs: frameUs };
}

/** Frame zero owns its left half-cell; the preceding configuration cell stays separate. */
export const chartFrameHoverStart = (column: { timeUs: number; widthUs: number }): number => column.timeUs + column.widthUs / 2;

export interface MergedLayoutOptions {
  trackOrder: readonly Slot[];
  viewStart: number;
  viewEnd: number;
  gutter: number;
  plotW: number;
  rowY: number;
  rowH: number;
  yMaxSize: number;
  mediaBySlot: ReadonlyMap<Slot, { mediaId: string; sourceVersion: string; indexRevision: number }>;
  /** 稀疏样本的单元上限，避免横跨数秒的巨柱。 */
  maxCellPx?: number;
  /** Shared cadence width keeps the bucket/raw seam visually continuous. */
  barWidthPx?: number;
  /** 大小纵轴：默认线性；对数为共同 log10(1+v) 基准。 */
  scale?: SizeScale;
}

function timeToX(viewStart: number, viewEnd: number, gutter: number, plotW: number, t: number): number {
  const span = Math.max(1, viewEnd - viewStart);
  return gutter + ((t - viewStart) / span) * plotW;
}

/** 单元宽度上限：保留给调用方估算聚合桶容量。 */
export function cellTargetFor(lanes: number): number {
  return (TARGET_BAR_PX + LANE_GAP_PX) * Math.max(1, lanes);
}

/** Shared width from the median time interval, matching NALU charts.
 * Missing lanes retain their reserved space; zoom scales the entire time cell. */
export function sampleBarWidth(
  groups: readonly TimeGroup[], viewStart: number, viewEnd: number, plotW: number, lanes: number,
): number {
  const timesBySlot = new Map<Slot, number[]>();
  for (const group of groups) for (const [slot, members] of group.membersByTrack) {
    const times = timesBySlot.get(slot) ?? [];
    for (const member of members) times.push(member.axisUs);
    timesBySlot.set(slot, times);
  }
  const intervals = [...timesBySlot.values()].filter(times => new Set(times).size > 1).map(times => representativeIntervalUs(times));
  const intervalUs = intervals.length ? Math.min(...intervals) : 33_333;
  const lanePx = intervalUs * plotW / Math.max(1, viewEnd - viewStart) / Math.max(1, lanes);
  return chartBarWidth(lanePx);
}

/**
 * 原始样本布局是否成立：全局密集或大范围重叠时应走共享桶，
 * 只有孤立的个别冲突才做局部聚合标记。
 * 调用方应在分组完成后使用本函数复核 raw 决策（平均 px/样本不足以发现相邻组重叠）。
 */
export function canLayoutRaw(
  groups: readonly TimeGroup[],
  viewStart: number,
  viewEnd: number,
  gutter: number,
  plotW: number,
  lanes: number,
): boolean {
  if (!groups.length) return true;
  const laneWidth = sampleLaneWidth(sampleBarWidth(groups, viewStart, viewEnd, plotW, lanes));
  const order = [...new Set(groups.flatMap(group => [...group.membersByTrack.keys()]))];
  const runs = collisionRuns(groups, order, viewStart, viewEnd, gutter, plotW, laneWidth);
  let conflicting = 0;
  for (const run of runs) {
    const counts = new Map<Slot, number>();
    for (const group of run) for (const slot of group.membersByTrack.keys()) counts.set(slot, (counts.get(slot) ?? 0) + 1);
    // One frame per track can share a time cell without aggregation or identity loss.
    if ([...counts.values()].some(count => count > 1)) {
      conflicting += run.length;
      if (run.length > 8) return false;
    }
  }
  return conflicting / groups.length <= .25;
}

/** Compare occupied lanes, rather than the empty reserved lanes of every event. */
function collisionRuns(groups: readonly TimeGroup[], order: readonly Slot[], start: number, end: number, gutter: number, plotW: number, laneWidth: number): TimeGroup[][] {
  const index = new Map(order.map((slot, i) => [slot, i]));
  const occupied = groups.map(group => {
    const lanes = [...group.membersByTrack.keys()].map(slot => index.get(slot)).filter((lane): lane is number => lane !== undefined);
    const left = timeToX(start, end, gutter, plotW, group.anchorUs) - laneWidth * order.length / 2;
    return { group, left: left + Math.min(...lanes) * laneWidth, right: left + (Math.max(...lanes) + 1) * laneWidth };
  }).filter(item => Number.isFinite(item.left)).sort((a, b) => a.left - b.left);
  const runs: TimeGroup[][] = [];
  let right = -Infinity;
  for (const item of occupied) {
    if (item.left >= right - 1e-6) { runs.push([item.group]); right = item.right; }
    else { runs[runs.length - 1].push(item.group); right = Math.max(right, item.right); }
  }
  return runs;
}

function clipX(x: number, w: number, lo: number, hi: number): { x: number; w: number } | null {
  const cx = Math.max(x, lo);
  const cw = Math.min(x + w, hi) - cx;
  if (cw <= 0) return null;
  return { x: cx, w: cw };
}

/**
 * 合并行的逐样本布局：组中心锚定真实时间，各轨按稳定顺序小幅错开。
 * 同轨重复时间戳在组内单元继续细分；放不下聚合为多样本标记，点击展开。
 * 相邻组单元重叠时，整段重叠组合并为局部聚合标记（stackedCount>1 且带
 * clusterStartUs/EndUs），点击放大，不默默重叠、后画覆盖前画。
 * 视口边缘只裁剪可见部分，不把整组钳到边缘再移动轨道位置；绘图与命中共用裁剪后几何。
 */
export function layoutMergedSamples(
  groups: readonly TimeGroup[],
  opts: MergedLayoutOptions,
): SampleGlyph[] {
  const { trackOrder, viewStart, viewEnd, gutter, plotW, rowY, rowH, yMaxSize, mediaBySlot } = opts;
  const scale = opts.scale ?? 'linear';
  void MAX_CELL_PX;
  void opts.maxCellPx;
  const lanes = Math.max(1, trackOrder.length);
  const slotIndex = new Map<Slot, number>(trackOrder.map((s, i) => [s, i]));
  const glyphs: SampleGlyph[] = [];
  // 视口选择按成员范围相交（锚点在外、成员在内仍保留）；最后裁剪实际 glyph，
  // 不因滚动裁切改变单元归属。
  const selected: TimeGroup[] = [];
  for (const g of groups) {
    const lo = Math.min(g.memberMinUs, g.memberMaxUs, g.anchorUs);
    const hi = Math.max(g.memberMinUs, g.memberMaxUs, g.anchorUs);
    if (hi < viewStart || lo > viewEnd) continue;
    selected.push(g);
  }
  selected.sort((a, b) => a.anchorUs - b.anchorUs);
  // 与 NALU 共用连续宽度：随缩放调整，缺席仍留空。
  const barWidth = sampleBarWidth(groups, viewStart, viewEnd, plotW, lanes);
  const laneW = sampleLaneWidth(barWidth);
  const cellTarget = laneW * lanes;
  const plotLeft = gutter, plotRight = gutter + plotW;
  const anchorXOf = (g: TimeGroup) => timeToX(viewStart, viewEnd, gutter, plotW, g.anchorUs);
  const runs = collisionRuns(selected, trackOrder, viewStart, viewEnd, gutter, plotW, laneW);
  const emitSingle = (
    slot: Slot, lane: number, cellLeftRaw: number,
    m: { sampleId: string; axisUs: number; sessionPtsUs: number | null; sizeBytes: number | null; key: boolean | null },
  ) => {
    const media = mediaBySlot.get(slot);
    if (!media) return;
    if (m.axisUs < viewStart || m.axisUs > viewEnd) return;
    const laneXRaw = cellLeftRaw + lane * laneW;
    const h = barHeight(rowH, m.sizeBytes ?? 0, yMaxSize, scale);
    const barW = barWidth;
    const xRaw = laneXRaw + (laneW - barW) / 2;
    const clipped = clipX(xRaw, barW, plotLeft, plotRight);
    if (!clipped) return;
    const laneClip = clipX(laneXRaw, laneW, plotLeft, plotRight);
    if (!laneClip) return;
    glyphs.push({
      kind: 'sample', slot, mediaId: media.mediaId, sourceVersion: media.sourceVersion,
      sampleId: m.sampleId, indexRevision: media.indexRevision,
      axisUs: m.axisUs, sessionPtsUs: m.sessionPtsUs,
      rect: { x: clipped.x, y: rowY + rowH - 2 - h, width: clipped.w, height: h },
      interactionRect: { x: laneClip.x, y: rowY, width: laneClip.w, height: rowH },
      key: m.key, sizeBytes: m.sizeBytes ?? 0,
      stackedCount: 1, stackedIds: [m.sampleId],
    });
  };
  for (const run of runs) {
    if (run.length === 1) {
      const group = run[0];
      const anchorX = anchorXOf(group);
      const cellLeftRaw = anchorX - cellTarget / 2;
      for (const [slot, members] of group.membersByTrack) {
        const lane = slotIndex.get(slot);
        if (lane == null) continue;
        const visible = members.filter(m => m.axisUs >= viewStart && m.axisUs <= viewEnd);
        if (!visible.length) continue;
        if (visible.length === 1) {
          emitSingle(slot, lane, cellLeftRaw, visible[0]);
          continue;
        }
        // 同轨重复时间戳：能细分则细分，否则聚合为多样本标记。
        // 细分在 lane 的可见部分内进行：边缘组不因裁剪丢成员，也不把整组移入视口。
        const media = mediaBySlot.get(slot);
        if (!media) continue;
        const laneXRaw = cellLeftRaw + lane * laneW;
        const laneVis = clipX(laneXRaw, laneW, plotLeft, plotRight);
        if (!laneVis) continue;
        const subW = laneVis.w / visible.length;
        if (subW >= 1.5) {
          visible.forEach((m, k) => {
            const h = barHeight(rowH, m.sizeBytes ?? 0, yMaxSize, scale);
            const barW = chartBarWidth(subW);
            const bx = laneVis.x + k * subW + (subW - barW) / 2;
            const clipped = clipX(bx, barW, plotLeft, plotRight);
            if (!clipped) return;
            glyphs.push({
              kind: 'sample', slot, mediaId: media.mediaId, sourceVersion: media.sourceVersion,
              sampleId: m.sampleId, indexRevision: media.indexRevision,
              axisUs: m.axisUs, sessionPtsUs: m.sessionPtsUs,
              rect: { x: clipped.x, y: rowY + rowH - 2 - h, width: clipped.w, height: h },
              interactionRect: { x: laneVis.x + k * subW, y: rowY, width: subW, height: rowH },
              key: m.key, sizeBytes: m.sizeBytes ?? 0,
              stackedCount: 1, stackedIds: [m.sampleId],
            });
          });
        } else {
          const primary = [...visible].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
          const h = barHeight(rowH, primary.sizeBytes ?? 0, yMaxSize, scale);
          const clipped = clipX(laneXRaw + (laneW - barWidth) / 2, barWidth, plotLeft, plotRight);
          if (!clipped) continue;
          const laneClip = clipX(laneXRaw, laneW, plotLeft, plotRight);
          if (!laneClip) continue;
          glyphs.push({
            kind: 'sample', slot, mediaId: media.mediaId, sourceVersion: media.sourceVersion,
            sampleId: primary.sampleId, indexRevision: media.indexRevision,
            axisUs: primary.axisUs, sessionPtsUs: primary.sessionPtsUs,
            rect: { x: clipped.x, y: rowY + rowH - 2 - h, width: clipped.w, height: h },
            interactionRect: { x: laneClip.x, y: rowY, width: laneClip.w, height: rowH },
            key: primary.key, sizeBytes: primary.sizeBytes ?? 0,
            stackedCount: visible.length, stackedIds: visible.map(m => m.sampleId),
          });
        }
      }
      continue;
    }
    // 局部聚合：重叠整段按轨道各出一根可展开标记，不互相覆盖。
    const firstX = Math.min(...run.map(anchorXOf));
    const runLeftRaw = firstX - cellTarget / 2;
    const midAnchor = run[Math.floor(run.length / 2)].anchorUs;
    let lo = Infinity, hi = -Infinity;
    for (const g of run) {
      lo = Math.min(lo, g.memberMinUs, g.anchorUs);
      hi = Math.max(hi, g.memberMaxUs, g.anchorUs);
    }
    const collected = new Map<Slot, GroupSampleRefLike[]>();
    for (const g of run) {
      for (const [slot, members] of g.membersByTrack) {
        const arr = collected.get(slot) ?? [];
        for (const m of members) {
          if (m.axisUs < viewStart || m.axisUs > viewEnd) continue;
          arr.push(m);
        }
        collected.set(slot, arr);
      }
    }
    for (const [slot, arr] of collected) {
      const lane = slotIndex.get(slot);
      const media = mediaBySlot.get(slot);
      if (lane == null || !media || !arr.length) continue;
      if (arr.length === 1) { emitSingle(slot, lane, runLeftRaw, arr[0]); continue; }
      const laneXRaw = runLeftRaw + lane * laneW;
      const maxSize = Math.max(...arr.map(m => m.sizeBytes ?? 0));
      const h = barHeight(rowH, maxSize, yMaxSize, scale);
      const clipped = clipX(laneXRaw + (laneW - barWidth) / 2, barWidth, plotLeft, plotRight);
      if (!clipped) continue;
      const laneClip = clipX(laneXRaw, laneW, plotLeft, plotRight);
      if (!laneClip) continue;
      const primary = [...arr].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
      const anyKey = arr.some(m => m.key === true);
      const allDelta = arr.length > 0 && arr.every(m => m.key === false);
      glyphs.push({
        kind: 'sample', slot, mediaId: media.mediaId, sourceVersion: media.sourceVersion,
        sampleId: primary.sampleId, indexRevision: media.indexRevision,
        axisUs: Math.round(midAnchor), sessionPtsUs: null,
        rect: { x: clipped.x, y: rowY + rowH - 2 - h, width: clipped.w, height: h },
        interactionRect: { x: laneClip.x, y: rowY, width: laneClip.w, height: rowH },
        key: anyKey ? true : allDelta ? false : null,
        sizeBytes: maxSize,
        stackedCount: arr.length, stackedIds: arr.map(m => m.sampleId),
        clusterStartUs: Math.round(lo), clusterEndUs: Math.round(hi),
      });
    }
  }
  return glyphs;
}

type GroupSampleRefLike = { sampleId: string; axisUs: number; sessionPtsUs: number | null; sizeBytes: number | null; key: boolean | null };

export interface BucketInput {
  slot: Slot;
  bucketIndex: number;
  startUs: number;
  endUs: number;
  count: number;
  maxBytes: number;
  sumBytes?: number;
  keyCount?: number;
  deltaCount?: number;
  unknownCount?: number;
  complete?: boolean;
  maxSampleId?: string | null;
}

/**
 * 合并行的共享桶布局：各轨使用完全相同的公共时间桶边界，
 * 同一区间内按稳定顺序并排峰值柱；无数据不画零帧。
 */
export function layoutMergedBuckets(
  bucketsBySlot: ReadonlyMap<Slot, readonly BucketInput[]>,
  opts: Omit<MergedLayoutOptions, 'yMaxSize' | 'mediaBySlot'> & { yMaxSize: number },
): BucketGlyph[] {
  const { trackOrder, viewStart, viewEnd, gutter, plotW, rowY, rowH, yMaxSize } = opts;
  const scale = opts.scale ?? 'linear';
  const lanes = Math.max(1, trackOrder.length);
  const slotIndex = new Map<Slot, number>(trackOrder.map((s, i) => [s, i]));
  // 按完整区间归并：对齐的共享桶自然同组；未对齐的旧数据按各自区间绘制，不互相覆盖。
  const byInterval = new Map<string, { startUs: number; endUs: number; perSlot: Map<Slot, BucketInput> }>();
  for (const [slot, buckets] of bucketsBySlot) {
    for (const b of buckets) {
      if (!b.count) continue;
      if (b.endUs <= viewStart || b.startUs >= viewEnd) continue;
      const key = `${b.startUs}:${b.endUs}`;
      let entry = byInterval.get(key);
      if (!entry) {
        entry = { startUs: b.startUs, endUs: b.endUs, perSlot: new Map() };
        byInterval.set(key, entry);
      }
      entry.perSlot.set(slot, b);
    }
  }
  const glyphs: BucketGlyph[] = [];
  const plotLeft = gutter, plotRight = gutter + plotW;
  const sorted = [...byInterval.values()].sort((a, b) => a.startUs - b.startUs);
  for (const entry of sorted) {
    const x1 = timeToX(viewStart, viewEnd, gutter, plotW, Math.max(entry.startUs, viewStart));
    const x2 = timeToX(viewStart, viewEnd, gutter, plotW, Math.min(entry.endUs, viewEnd));
    const full = Math.max(0, x2 - x1);
    if (full <= 0) continue;
    const laneW = full / lanes;
    for (const [slot, b] of entry.perSlot) {
      const lane = slotIndex.get(slot);
      if (lane == null) continue;
      const x = x1 + lane * laneW;
      const w = Math.min(chartBarWidth(laneW), opts.barWidthPx ?? Infinity);
      const h = barHeight(rowH, b.maxBytes, yMaxSize, scale);
      const cx = Math.min(Math.max(x + (laneW - w) / 2, plotLeft), plotRight - w);
      glyphs.push({
        kind: 'bucket', slot, bucketIndex: b.bucketIndex,
        startUs: b.startUs, endUs: b.endUs,
        rect: { x: cx, y: rowY + rowH - 2 - h, width: w, height: h },
        interactionRect: { x, y: rowY, width: laneW, height: rowH },
        count: b.count, maxBytes: b.maxBytes,
        sumBytes: b.sumBytes ?? 0,
        keyCount: b.keyCount ?? 0, deltaCount: b.deltaCount ?? 0, unknownCount: b.unknownCount ?? 0,
        complete: b.complete ?? true, maxSampleId: b.maxSampleId ?? null,
      });
    }
  }
  return glyphs;
}

/** 分轨行布局：同一套时间分组，各轨在各自的行高里绘制，x 仍共享时间轴。 */
export function layoutRowSamples(
  groups: readonly TimeGroup[],
  slot: Slot,
  row: SizeRow,
  base: Omit<MergedLayoutOptions, 'trackOrder' | 'rowY' | 'rowH' | 'mediaBySlot'> & {
    media: { mediaId: string; sourceVersion: string; indexRevision: number };
  },
): SampleGlyph[] {
  const glyphs = layoutMergedSamples(groups, {
    trackOrder: [slot],
    viewStart: base.viewStart, viewEnd: base.viewEnd,
    gutter: base.gutter, plotW: base.plotW,
    rowY: row.y, rowH: row.h, yMaxSize: base.yMaxSize,
    mediaBySlot: new Map([[slot, base.media]]),
    maxCellPx: base.maxCellPx,
    scale: base.scale,
  });
  return glyphs;
}

/** 直接命中实际柱/交互单元格，返回唯一身份；点击与高亮共用。 */
export function pickGlyph(glyphs: readonly AnalysisGlyph[], x: number, y: number): AnalysisGlyph | null {
  for (const g of glyphs) {
    const r = g.interactionRect ?? g.rect;
    if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return g;
  }
  // 柱体很细时允许 2px 的水平容差，但仍只命中最近的一个，不猜邻柱。
  let best: AnalysisGlyph | null = null;
  let bestDx = 2;
  for (const g of glyphs) {
    const r = g.interactionRect ?? g.rect;
    if (y < r.y || y >= r.y + r.height) continue;
    const dx = x < r.x ? r.x - x : x >= r.x + r.width ? x - (r.x + r.width) + 1 : 0;
    if (dx <= bestDx) {
      // 同 x 下优先更窄/更贴近的柱，避免跨轨误吸。
      if (!best || dx < bestDx) { best = g; bestDx = dx; }
    }
  }
  return best;
}

/** Keep complete tooltip contents in chart order, moving neighbours before scrolling the stack. */
export function layoutAnalysisCards(cards: readonly { height: number; preferredTop: number }[], top: number, bottom: number, gap = 8) {
  const totalHeight = cards.reduce((sum, card) => sum + card.height, 0) + Math.max(0, cards.length - 1) * gap;
  const scroll = totalHeight > bottom - top;
  const tops: number[] = [];
  for (const [i, card] of cards.entries()) {
    const preferred = scroll ? top : Math.max(top, Math.min(bottom - card.height, card.preferredTop));
    tops.push(Math.max(preferred, i ? tops[i - 1] + cards[i - 1].height + gap : top));
  }
  if (!scroll && cards.length) {
    const last = cards.length - 1;
    tops[last] = Math.min(tops[last], bottom - cards[last].height);
    for (let i = last - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - gap - cards[i].height);
  }
  return { tops, scroll, totalHeight };
}
