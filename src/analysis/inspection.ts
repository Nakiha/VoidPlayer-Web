// 统一时间检查器：公共检查时间 T 负责所有轨道的指标读取，
// 直接 glyph 身份只负责主高亮与精确点击。纯逻辑，无 DOM。
// 与 tooltip/绘制解耦：调用方先算 InspectionState，再分别渲染表格与高亮。

import type { AnalysisCapability, AnalysisResult, AnalysisSample } from './types.ts';
import type { Slot } from '../model.ts';

export type CoverageState = 'known' | 'pending' | 'outside' | 'error' | 'unsupported';
export type RateKind = 'display-fps' | 'sample-rate';

export interface MetricReading {
  /** null 表示未知，不得转成 0。 */
  value: number | null;
  unit: string;
  /** 评价实际使用的时间（码率点时间）；精确计算时等于 T。 */
  evaluationTimeUs: number;
  windowUs: number;
  /** 距离评价点的偏差过大时标记近似，不静默替换口径。 */
  approximate: boolean;
  shortWindow: boolean;
  provisional: boolean;
  state: CoverageState;
  estimator: string;
  kind?: RateKind;
}

export interface ReferenceSample {
  sample: AnalysisSample;
  /** 样本轴时间（会话时间）。 */
  axisUs: number;
  dtUs: number;
  relation: 'exact' | 'nearby';
}

export interface TrackInspection {
  slot: Slot;
  bitrate: MetricReading;
  localRate: MetricReading;
  reference: ReferenceSample | null;
  /** 无新样本但覆盖已知时为 true（与未知覆盖区分）。 */
  emptyAtT: boolean;
  coverageState: CoverageState;
}

export interface DirectTarget {
  kind: 'sample' | 'bucket';
  slot: Slot;
  sampleId?: string;
  bucketStartUs?: number;
  bucketEndUs?: number;
}

export interface InspectionState {
  axis: 'pts' | 'dts';
  inspectionTimeUs: number;
  windowUs: number;
  directTarget: DirectTarget | null;
  tracks: TrackInspection[];
}

interface DerivedIndex {
  axis: 'pts' | 'dts';
  /** 按 (轴时间, decodeOrdinal, sampleId) 稳定排序后的样本下标。 */
  order: number[];
  times: Float64Array;
  prefix: Float64Array;
  medianGap: number;
}

// 不可变快照身份缓存：AnalysisResult 发布后只读，同一对象复用派生索引。
// 换范围/换 offset/切轴必然产生新结果对象，不会复用旧轴数组。
const derivedCache = new WeakMap<AnalysisResult, Map<string, DerivedIndex>>();

export function getDerived(result: AnalysisResult, axis: 'pts' | 'dts'): DerivedIndex | null {
  if (!result.samples.length || result.truncated) return null;
  let byAxis = derivedCache.get(result);
  if (!byAxis) {
    byAxis = new Map();
    derivedCache.set(result, byAxis);
  }
  const hit = byAxis.get(axis);
  if (hit) return hit;
  const entries: { idx: number; t: number; ordinal: number; id: string; size: number }[] = [];
  for (let i = 0; i < result.samples.length; i++) {
    const s = result.samples[i];
    const raw = axis === 'pts' ? s.effectivePtsUs : s.dtsUs;
    if (raw == null || !Number.isFinite(raw)) continue;
    entries.push({
      idx: i, t: raw, ordinal: s.decodeOrdinal, id: s.sampleId,
      size: s.sizeBytes ?? 0,
    });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => a.t - b.t || a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const order = entries.map(e => e.idx);
  const times = new Float64Array(entries.map(e => e.t));
  const prefix = new Float64Array(times.length + 1);
  for (let i = 0; i < entries.length; i++) prefix[i + 1] = prefix[i] + entries[i].size;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 0 && Number.isFinite(d)) gaps.push(d);
  }
  let medianGap = 0;
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    medianGap = gaps[Math.floor(gaps.length / 2)];
  }
  const derived: DerivedIndex = { axis, order, times, prefix, medianGap };
  byAxis.set(axis, derived);
  return derived;
}

export function lowerBoundArr(arr: Float64Array, value: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 二分找最近样本（只读当前快照，不扫描全片）。 */
export function nearestInDerived(
  derived: DerivedIndex, t: number,
): { pos: number; dt: number } | null {
  if (!derived.times.length) return null;
  const at = lowerBoundArr(derived.times, t);
  let best = -1, bestDt = Infinity;
  for (const k of [at - 1, at]) {
    if (k < 0 || k >= derived.times.length || !Number.isFinite(derived.times[k])) continue;
    const dt = Math.abs(derived.times[k] - t);
    if (dt < bestDt) { bestDt = dt; best = k; }
  }
  return best >= 0 ? { pos: best, dt: bestDt } : null;
}

export function coverageFor(
  cap: AnalysisCapability | undefined, result: AnalysisResult | undefined,
  t: number, domain: { start: number; end: number },
): CoverageState {
  if (!cap || !result) return 'pending';
  if (!cap.hasSize) return 'unsupported';
  if (cap.indexState === 'error') return 'error';
  // 优先用本轨已确认覆盖判断越界：短轨在长会话域后半段应显示“已结束”，
  // 而不是 known 伴随空值。
  const cov = result.coverageUs;
  if (cov) {
    if (t < cov.start || t >= cov.end) return 'outside';
  } else if (t < domain.start || t >= domain.end) {
    return 'outside';
  }
  if (cap.indexState !== 'complete') return 'pending';
  // 完整索引但暂无覆盖水位线时，落在会话域内视为已知（后端点自带 provisional）。
  return 'known';
}

/**
 * 公共 T 的码率读取：与曲线使用同一评价规则。
 * 后端码率点是按 windowUs 滑窗的离散采样；检查表取最近点，但距离超过
 * 实际采样步长*1.5 不延伸（缺失区间不断言），标记 approximate。
 * 实际步长优先用结果自带的 bitrateStepUs（曲线采样网格契约），
 * stepUs 参数仅为旧结果的回退，不得用可视宽度猜另一份结果的密度。
 */
export function bitrateAtT(
  result: AnalysisResult, t: number, windowUs: number, stepUs: number,
  state: CoverageState,
): MetricReading {
  const base: MetricReading = {
    value: null, unit: 'Mbps', evaluationTimeUs: Math.round(t), windowUs,
    approximate: false, shortWindow: false, provisional: state !== 'known',
    state, estimator: 'sliding-window',
  };
  if (state !== 'known') return base;
  const pts = result.bitrate ?? [];
  if (!pts.length) return base;
  let best: { mbps: number | null; tUs: number; shortWindow: boolean; provisional: boolean } | null = null;
  let bestDt = Infinity;
  for (const p of pts) {
    const dt = Math.abs(p.tUs - t);
    if (dt < bestDt) { bestDt = dt; best = p; }
  }
  if (!best) return base;
  // 步长未知时（如首帧前）用窗口/像素回退：超过半窗即不可信。
  // 优先用结果自带的实际采样步长；调用方传入的可视步长仅为旧数据回退。
  const actualStep = result.bitrateStepUs != null && Number.isFinite(result.bitrateStepUs) && (result.bitrateStepUs as number) > 0
    ? (result.bitrateStepUs as number)
    : stepUs;
  const limit = Number.isFinite(actualStep) && actualStep > 0 ? actualStep * 1.5 : windowUs / 2;
  if (bestDt > limit) return { ...base, evaluationTimeUs: best.tUs, approximate: true };
  if (best.mbps == null) {
    return {
      ...base, evaluationTimeUs: Math.round(best.tUs),
      shortWindow: best.shortWindow, provisional: true,
      approximate: bestDt > 0,
    };
  }
  return {
    value: best.mbps, unit: 'Mbps', evaluationTimeUs: Math.round(best.tUs),
    windowUs, approximate: bestDt > 0,
    shortWindow: best.shortWindow, provisional: best.provisional,
    state, estimator: 'sliding-window',
  };
}

export const LOCAL_RATE_WINDOW_US = 1_000_000;

/**
 * 局部帧率/样本率：PTS 1s 邻域的时间间隔估计 (k-1)*1e6/(last-first)，
 * 不是窗口事件数/窗口长度。k<2、重复时间戳无跨度、跳变、覆盖不确定时
 * 返回 null，不伪造。DTS 轴返回 sample-rate，不冒充展示 FPS。
 */
export function localRateAtT(
  result: AnalysisResult, axis: 'pts' | 'dts', t: number,
  state: CoverageState, windowUs = LOCAL_RATE_WINDOW_US,
): MetricReading {
  const isDts = axis === 'dts';
  const base: MetricReading = {
    value: null, unit: isDts ? '样本/秒' : 'fps',
    evaluationTimeUs: Math.round(t), windowUs,
    approximate: false, shortWindow: false,
    provisional: state !== 'known', state,
    estimator: isDts ? 'dts-interval-1s' : 'pts-interval-1s',
    kind: isDts ? 'sample-rate' : 'display-fps',
  };
  if (state !== 'known') return base;
  const derived = getDerived(result, axis);
  if (!derived || derived.times.length < 2) return base;
  // 覆盖不确定时不估计；媒体边界处截断窗口并标记 shortWindow。
  const cov = result.coverageUs;
  const half = windowUs / 2;
  const a = t - half, b = t + half;
  if (!cov) return { ...base, provisional: true };
  const wa = Math.max(a, cov.start), wb = Math.min(b, cov.end);
  if (!(wb > wa)) return base;
  const shortWindow = wa !== a || wb !== b;
  // 显式样本覆盖契约：统计窗口必须被本次返回的样本区间完整包含，
  // 否则说明查询没拿全窗口（深度放大/稀疏截断），不得报告确定帧率。
  // 这代替旧的 last-first 跨度启发式；真实稀疏与缺样本在此区分：
  // 缺样本直接返回 null + provisional，稀疏仍走下面的间隔/跳变判定。
  const sc = result.sampleCoverageUs;
  if (sc !== undefined) {
    if (!sc) return { ...base, provisional: true, shortWindow: true };
    if (wa < sc.start || wb > sc.end) return { ...base, provisional: true, shortWindow: true };
  }
  const lo = lowerBoundArr(derived.times, wa);
  const hi = lowerBoundArr(derived.times, wb);
  const k = hi - lo;
  if (k < 2) return base;
  const first = derived.times[lo], last = derived.times[hi - 1];
  if (!(last > first) || !Number.isFinite(first) || !Number.isFinite(last)) return base;
  // 旧数据无显式覆盖时保留跨度启发式；新数据已由上面的包含检查保证，
  // 不再用跨度猜测代替查询覆盖元数据。
  const spanShort = sc !== undefined ? false : (last - first) * 2 < wb - wa;
  // 跳变检测：任一间隔超过半窗即视为时间线跳变，不输出稳定帧率。
  let maxGap = 0;
  for (let i = lo + 1; i < hi; i++) {
    const g = derived.times[i] - derived.times[i - 1];
    if (!Number.isFinite(g) || g < 0) return base;
    if (g > maxGap) maxGap = g;
  }
  if (maxGap > half) return base;
  const fps = ((k - 1) * 1_000_000) / (last - first);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 1000) return base;
  return { ...base, value: fps, provisional: false, shortWindow: shortWindow || spanShort };
}

/** 公共 T 的参考样本：exact/nearby/none，不扩大对应容差。 */
export function referenceAtT(
  result: AnalysisResult, axis: 'pts' | 'dts', t: number,
  state: CoverageState,
): { ref: ReferenceSample | null; empty: boolean } {
  if (state === 'unsupported' || state === 'error') return { ref: null, empty: false };
  const derived = getDerived(result, axis);
  if (!derived) return { ref: null, empty: state === 'known' };
  const near = nearestInDerived(derived, t);
  if (!near) return { ref: null, empty: state === 'known' };
  const axisT = derived.times[near.pos];
  const dt = Math.round(axisT - t);
  const median = derived.medianGap || 0;
  const nearbyLimit = Math.max(10_000, median * 2);
  const exactLimit = Math.max(500, median * 0.25);
  if (Math.abs(dt) > nearbyLimit) return { ref: null, empty: state === 'known' };
  const sample = result.samples[derived.order[near.pos]];
  return {
    ref: {
      sample, axisUs: Math.round(axisT), dtUs: dt,
      relation: Math.abs(dt) <= exactLimit ? 'exact' : 'nearby',
    },
    empty: false,
  };
}

export interface BuildInspectionOptions {
  axis: 'pts' | 'dts';
  inspectionTimeUs: number;
  windowUs: number;
  /** 视图步长回退：仅当结果缺失 bitrateStepUs 网格时使用，新结果优先用自带步长。 */
  stepUs: number;
  order: readonly Slot[];
  results: ReadonlyMap<Slot, AnalysisResult>;
  caps: ReadonlyMap<Slot, AnalysisCapability>;
  domain: { start: number; end: number };
  directTarget?: DirectTarget | null;
}

/** 同一 x 的各轨指标快照：与 y/命中无关，只依赖公共 T。 */
export function buildInspection(opts: BuildInspectionOptions): InspectionState {
  const t = Math.round(opts.inspectionTimeUs);
  const tracks: TrackInspection[] = opts.order.map(slot => {
    const result = opts.results.get(slot);
    const cap = opts.caps.get(slot);
    const state = coverageFor(cap, result, t, opts.domain);
    if (!result) {
      const pending: MetricReading = {
        value: null, unit: 'Mbps', evaluationTimeUs: t, windowUs: opts.windowUs,
        approximate: false, shortWindow: false, provisional: true,
        state, estimator: 'sliding-window',
      };
      const ratePending: MetricReading = {
        value: null, unit: opts.axis === 'dts' ? '样本/秒' : 'fps',
        evaluationTimeUs: t, windowUs: LOCAL_RATE_WINDOW_US,
        approximate: false, shortWindow: false, provisional: true,
        state, estimator: opts.axis === 'dts' ? 'dts-interval-1s' : 'pts-interval-1s',
        kind: opts.axis === 'dts' ? 'sample-rate' : 'display-fps',
      };
      return { slot, bitrate: pending, localRate: ratePending, reference: null, emptyAtT: false, coverageState: state };
    }
    const bitrate = bitrateAtT(result, t, opts.windowUs, opts.stepUs, state);
    const localRate = localRateAtT(result, opts.axis, t, state);
    const { ref, empty } = referenceAtT(result, opts.axis, t, state);
    return { slot, bitrate, localRate, reference: ref, emptyAtT: empty, coverageState: state };
  });
  return {
    axis: opts.axis, inspectionTimeUs: t, windowUs: opts.windowUs,
    directTarget: opts.directTarget ?? null, tracks,
  };
}

// ---- 共享粗桶网格：按公共时间下标聚合，不按非空位置分批 ----

export interface CoarseBucketInput {
  startUs: number;
  endUs: number;
  count: number;
  maxBytes: number;
  sumBytes: number;
  keyCount: number;
  deltaCount: number;
  unknownCount: number;
  complete: boolean;
  maxSampleId: string | null;
}

export interface CoarsenedBucket extends CoarseBucketInput {
  coarseIndex: number;
}

/**
 * 把各轨基础桶按公共粗网格合并。originUs 一致（会话域 0）。
 * 公共网格不可变：coarseWidthUs 原样使用，不得逐轨舍入；调用方先用
 * isBucketGridCompatible 判断或 planSharedCoarseWidth 规划共同网格。
 * 数值聚合与覆盖完整性分开：零样本桶不贡献计数，但其 complete=false
 * 与缺失子区间都会使父桶 complete=false（未知不冒充完整）。
 * R3：输入桶必须与 base 网格对齐且完全落入单个粗区间，否则输出标为
 * 不完整（complete=false），调用方应先用 isBucketGridCompatible 判断，
 * 不兼容时回退到原始桶或重查，不得将跨界桶整体塞入起点所在区间冒充完整。
 */
export function coarsenBucketsShared(
  buckets: readonly CoarseBucketInput[],
  baseWidthUs: number, coarseWidthUs: number, originUs = 0,
): CoarsenedBucket[] {
  if (!(baseWidthUs > 0) || !(coarseWidthUs > 0)) return [];
  if (!Number.isFinite(baseWidthUs) || !Number.isFinite(coarseWidthUs)) return [];
  if (!Number.isFinite(originUs)) return [];
  // 公共网格原样使用：禁止 Math.round(coarse/width)*width 逐轨改写。
  const width = Math.max(baseWidthUs, 1);
  const coarse = Math.max(1, coarseWidthUs);
  const byIndex = new Map<number, CoarsenedBucket>();
  const covered = new Map<number, number>();
  for (const b of buckets) {
    if (!Number.isFinite(b.startUs) || !Number.isFinite(b.endUs) || !(b.endUs > b.startUs)) {
      continue;
    }
    const idx = Math.floor((b.startUs - originUs) / coarse);
    if (!Number.isFinite(idx)) continue;
    const coarseStart = originUs + idx * coarse;
    const coarseEnd = coarseStart + coarse;
    // 跨界或非对齐的细桶不得冒充完整：仍归入起点区间以保持计数守恒，
    // 但整组标为不完整，调用方优先用兼容性检查避免进入此分支。
    const straddles = b.startUs < coarseStart - 1e-6 || b.endUs > coarseEnd + 1e-6;
    let entry = byIndex.get(idx);
    if (!entry) {
      entry = {
        startUs: coarseStart, endUs: coarseEnd,
        count: 0, maxBytes: 0, sumBytes: 0, keyCount: 0, deltaCount: 0, unknownCount: 0,
        complete: true, maxSampleId: null, coarseIndex: idx,
      };
      byIndex.set(idx, entry);
      covered.set(idx, 0);
    }
    // 覆盖长度按与所属粗区间的交集累加（含空桶）：缺失子区间/视口裁切
    // 使交集总和小于粗宽度时，父桶不得标完整。
    const overlap = Math.max(0, Math.min(b.endUs, coarseEnd) - Math.max(b.startUs, coarseStart));
    covered.set(idx, (covered.get(idx) ?? 0) + overlap);
    // 数值聚合只计非空桶；覆盖完整性对空桶同样生效。
    if (b.count) {
      entry.count += b.count;
      entry.sumBytes += b.sumBytes;
      if (b.maxBytes > entry.maxBytes) { entry.maxBytes = b.maxBytes; entry.maxSampleId = b.maxSampleId; }
      entry.keyCount += b.keyCount;
      entry.deltaCount += b.deltaCount;
      entry.unknownCount += b.unknownCount;
    }
    if (!b.complete || straddles) entry.complete = false;
  }
  // 缺失子区间传播：已累加的交集覆盖小于粗宽度（1us 容差）时标不完整。
  // 视口裁切只传入局部细桶时，局部粗桶不会被误标完整。
  for (const [idx, entry] of byIndex) {
    const total = covered.get(idx) ?? 0;
    if (total + 1 < coarse) entry.complete = false;
  }
  // 仅输出有样本的粗桶（空区域不绘制），但完整性已按上述规则计入。
  // 纯空且不完整的粗区间不单独成 glyph：调用方以非空父桶的 complete=false
  // 感知未知覆盖，不靠空 glyph 传递。
  return [...byIndex.values()]
    .filter(e => e.count > 0)
    .sort((a, b) => a.coarseIndex - b.coarseIndex);
}

/**
 * 共享粗化前置检查：公共 coarseWidthUs 原样校验，不得先舍入再验证。
 * 只有当 coarse 为 base 的整数倍、所有输入桶宽度等于 baseWidthUs、
 * 起点对齐 base 网格、且完全落入单个 coarse 区间时才允许合并。
 * 各轨独立查询/缓存、异步更新或复用不同分辨率缓存时，基础网格未必相同，
 * 不得仅凭“旧桶更细”假定一定能正确合并（R3/B1）。
 */
export function isBucketGridCompatible(
  buckets: readonly CoarseBucketInput[],
  baseWidthUs: number, coarseWidthUs: number, originUs = 0,
): boolean {
  if (!(baseWidthUs > 0) || !(coarseWidthUs > 0)) return false;
  if (!Number.isFinite(baseWidthUs) || !Number.isFinite(coarseWidthUs) || !Number.isFinite(originUs)) return false;
  const width = Math.max(baseWidthUs, 1);
  const coarse = coarseWidthUs;
  // 公共网格不可变：直接校验原始请求，不做 Math.round(coarse/width)*width。
  // 15ms 基础无法合并成 40ms 公共网格时返回 false，由上层统一改选 60ms
  // 或重查，不得逐轨改成 45ms 后返回“兼容”。
  const ratio = coarse / width;
  if (!(ratio >= 1) || Math.abs(ratio - Math.round(ratio)) > 1e-6) return false;
  for (const b of buckets) {
    if (!Number.isFinite(b.startUs) || !Number.isFinite(b.endUs)) return false;
    const w = b.endUs - b.startUs;
    if (!(w > 0) || Math.abs(w - width) > 1) return false;
    if (Math.abs((b.startUs - originUs) / width - Math.round((b.startUs - originUs) / width)) > 1e-6) return false;
    const idx = Math.floor((b.startUs - originUs) / coarse);
    if (!Number.isFinite(idx)) return false;
    const coarseStart = originUs + idx * coarse;
    if (b.startUs < coarseStart - 1e-6 || b.endUs > coarseStart + coarse + 1e-6) return false;
  }
  return true;
}

/**
 * 公共粗网格规划器：一次决定、不可变下发。
 * 在 >= neededUs 的前提下找同时是所有 base 的整数倍的最小宽度；
 * 以 maxBase 为步长有界搜索，避免为最小公倍数造出异常巨桶。
 * 找不到（或输入非法）时返回 null，调用方整体回退到原始桶并视为不可比，
 * 不得逐轨各自舍入后并排冒充同一时间组。
 */
export function planSharedCoarseWidth(
  baseWidths: readonly number[], neededUs: number, maxUs?: number,
): number | null {
  const bases = [...new Set(baseWidths.filter(w => Number.isFinite(w) && w > 0))];
  if (!bases.length || !(neededUs > 0) || !Number.isFinite(neededUs)) return null;
  const maxBase = Math.max(...bases);
  const cap = maxUs != null && Number.isFinite(maxUs) && maxUs > 0 ? maxUs : neededUs * 4;
  // 起点：覆盖 needed 的 maxBase 整数倍；步长 maxBase 保证恒为 maxBase 的倍数。
  let k = Math.max(1, Math.ceil(neededUs / maxBase));
  // 有界搜索：最多 64 步且不超过 cap，防止 10ms/11ms 之类组合爆出巨桶。
  for (let step = 0; step < 64; step++, k++) {
    const candidate = maxBase * k;
    if (candidate < neededUs - 1e-6 || candidate > cap + 1e-6) {
      if (candidate > cap) break;
      continue;
    }
    let ok = true;
    for (const w of bases) {
      const r = candidate / w;
      if (!(r >= 1) || Math.abs(r - Math.round(r)) > 1e-6) { ok = false; break; }
    }
    if (ok) return candidate;
    if (maxBase * (k + 1) > cap + 1e-6) break;
  }
  return null;
}

/** 从桶数组估计基础桶宽（连续桶起止差的中位数，含空桶）。 */
export function estimateBaseBucketWidth(
  buckets: readonly { startUs: number; endUs: number }[] | null | undefined,
): number | null {
  if (!buckets || buckets.length < 1) return null;
  if (buckets.length === 1) {
    const w = buckets[0].endUs - buckets[0].startUs;
    return w > 0 ? w : null;
  }
  const widths: number[] = [];
  for (let i = 1; i < Math.min(buckets.length, 65); i++) {
    const w = buckets[i].startUs - buckets[i - 1].startUs;
    if (w > 0 && Number.isFinite(w)) widths.push(w);
  }
  if (!widths.length) {
    const w = buckets[0].endUs - buckets[0].startUs;
    return w > 0 ? w : null;
  }
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}
