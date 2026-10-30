// 时间投影与视口缩放的纯算法（无 DOM、无 IO）。
// sessionUs = normalizedMediaUs + offsetUs；正偏移表示该轨延后。

import type { AnalysisSample } from './types.ts';

export const projectToSession = (normalizedMediaUs: number, offsetUs: number): number =>
  normalizedMediaUs + offsetUs;

/** 轴取值；缺失轴的样本不进入该轴索引（不伪造）。 */
export function axisOf(sample: AnalysisSample, axis: 'pts' | 'dts'): number | null {
  return axis === 'pts' ? sample.effectivePtsUs : sample.dtsUs;
}

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
/** Fixed overview axis: center the new selection on the time under the pointer. */
export function zoomOverviewRange(range: { start: number; end: number }, domain: { start: number; end: number }, fraction: number, factor: number, minSpan: number) {
  const time = domain.start + Math.max(0, Math.min(1, fraction)) * (domain.end - domain.start);
  const span = Math.min(domain.end - domain.start, Math.max(minSpan, (range.end - range.start) * factor));
  const start = Math.max(domain.start, Math.min(domain.end - span, time - span / 2));
  return { start: Math.floor(start), end: Math.ceil(start + span) };
}
