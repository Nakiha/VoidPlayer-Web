import type { Slot } from '../../model.ts';
import type { AnalysisResult } from '../../analysis/types.ts';
import { niceCeiling, shouldBucketize } from '../../analysis/statistics.ts';
import { groupSamples } from '../../analysis/grouping.ts';
import type { GroupSampleRef, TimeGroup } from '../../analysis/grouping.ts';
import { coarsenBucketsShared, estimateBaseBucketWidth, isBucketGridCompatible, planSharedCoarseWidth } from '../../analysis/inspection.ts';
import { canLayoutRaw, layoutMergedBuckets, layoutMergedSamples } from '../analysis-geometry.ts';
import type { AnalysisGlyph, BucketGlyph, SampleGlyph } from '../analysis-geometry.ts';
import { computeLayout, desiredHeight } from '../analysis-canvas.ts';
import type { CanvasColors, CanvasModel, CanvasTrack } from '../analysis-canvas.ts';
import type { AnalysisPreferences } from './preferences.ts';

const GROUP_TOLERANCE_US = 2000;
/** Pure chart model: statistics, LOD and glyph identity share one geometry.
 * DOM measurement and drawing stay in the panel. */
export function buildAnalysisModel({ sel, results, prefs, range, width, availableHeight, slotColors, colors, rubber }: {
  sel: { slot: Slot; mediaId: string }[]; results: Map<Slot, AnalysisResult>; prefs: AnalysisPreferences;
  range: { start: number; end: number }; width: number; availableHeight: number;
  slotColors: Map<Slot, string>; colors: CanvasColors; rubber: { a: number; b: number } | null;
}): (CanvasModel & { glyphs: AnalysisGlyph[]; groups: TimeGroup[] }) | null {
  if (!sel.length) return null;
  const inView = (t: number) => t >= range.start && t <= range.end;
  // 图宽来自绘图区实际宽度（画布全宽）；x 换算、查询、命中统一用它。
  const merged = prefs.layoutMode === 'merged';
  const plotW = Math.max(1, width - 46);
  // LOD：每个样本至少容纳 1px 柱 + 1px 间隔；柱宽按时间轴比例连续计算。
  // 逐样本可用当且仅当全部选中轨都有完整 raw；否则用共享桶，仍保持合并。
  // 计数只看视口内（查询含预取 margin，视口外不参与），放大后可从桶切回 raw。
  let totalRawInView = 0;
  let allRaw = true;
  for (const t of sel) {
    const r = results.get(t.slot);
    if (!r || r.truncated || !r.samples.length) { allRaw = false; break; }
    let n = 0;
    for (const s of r.samples) {
      const axisT = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
      if (axisT != null && axisT >= range.start && axisT <= range.end) n++;
    }
    totalRawInView += n;
  }
  // 分组先行：容量复核需要真实组锚点，不能只看平均密度。
  // 分组只取视口 + 容差 halo，避免视口裁切改变边缘组组成，也避免长片全量分组。
  const groupInputs: { slot: Slot; samples: GroupSampleRef[] }[] = [];
  if (allRaw && totalRawInView > 0) {
    const halo = GROUP_TOLERANCE_US + 1000;
    for (const t of sel) {
      const r = results.get(t.slot)!;
      const refs: GroupSampleRef[] = [];
      for (const s of r.samples) {
        const axisT = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
        if (axisT == null || !Number.isFinite(axisT)) continue;
        if (axisT < range.start - halo || axisT > range.end + halo) continue;
        refs.push({
          sampleId: s.sampleId, axisUs: axisT, sessionPtsUs: s.effectivePtsUs,
          sizeBytes: s.sizeBytes,
          key: s.randomAccess === 'yes' ? true : s.randomAccess === 'no' ? false : null,
          decodeOrdinal: s.decodeOrdinal, mediaId: t.mediaId,
          sourceVersion: r.sourceVersion, indexRevision: r.indexRevision,
        });
      }
      groupInputs.push({ slot: t.slot, samples: refs });
    }
  }
  const preGroups: TimeGroup[] = groupInputs.length ? groupSamples(groupInputs, GROUP_TOLERANCE_US) : [];
  // 视口内无样本时不断言 raw 可用，走桶/空态，避免 0 样本误判为稀疏。
  // 平均密度通过后仍复核局部密集组，绘图与容量判断使用相同的连续柱宽。
  const lanesForCap = Math.max(1, merged ? sel.length : 1);
  const useRaw = allRaw && totalRawInView > 0
    && !shouldBucketize(totalRawInView, plotW, 2)
    && canLayoutRaw(preGroups, range.start, Math.max(range.start + 1, range.end), 46, plotW, lanesForCap);
  const canvasTracks: CanvasTrack[] = [];
  // 纵轴按视口内数据取最大（查询含预取 margin，视口外峰值不参与），
  // 同一指标跨轨共用零起点和纵轴范围。
  let yMaxBitrate = 0, yMaxSize = 0;
  for (const t of sel) {
    const r = results.get(t.slot);
    if (!r) continue;
    const canvasSamples = (useRaw && !r.truncated && r.samples.length)
      ? r.samples.map(s => {
        const axisT = prefs.axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
        return {
          t: axisT ?? Number.NaN,
          size: s.sizeBytes ?? 0,
          key: s.randomAccess === 'yes' ? true : s.randomAccess === 'no' ? false : null,
        };
      }).filter(s => Number.isFinite(s.t)) : null;
    if (canvasSamples) for (const s of canvasSamples) if (inView(s.t)) yMaxSize = Math.max(yMaxSize, s.size);
    for (const b of r.buckets ?? []) {
      if (b.endUs <= range.start || b.startUs >= range.end || !b.count) continue;
      // raw 可用时纵轴仍以视口内 raw 为主，桶仅作兜底；桶模式下用峰值。
      if (!useRaw) yMaxSize = Math.max(yMaxSize, b.maxBytes);
      else if (!canvasSamples) yMaxSize = Math.max(yMaxSize, b.maxBytes);
    }
    if (useRaw && canvasSamples) {
      // raw 模式下桶不参与纵轴，避免预取桶的视口外峰值抬高轴。
    } else if (!useRaw) {
      // 桶模式已在上面统计。
    }
    for (const p of r.bitrate ?? []) {
      if (p.mbps != null && p.tUs >= range.start && p.tUs <= range.end) yMaxBitrate = Math.max(yMaxBitrate, p.mbps);
    }
    canvasTracks.push({
      slot: t.slot,
      color: slotColors.get(t.slot) ?? '#888',
      bitrate: (r.bitrate ?? []).map(p => ({ t: p.tUs, mbps: p.mbps })),
      provisional: r.capability.indexState !== 'complete',
    });
  }
  if (!canvasTracks.length) return null;
  const groups: TimeGroup[] = useRaw ? preGroups : [];
  const rows = prefs.showSize ? (merged ? 1 : canvasTracks.length) : 0;
  const need = desiredHeight(prefs.showBitrate, rows);
  const height = Math.max(availableHeight || 220, need);
  const viewEnd = Math.max(range.start + 1, range.end);
  // 统一几何：组宽来自公共时间组，缺席留空；绘图与命中共用。
  // 行高与绘制共用 computeLayout，不复制公式；先算布局，再按行生成 glyph。
  const layoutProbe: CanvasModel = {
    width, height, viewStart: range.start, viewEnd,
    showBitrate: prefs.showBitrate, showSize: prefs.showSize, colorByType: false,
    tracks: canvasTracks, merged,
    yMaxBitrate: 0, yMaxSize: 0, colors, rubber,
  };
  const layout = computeLayout(layoutProbe);
  const bitrateH = layout.bitrate?.h ?? 0;
  const perRow = layout.sizeRows[0]?.h ?? 0;
  const yMaxSizeNice = niceCeiling(yMaxSize);
  let sampleGlyphs: SampleGlyph[] = [];
  let bucketGlyphs: BucketGlyph[] = [];
  const mediaBySlot = new Map<Slot, { mediaId: string; sourceVersion: string; indexRevision: number }>(
    sel.map(t => {
      const r = results.get(t.slot);
      return [t.slot, {
        mediaId: t.mediaId,
        sourceVersion: r?.sourceVersion ?? `${t.mediaId}@0`,
        indexRevision: r?.indexRevision ?? 0,
      }] as const;
    }),
  );
  if (prefs.showSize && rows) {
    if (merged) {
      const rowY = bitrateH, rowH = perRow;
      if (useRaw) {
        sampleGlyphs = layoutMergedSamples(groups, {
          trackOrder: sel.map(t => t.slot),
          viewStart: range.start, viewEnd,
          gutter: layout.gutter, plotW: layout.plotW, rowY, rowH, yMaxSize: yMaxSizeNice, mediaBySlot,
          scale: 'linear',
        });
      } else {
        // 多轨密集时选更粗的桶，保证每组仍有位置画不同轨道，不压成同一像素。
        // 按公共粗时间下标聚合（会话域原点 0），不按非空位置分批；空桶不绘制，
        // 但不先从时间格删除，不同稀疏度的轨道仍落到同一套边界。
        // R3/B1：公共网格由规划器一次决定、不可变下发。各轨独立查询/缓存，
        // 基础网格未必相同。优先用结果自带的 bucketGrid，缺失时回退到估计；
        // 仅当全部轨道都与公共粗网格兼容时才合并，否则整体回退到原始桶
        // （不逐轨各自舍入、不把不同边界并排冒充同一时间组；未知覆盖由
        // coarsenBucketsShared 向上传播为 complete=false）。
        const lanes = Math.max(1, sel.length);
        const span = Math.max(1, viewEnd - range.start);
        const baseBySlot = new Map<Slot, number>();
        for (const t of sel) {
          const r = results.get(t.slot);
          const gridW = r?.bucketGrid?.widthUs;
          const w = (typeof gridW === 'number' && gridW > 0)
            ? gridW
            : estimateBaseBucketWidth(r?.buckets);
          if (w != null && w > 0) baseBySlot.set(t.slot, w);
        }
        const bases = [...baseBySlot.values()];
        const baseMin = bases.length ? Math.min(...bases) : null;
        const timePerPx = span / Math.max(1, plotW);
        const needed = timePerPx * 2 * lanes;
        // 公共目标只定一次：找同时是所有 base 整数倍、>= needed 的最小宽度
        //（有界，避免 10ms/11ms 之类组合爆出巨桶）。找不到则整体回退。
        const coarseWidth = bases.length && baseMin != null && needed > baseMin
          ? planSharedCoarseWidth(bases, needed, span)
          : null;
        const bucketsBySlot = new Map<Slot, { slot: Slot; bucketIndex: number; startUs: number; endUs: number; count: number; maxBytes: number; sumBytes: number; keyCount: number; deltaCount: number; unknownCount: number; complete: boolean; maxSampleId: string | null }[]>();
        const toOriginal = (slot: Slot, list: { startUs: number; endUs: number; count: number; maxBytes: number; sumBytes: number; keyCount: number; deltaCount: number; unknownCount: number; complete: boolean; maxSampleId: string | null }[]) => {
          const nonEmpty = list.filter(b => b.count > 0);
          bucketsBySlot.set(slot, nonEmpty.map((b, i) => ({
            slot, bucketIndex: i, startUs: b.startUs, endUs: b.endUs,
            count: b.count, maxBytes: b.maxBytes, sumBytes: b.sumBytes,
            keyCount: b.keyCount, deltaCount: b.deltaCount, unknownCount: b.unknownCount,
            complete: b.complete, maxSampleId: b.maxSampleId,
          })));
        };
        const inViewBySlot = new Map<Slot, { startUs: number; endUs: number; count: number; maxBytes: number; sumBytes: number; keyCount: number; deltaCount: number; unknownCount: number; complete: boolean; maxSampleId: string | null }[]>();
        for (const t of sel) {
          const r = results.get(t.slot);
          inViewBySlot.set(t.slot, (r?.buckets ?? []).filter(b => b.endUs > range.start && b.startUs < viewEnd));
        }
        // 全轨一致判定：任一轨不兼容则整体回退，不逐轨混用不同边界。
        const allCompatible = coarseWidth != null && baseMin != null && coarseWidth > baseMin
          && sel.every(t => {
            const trackBase = baseBySlot.get(t.slot) ?? baseMin!;
            return isBucketGridCompatible(inViewBySlot.get(t.slot) ?? [], trackBase, coarseWidth, 0);
          });
        sel.forEach(t => {
          const inView = inViewBySlot.get(t.slot) ?? [];
          if (!allCompatible || coarseWidth == null || baseMin == null) {
            toOriginal(t.slot, inView);
          } else {
            const trackBase = baseBySlot.get(t.slot) ?? baseMin!;
            const coarse = coarsenBucketsShared(inView, trackBase, coarseWidth, 0);
            bucketsBySlot.set(t.slot, coarse.map(b => ({
              slot: t.slot, bucketIndex: b.coarseIndex, startUs: b.startUs, endUs: b.endUs,
              count: b.count, maxBytes: b.maxBytes, sumBytes: b.sumBytes,
              keyCount: b.keyCount, deltaCount: b.deltaCount, unknownCount: b.unknownCount,
              complete: b.complete, maxSampleId: b.maxSampleId,
            })));
          }
        });
        bucketGlyphs = layoutMergedBuckets(bucketsBySlot, {
          trackOrder: sel.map(t => t.slot),
          viewStart: range.start, viewEnd, gutter: layout.gutter, plotW: layout.plotW, rowY, rowH, yMaxSize: yMaxSizeNice,
          scale: 'linear',
        });
      }
    } else {
      // 分轨：同一套时间分组，各轨在各自行里，x 仍共享时间轴。
      sel.forEach((t, i) => {
        const rowY = bitrateH + i * perRow, rowH = perRow;
        if (useRaw) {
          // 分轨仍用公共时间组锚点计算单元，保证跨轨 x 对齐，各轨只取自己的成员。
          sampleGlyphs.push(...layoutMergedSamples(groups.filter(gr => gr.membersByTrack.has(t.slot)), {
            trackOrder: [t.slot],
            viewStart: range.start, viewEnd, gutter: layout.gutter, plotW: layout.plotW, rowY, rowH, yMaxSize: yMaxSizeNice,
            mediaBySlot: new Map([[t.slot, mediaBySlot.get(t.slot)!]]),
            scale: 'linear',
          }));
        } else {
          const r = results.get(t.slot);
          const bucketsBySlot = new Map<Slot, { slot: Slot; bucketIndex: number; startUs: number; endUs: number; count: number; maxBytes: number; sumBytes: number; keyCount: number; deltaCount: number; unknownCount: number; complete: boolean; maxSampleId: string | null }[]>();
          bucketsBySlot.set(t.slot, (r?.buckets ?? []).map((b, i) => ({
            slot: t.slot, bucketIndex: i, startUs: b.startUs, endUs: b.endUs,
            count: b.count, maxBytes: b.maxBytes, sumBytes: b.sumBytes,
            keyCount: b.keyCount, deltaCount: b.deltaCount, unknownCount: b.unknownCount,
            complete: b.complete, maxSampleId: b.maxSampleId,
          })));
          bucketGlyphs.push(...layoutMergedBuckets(bucketsBySlot, {
            trackOrder: [t.slot],
            viewStart: range.start, viewEnd, gutter: layout.gutter, plotW: layout.plotW, rowY, rowH, yMaxSize: yMaxSizeNice,
            scale: 'linear',
          }));
        }
      });
    }
  }
  return {
    width, height,
    viewStart: range.start, viewEnd,
    // 多轨主体色恒为轨道色（与曲线/表头一致），关键只用顶端菱形/K 标记。
    showBitrate: prefs.showBitrate, showSize: prefs.showSize, colorByType: false,
    tracks: canvasTracks, merged,
    yMaxBitrate: niceCeiling(yMaxBitrate), yMaxSize: yMaxSizeNice,
    colors, rubber,
    sampleGlyphs, bucketGlyphs,
    glyphs: [...sampleGlyphs, ...bucketGlyphs] as AnalysisGlyph[],
    groups,
  };
}
