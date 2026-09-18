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
/** 详细模式目标柱宽（CSS px）：同一视口一致，不随稀疏/缺席变化。 */
export const TARGET_BAR_PX = 7;
const LANE_GAP_PX = 1;

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
  /** 大小纵轴：默认线性；对数为共同 log10(1+v) 基准。 */
  scale?: SizeScale;
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
  const scale = opts.scale ?? 'linear';
  void MAX_CELL_PX;
  void opts.maxCellPx;
  const lanes = Math.max(1, trackOrder.length);
  const slotIndex = new Map<Slot, number>(trackOrder.map((s, i) => [s, i]));
  const glyphs: SampleGlyph[] = [];
  // 视口选择按成员范围相交（锚点在外、成员在内仍保留）；边界计算用完整组序列的
  // 真实前后邻锚点，不因滚动裁切改变单元归属；最后裁剪实际 glyph。
  const selected: { group: TimeGroup; prevAnchor: number | null; nextAnchor: number | null }[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const lo = Math.min(g.memberMinUs, g.memberMaxUs, g.anchorUs);
    const hi = Math.max(g.memberMinUs, g.memberMaxUs, g.anchorUs);
    if (hi < viewStart || lo > viewEnd) continue;
    selected.push({
      group: g,
      prevAnchor: i > 0 ? groups[i - 1].anchorUs : null,
      nextAnchor: i + 1 < groups.length ? groups[i + 1].anchorUs : null,
    });
  }
  // 一致目标宽度：稀疏不撑宽、缺席留空；局部放不下时保留身份（重叠绘制+聚合标记），
  // 不用极近异常组把全图压成 1px，也不扩大时间容差。
  const laneW = TARGET_BAR_PX + LANE_GAP_PX;
  const cellTarget = laneW * lanes;
  const plotLeft = gutter, plotRight = gutter + plotW;
  for (const { group } of selected) {
    const anchorX = timeToX(viewStart, viewEnd, gutter, plotW, group.anchorUs);
    // 以真实时间锚点为中心，固定单元；时间关系由锚点距离表达，不由柱宽编码。
    const cellLeftRaw = anchorX - cellTarget / 2;
    // 注：prev/next 锚点保留用于未来密集聚合判断，当前固定宽度不随其变化。
    const cellLeft = Math.min(Math.max(cellLeftRaw, plotLeft), plotRight);
    const cellRight = Math.min(Math.max(cellLeftRaw + cellTarget, plotLeft), plotRight);
    if (cellRight <= cellLeft) continue;
    for (const [slot, members] of group.membersByTrack) {
      const lane = slotIndex.get(slot);
      if (lane == null) continue;
      const laneX = cellLeft + lane * laneW;
      const media = mediaBySlot.get(slot);
      if (!media) continue;
      // 只绘制视口内成员；锚点在外、成员在内的组仍保留该成员。
      const visible = members.filter(m => m.axisUs >= viewStart && m.axisUs <= viewEnd);
      if (!visible.length) continue;
      if (visible.length === 1) {
        const m = visible[0];
        const h = barHeight(rowH, m.sizeBytes ?? 0, yMaxSize, scale);
        const barW = TARGET_BAR_PX;
        // 柱在 lane 内居中，锚点附近；缺席轨道自然留空。
        const x = Math.min(Math.max(laneX + (laneW - barW) / 2, plotLeft), plotRight - barW);
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
        const subW = laneW / visible.length;
        if (subW >= 2) {
          visible.forEach((m, k) => {
            const h = barHeight(rowH, m.sizeBytes ?? 0, yMaxSize, scale);
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
          const primary = [...visible].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
          const h = barHeight(rowH, primary.sizeBytes ?? 0, yMaxSize, scale);
          const barW = TARGET_BAR_PX;
          const x = Math.min(Math.max(laneX + (laneW - barW) / 2, plotLeft), plotRight - barW);
          glyphs.push({
            kind: 'sample', slot, mediaId: media.mediaId, sourceVersion: media.sourceVersion,
            sampleId: primary.sampleId, indexRevision: media.indexRevision,
            axisUs: primary.axisUs, sessionPtsUs: primary.sessionPtsUs,
            rect: { x, y: rowY + rowH - 2 - h, width: barW, height: h },
            interactionRect: { x: laneX, y: rowY, width: laneW, height: rowH },
            key: primary.key, sizeBytes: primary.sizeBytes ?? 0,
            stackedCount: visible.length, stackedIds: visible.map(m => m.sampleId),
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
      const w = Math.max(1, laneW - 1);
      const h = barHeight(rowH, b.maxBytes, yMaxSize, scale);
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
