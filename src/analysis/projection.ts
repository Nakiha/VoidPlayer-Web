// 时间投影、稳定顺序与多轨匹配的纯算法（无 DOM、无 IO）。
// sessionUs = normalizedMediaUs + offsetUs；正偏移表示该轨延后。

import type { AnalysisSample } from './types.ts';

export const projectToSession = (normalizedMediaUs: number, offsetUs: number): number =>
  normalizedMediaUs + offsetUs;

/** 轴取值；缺失轴的样本不进入该轴索引（不伪造）。 */
export function axisOf(sample: AnalysisSample, axis: 'pts' | 'dts'): number | null {
  return axis === 'pts' ? sample.effectivePtsUs : sample.dtsUs;
}

/**
 * 按轴建立稳定索引：不就地重排 demux 原数组；相同时间戳用
 * decodeOrdinal / sampleId 作 tie-break，不丢弃重复项。
 */
export function buildAxisIndex(
  samples: AnalysisSample[],
  axis: 'pts' | 'dts',
  offsetUs: number,
): { order: number[]; times: Float64Array } {
  const entries: { idx: number; t: number; ordinal: number; id: string }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const raw = axisOf(samples[i], axis);
    if (raw == null || !Number.isFinite(raw)) continue;
    entries.push({ idx: i, t: raw + offsetUs, ordinal: samples[i].decodeOrdinal, id: samples[i].sampleId });
  }
  entries.sort((a, b) => a.t - b.t || a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order = entries.map(e => e.idx);
  const times = new Float64Array(entries.map(e => e.t));
  return { order, times };
}

export interface PairMatch {
  a: number;
  b: number;
  dtUs: number;
}

/**
 * 严格时间配对：仅当 |dt| <= toleranceUs 才配对，每个样本最多用一次，
 * 时间差写入 tooltip。帧率不同/VFR/缺帧导致无法一一对应时，调用方必须
 * 回退到分轨行；不得复制样本凑配对，不得在码率里重复计数。
 */
export function matchPairsStrict(
  aTimes: ArrayLike<number>,
  bTimes: ArrayLike<number>,
  toleranceUs: number,
): { pairs: PairMatch[]; unmatchedA: number[]; unmatchedB: number[] } {
  const pairs: PairMatch[] = [];
  const usedB = new Array(bTimes.length).fill(false);
  let j = 0;
  for (let i = 0; i < aTimes.length; i++) {
    while (j < bTimes.length && bTimes[j] < aTimes[i] - toleranceUs) j++;
    let best = -1, bestDt = Infinity;
    for (let k = j; k < bTimes.length && bTimes[k] <= aTimes[i] + toleranceUs; k++) {
      if (usedB[k]) continue;
      const dt = Math.abs(bTimes[k] - aTimes[i]);
      if (dt < bestDt) { bestDt = dt; best = k; }
    }
    if (best >= 0) { usedB[best] = true; pairs.push({ a: i, b: best, dtUs: bTimes[best] - aTimes[i] }); }
  }
  const matchedA = new Set(pairs.map(p => p.a));
  const matchedB = new Set(pairs.map(p => p.b));
  const unmatchedA: number[] = [];
  const unmatchedB: number[] = [];
  for (let i = 0; i < aTimes.length; i++) if (!matchedA.has(i)) unmatchedA.push(i);
  for (let j = 0; j < bTimes.length; j++) if (!matchedB.has(j)) unmatchedB.push(j);
  return { pairs, unmatchedA, unmatchedB };
}

export type TrackLayout = 'paired' | 'rows';

/**
 * 以 center 为锚点的区间缩放（滚轮 Ctrl / 触摸板捏合共用）。
 * factor > 1 放大区间（缩小画面），factor < 1 缩小区间（放大画面）；
 * 结果钳制在 domain 内且不小于 minSpan。
 */
export function zoomTimeRange(
  start: number, end: number, center: number, factor: number,
  minSpan: number, domain: { start: number; end: number },
): { start: number; end: number } {
  const span = Math.max(1, end - start);
  const domainSpan = Math.max(minSpan, domain.end - domain.start);
  const newSpan = Math.min(Math.max(span * factor, minSpan), domainSpan);
  const frac = Math.min(1, Math.max(0, (center - start) / span));
  const s = Math.min(Math.max(center - newSpan * frac, domain.start), domain.end - newSpan);
  return { start: Math.floor(s), end: Math.ceil(s + newSpan) };
}

/** 区间平移（滚轮 / 触摸板双指滑动共用），钳制在 domain 内。 */
export function panTimeRange(
  start: number, end: number, shiftUs: number,
  domain: { start: number; end: number },
): { start: number; end: number } {
  const span = Math.max(1, end - start);
  if (span >= domain.end - domain.start) return { start: domain.start, end: domain.end };
  const s = Math.min(Math.max(start + shiftUs, domain.start), domain.end - span);
  return { start: Math.floor(s), end: Math.ceil(s + span) };
}
/**
 * 双轨并排柱仅在明确对齐关系下使用：配对覆盖率足够高且时间差全部在
 * 容差内；否则分轨行。三轨及以上直接分行。
 */
export function decideLayout(options: {
  trackCount: number;
  pairCoverage?: number;
  maxAbsDtUs?: number;
  toleranceUs?: number;
  minCoverage?: number;
}): TrackLayout {
  if (options.trackCount !== 2) return 'rows';
  const minCoverage = options.minCoverage ?? 0.9;
  const coverage = options.pairCoverage ?? 0;
  if (coverage < minCoverage) return 'rows';
  if (options.maxAbsDtUs != null && options.toleranceUs != null && options.maxAbsDtUs > options.toleranceUs) return 'rows';
  return 'paired';
}
