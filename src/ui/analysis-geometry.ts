// 码流分析的统一柱形几何：时间分组 → 柱形几何 → 绘图与命中共同消费。
// 组宽来自前后组的共同边界，不再依据各轨自己的帧间隔；缺席留空，不复制。
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
  /** 真正的轴时间，不因柱子侧向错开而改变。 */
  axisUs: number;
  /** 可信展示 PTS（会话时间），点击定位用它；预滚/无映射为 null。 */
  sessionPtsUs: number | null;
  rect: Rect;
  interactionRect: Rect;
  key: boolean | null;
  sizeBytes: number;
  stackedCount: number;
  stackedIds: string[];
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

/** 数据与刻度共用的纵轴映射：零在下，上限在上。 */
export function valueToY(rowY: number, rowH: number, value: number, yMax: number): number {
  if (!(yMax > 0)) return rowY + rowH - 4;
  const h = Math.max(1, (Math.min(value, yMax) / yMax) * (rowH - 8));
  return rowY + rowH - 4 - h;
}

export function barHeight(rowH: number, value: number, yMax: number): number {
  if (!(yMax > 0)) return 1;
  return Math.max(1, (Math.min(value, yMax) / yMax) * (rowH - 6));
}

const MAX_CELL_PX = 56;

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
}

function timeToX(viewStart: number, viewEnd: number, gutter: number, plotW: number, t: number): number {
  const span = Math.max(1, viewEnd - viewStart);
  return gutter + ((t - viewStart) / span) * plotW;
}

/**
 * 合并行的逐样本布局：组中心锚定真实时间，各轨按稳定顺序小幅错开。
 * 同轨重复时间戳在组内单元继续细分；放不下聚合为多样本标记，点击展开。
 */
export function layoutMergedSamples(
  groups: readonly TimeGroup[],
  opts: MergedLayoutOptions,
): SampleGlyph[] {
  const { trackOrder, viewStart, viewEnd, gutter, plotW, rowY, rowH, yMaxSize, mediaBySlot } = opts;
  const maxCellPx = opts.maxCellPx ?? MAX_CELL_PX;
  const lanes = Math.max(1, trackOrder.length);
  const slotIndex = new Map<Slot, number>(trackOrder.map((s, i) => [s, i]));
  const glyphs: SampleGlyph[] = [];
  const inView = groups.filter(g => g.anchorUs >= viewStart && g.anchorUs <= viewEnd);
  for (let gi = 0; gi < inView.length; gi++) {
    const group = inView[gi];
    const prevAnchor = gi > 0 ? inView[gi - 1].anchorUs : null;
    const nextAnchor = gi + 1 < inView.length ? inView[gi + 1].anchorUs : null;
    const leftT = prevAnchor == null ? viewStart : (prevAnchor + group.anchorUs) / 2;
    const rightT = nextAnchor == null ? viewEnd : (group.anchorUs + nextAnchor) / 2;
    let cellLeft = timeToX(viewStart, viewEnd, gutter, plotW, Math.max(viewStart, leftT));
    let cellRight = timeToX(viewStart, viewEnd, gutter, plotW, Math.min(viewEnd, rightT));
    if (cellRight < cellLeft) [cellLeft, cellRight] = [cellRight, cellLeft];
    let cellW = Math.max(0, cellRight - cellLeft);
    const anchorX = timeToX(viewStart, viewEnd, gutter, plotW, group.anchorUs);
    // 宽度上限与真实锚点分离：稀疏时以锚点为中心收拢，不形成巨柱。
    if (cellW > maxCellPx * lanes) {
      const capped = maxCellPx * lanes;
      cellLeft = anchorX - capped / 2;
      cellRight = anchorX + capped / 2;
      cellW = capped;
    }
    // 裁剪到绘图区，不盖住左侧刻度。
    const plotLeft = gutter, plotRight = gutter + plotW;
    cellLeft = Math.min(Math.max(cellLeft, plotLeft), plotRight);
    cellRight = Math.min(Math.max(cellRight, plotLeft), plotRight);
    cellW = Math.max(0, cellRight - cellLeft);
    if (cellW <= 0) continue;
    const laneW = cellW / lanes;
    for (const [slot, members] of group.membersByTrack) {
      const lane = slotIndex.get(slot);
      if (lane == null) continue;
      const laneX = cellLeft + lane * laneW;
      const media = mediaBySlot.get(slot);
      if (!media) continue;
      if (members.length === 1) {
        const m = members[0];
        const h = barHeight(rowH, m.sizeBytes ?? 0, yMaxSize);
        const barW = Math.max(1, laneW - 1);
        // 柱在 lane 内居中，锚点附近；缺席轨道自然留空。
        const x = Math.min(Math.max(laneX, plotLeft), plotRight - barW);
        glyphs.push({
          kind: 'sample', slot, mediaId: media.mediaId, sourceVersion: media.sourceVersion,
          sampleId: m.sampleId, indexRevision: media.indexRevision,
          axisUs: m.axisUs, sessionPtsUs: m.sessionPtsUs,
          rect: { x, y: rowY + rowH - 2 - h, width: barW, height: h },
          interactionRect: { x: laneX, y: rowY, width: laneW, height: rowH },
          key: m.key, sizeBytes: m.sizeBytes ?? 0,
          stackedCount: 1, stackedIds: [m.sampleId],
        });
      } else {
        // 同轨重复时间戳：能细分则细分，否则聚合为多样本标记。
        const subW = laneW / members.length;
        if (subW >= 2) {
          members.forEach((m, k) => {
            const h = barHeight(rowH, m.sizeBytes ?? 0, yMaxSize);
            const barW = Math.max(1, subW - 1);
            const x = Math.min(Math.max(laneX + k * subW, plotLeft), plotRight - barW);
            glyphs.push({
              kind: 'sample', slot, mediaId: media.mediaId, sourceVersion: media.sourceVersion,
              sampleId: m.sampleId, indexRevision: media.indexRevision,
              axisUs: m.axisUs, sessionPtsUs: m.sessionPtsUs,
              rect: { x, y: rowY + rowH - 2 - h, width: barW, height: h },
              interactionRect: { x: laneX + k * subW, y: rowY, width: subW, height: rowH },
              key: m.key, sizeBytes: m.sizeBytes ?? 0,
              stackedCount: 1, stackedIds: [m.sampleId],
            });
          });
        } else {
          const primary = [...members].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
          const h = barHeight(rowH, primary.sizeBytes ?? 0, yMaxSize);
          const barW = Math.max(1, laneW - 1);
          const x = Math.min(Math.max(laneX, plotLeft), plotRight - barW);
          glyphs.push({
            kind: 'sample', slot, mediaId: media.mediaId, sourceVersion: media.sourceVersion,
            sampleId: primary.sampleId, indexRevision: media.indexRevision,
            axisUs: group.anchorUs, sessionPtsUs: primary.sessionPtsUs,
            rect: { x, y: rowY + rowH - 2 - h, width: barW, height: h },
            interactionRect: { x: laneX, y: rowY, width: laneW, height: rowH },
            key: primary.key, sizeBytes: primary.sizeBytes ?? 0,
            stackedCount: members.length, stackedIds: members.map(m => m.sampleId),
          });
        }
      }
    }
  }
  return glyphs;
}

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
      const w = Math.max(1, laneW - 1);
      const h = barHeight(rowH, b.maxBytes, yMaxSize);
      const cx = Math.min(Math.max(x, plotLeft), plotRight - w);
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
