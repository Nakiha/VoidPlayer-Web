// 各媒体路径的只读分析查询：同一套纯查询逻辑同时跑在 packet worker
// （FLV/MP4 压缩包路径）与主线程（原生 Mediabunny 路径）里。
// 口径：视频样本负载（demux sample/packet 源长度，保留编码头与长度前缀）；
// 文件级配置头、容器头不分摊。sample/packet 不保证对应一张输出画面时，
// UI 称「样本大小」。

import { bitrateAt, buildBytePrefixSum, lowerBound } from './statistics.ts';
import type { BucketResult } from './statistics.ts';
import type {
  AnalysisBucket, AnalysisCapability, AnalysisQuery, AnalysisResult, AnalysisSample, BitratePoint,
} from './types.ts';

/** 查询所需的最小包视图；offset 等解码定位字段不在这里。 */
export interface PacketView {
  pts: number;
  dts: number | null;
  size: number;
  key: boolean;
  originalPts?: number;
}

export interface SourceQueryContext {
  mediaId: string;
  /** 解码顺序首包的 PTS：PTS/DTS 归一化都减它，不抹去重排延迟。 */
  firstPtsUs: number;
  durationUs: number;
  sourceVersion: string;
  indexRevision: number;
  capability: AnalysisCapability;
  /** 已确认完整的归一化媒体时间区间；null 表示暂无可信水位线。 */
  coverageUs: { start: number; end: number } | null;
}

const MAX_SAMPLES_DEFAULT = 5000;

/**
 * 在归一化媒体时间域执行一次有界查询。调用方（worker/主线程）各自持有
 * 全量包数组；这里只返回视口需要的样本/桶/码率点，不把全量数组发出去。
 * 不就地重排传入的 packets。
 */
export function runSourceQuery(
  packets: ArrayLike<PacketView>,
  ctx: SourceQueryContext,
  query: AnalysisQuery & { requestId: number },
): AnalysisResult {
  const { axis } = query;
  const maxSamples = query.maxSamples ?? MAX_SAMPLES_DEFAULT;
  const startUs = Math.min(query.startUs, query.endUs);
  const endUs = Math.max(query.startUs, query.endUs);
  if (ctx.capability.hasDts === false && axis === 'dts') {
    throw new Error('该片源没有可用的 DTS 时间，无法按解码时间查看。');
  }
  // 稳定轴索引：(轴时间, 包序号) 排序，重复时间戳不丢弃；不就地重排包数组。
  const sorted = sortByAxis(packets, ctx.firstPtsUs, axis);
  return executeSortedQuery(packets, ctx, query, startUs, endUs, maxSamples, sorted);
}

export interface SortedAxis {
  /** 包序号按 (轴时间, 包序号) 排好的顺序。 */
  order: number[];
  times: Float64Array;
  prefix: Float64Array;
}

/** 物化单个包的样本视图：executeSortedQuery 与按身份定位共用同一字段口径。 */
function toSample(packets: ArrayLike<PacketView>, ctx: SourceQueryContext, pos: number): AnalysisSample {
  const p = packets[pos];
  return {
    sampleId: `${ctx.mediaId}:v:${pos}`,
    decodeOrdinal: pos,
    containerPtsUs: p.originalPts ?? p.pts,
    effectivePtsUs: p.pts - ctx.firstPtsUs,
    dtsUs: p.dts == null ? null : p.dts - ctx.firstPtsUs,
    sizeBytes: p.size,
    randomAccess: p.key ? 'yes' : 'no',
    pictureType: null,
    pictureTypeSource: 'unavailable',
    qp: null,
  };
}

/**
 * 按样本身份做有界定位：只有 mint 该 id 的本层可以解析它（UI 不得猜格式）。
 * 身份不属于本媒体、序号越界（索引尚未覆盖）时返回 null，调用方如实播报。
 */
export function locateSampleById(
  packets: ArrayLike<PacketView>, mediaId: string, firstPtsUs: number, sampleId: string,
): AnalysisSample | null {
  const prefix = `${mediaId}:v:`;
  if (!sampleId.startsWith(prefix)) return null;
  const pos = Number(sampleId.slice(prefix.length));
  if (!Number.isInteger(pos) || pos < 0 || pos >= packets.length) return null;
  const p = packets[pos];
  return {
    sampleId: `${mediaId}:v:${pos}`,
    decodeOrdinal: pos,
    containerPtsUs: p.originalPts ?? p.pts,
    effectivePtsUs: p.pts - firstPtsUs,
    dtsUs: p.dts == null ? null : p.dts - firstPtsUs,
    sizeBytes: p.size,
    randomAccess: p.key ? 'yes' : 'no',
    pictureType: null,
    pictureTypeSource: 'unavailable',
    qp: null,
  };
}

export function sortByAxis(packets: ArrayLike<PacketView>, firstPtsUs: number, axis: 'pts' | 'dts'): SortedAxis {
  const items: { pos: number; t: number }[] = [];
  for (let i = 0; i < packets.length; i++) {
    const raw = axis === 'pts' ? packets[i].pts : packets[i].dts;
    if (raw == null || !Number.isFinite(raw)) continue;
    items.push({ pos: i, t: raw - firstPtsUs });
  }
  items.sort((a, b) => a.t - b.t || a.pos - b.pos);
  const order = items.map(e => e.pos);
  const times = new Float64Array(items.map(e => e.t));
  const sizes = new Float64Array(order.map(pos => packets[pos].size));
  return { order, times, prefix: buildBytePrefixSum(sizes) };
}

export function executeSortedQuery(
  packets: ArrayLike<PacketView>,
  ctx: SourceQueryContext,
  query: AnalysisQuery & { requestId: number },
  startUs: number,
  endUs: number,
  maxSamples: number,
  sorted: SortedAxis,
): AnalysisResult {
  const { order, times, prefix } = sorted;
  const lo = lowerBound(times, startUs);
  const hi = lowerBound(times, endUs);
  const inRange = hi - lo;
  const bucketsOnly = !!query.bucketsOnly;
  const truncated = bucketsOnly ? inRange > 0 : inRange > maxSamples;
  const samples: AnalysisSample[] = [];
  if (!truncated) {
    for (let k = lo; k < hi; k++) samples.push(toSample(packets, ctx, order[k]));
  }
  const pixelWidth = Math.max(1, Math.floor(query.pixelWidth) || 1);
  // 共享桶原点：会话层按轨填入归一化原点（会话原点 - offset），多轨在会话域对齐；
  // 缺省 0 保持单轨兼容；固定原点避免平移跳变。
  const originUs = Number.isFinite(query.bucketOriginUs) ? (query.bucketOriginUs as number) : 0;
  const bucketWidth = Math.max(1, Math.floor((endUs - startUs) / pixelWidth) || 1);
  // 直接按索引累积，不为每个样本新建临时对象（长片概览 O(N) 仍只做一次整数运算）。
  const firstIndex = Math.floor((startUs - originUs) / bucketWidth);
  const lastIndex = Math.ceil((endUs - originUs) / bucketWidth);
  const rawBuckets: BucketResult[] = [];
  for (let i = firstIndex; i < lastIndex; i++) {
    rawBuckets.push({
      startUs: originUs + i * bucketWidth,
      endUs: originUs + (i + 1) * bucketWidth,
      count: 0, sumBytes: 0, maxBytes: 0, maxSampleId: null,
      keyCount: 0, deltaCount: 0, unknownCount: 0,
    });
  }
  for (let k = lo; k < hi; k++) {
    const t = times[k];
    if (!(t >= startUs && t < endUs)) continue;
    const idx = Math.floor((t - originUs) / bucketWidth) - firstIndex;
    const bucket = rawBuckets[idx];
    if (!bucket) continue;
    const pos = order[k];
    const size = packets[pos].size;
    const key = packets[pos].key;
    bucket.count++;
    bucket.sumBytes += size;
    if (size > bucket.maxBytes) { bucket.maxBytes = size; bucket.maxSampleId = `${ctx.mediaId}:v:${pos}`; }
    if (key === true) bucket.keyCount++;
    else if (key === false) bucket.deltaCount++;
    else bucket.unknownCount++;
  }
  // 轴相关的媒体边界与覆盖：DTS 合法为负，不得沿用 PTS 的 {0, duration} 排除首包。
  // 结束端取容器时长与实际最大样本时间的较大值：时长偏短时尾帧仍是合法评价
  // 中心，不得被中心越界规则误判成片外空洞。
  const axisMin = times.length ? times[0] : startUs;
  const axisMax = times.length ? times[times.length - 1] : endUs;
  const mediaBounds = query.axis === 'dts'
    ? { start: Math.min(0, axisMin), end: Math.max(ctx.durationUs, axisMax) }
    : { start: 0, end: Math.max(ctx.durationUs, axisMax) };
  let coverage = ctx.coverageUs ? [{ start: ctx.coverageUs.start, end: ctx.coverageUs.end }] : null;
  if (query.axis === 'dts' && coverage && times.length && ctx.capability.indexState === 'complete') {
    // 完整索引下 DTS 覆盖扩展到实际最小/最大解码时间，保留负时间。
    coverage = [{
      start: Math.min(coverage[0].start, times[0]),
      end: Math.max(coverage[0].end, times[times.length - 1]),
    }];
  }
  const buckets: AnalysisBucket[] = rawBuckets.map(b => {
    const insideCoverage = coverage ? b.startUs >= coverage[0].start && b.endUs <= coverage[0].end : false;
    // 查询两端只统计了桶的一部分时标暂定，不冒充完整桶。
    const insideQuery = b.startUs >= startUs && b.endUs <= endUs;
    return { ...b, complete: insideCoverage && insideQuery };
  });
  // 曲线采样与统计样本解耦：码率点只在 curve 区间按其像素密度生成，
  // 缺省复用样本查询区间（Agent/旧调用）。面板深度缩放时 curve=可视区间、
  // 样本=halo 区间，避免 halo + 4096 封顶摊薄可视曲线的密度。
  const rawCurveStart = Number.isFinite(query.curveStartUs) ? (query.curveStartUs as number) : startUs;
  const rawCurveEnd = Number.isFinite(query.curveEndUs) ? (query.curveEndUs as number) : endUs;
  const curveStart = Math.min(rawCurveStart, rawCurveEnd);
  const curveEnd = Math.max(rawCurveStart, rawCurveEnd);
  const curvePixels = Math.max(1, Math.floor(query.curvePixelWidth ?? pixelWidth) || 1);
  const bitrate: BitratePoint[] = [];
  const curveSpan = curveEnd - curveStart;
  const step = curveSpan > 0 ? curveSpan / curvePixels : (endUs - startUs) / pixelWidth;
  for (let i = 0; i < curvePixels; i++) {
    const t = curveStart + (i + 0.5) * step;
    if (!(t < curveEnd)) break;
    // 没有可信覆盖水位线时不输出码率值（不断言偏低的 0），只标暂定。
    if (!coverage) {
      bitrate.push({ tUs: t, mbps: null, shortWindow: false, provisional: true });
      continue;
    }
    const r = bitrateAt(t, times, prefix, query.bitrateWindowUs, mediaBounds, coverage);
    bitrate.push({ tUs: t, mbps: r.mbps, shortWindow: r.shortWindow, provisional: r.provisional });
  }
  return {
    requestId: query.requestId,
    sourceVersion: ctx.sourceVersion,
    indexRevision: ctx.indexRevision,
    axis: query.axis,
    origin: { firstPtsUs: ctx.firstPtsUs, offsetUs: 0 },
    samples,
    truncated,
    buckets,
    bitrate,
    capability: ctx.capability,
    // 导出轴相关的实际覆盖：与内部桶完整性/码率计算使用同一区间，
    // 调用方不得再用原始 PTS 水位线判断 DTS 轴的 outside。
    coverageUs: coverage ? coverage[0] : null,
    // 显式网格契约：样本完整区间、曲线采样区间/步长、桶网格。
    // 调用方不得从屏幕宽度猜另一份结果的真实采样密度。
    sampleCoverageUs: truncated || bucketsOnly ? null : { start: startUs, end: endUs },
    bitrateRangeUs: curveSpan > 0 ? { start: curveStart, end: curveEnd } : null,
    bitrateStepUs: curveSpan > 0 ? curveSpan / curvePixels : null,
    bucketGrid: { originUs, widthUs: bucketWidth },
  };
}

/** FlvPacket（含 offset 等多余字段）到包视图的零拷贝投影。 */
export function flvPacketsToViews(packets: { pts: number; dts: number; size: number; key: boolean; originalPts?: number }[]): PacketView[] {
  return packets.map(p => ({ pts: p.pts, dts: p.dts, size: p.size, key: p.key, ...(p.originalPts === undefined ? {} : { originalPts: p.originalPts }) }));
}

/**
 * 带轴排序缓存的查询器：同一包表（引用 + 长度 + 原点 + 轴）复用排序与
 * 前缀和，hover/缩放的重复查询只付区间二分 + 有界物化的成本。
 * 渐进枚举只做尾部追加时走增量合并（旧有序 + 新区间排序后归并），
 * 避免每次长度变化都全表重排；首个大索引排序仍是同步任务，
 * 调用方（worker/后台）不得把它放进解码链的关键路径，
 * 见 packet-worker 的 analysis 分支说明。
 * REVIEW-04：增量只覆盖同引用尾部追加；引用/原点/轴变化仍全量重排。
 */
export interface SourceQuerier {
  (
    packets: ArrayLike<PacketView> & { length: number },
    ctx: SourceQueryContext,
    query: AnalysisQuery & { requestId: number },
  ): AnalysisResult;
  /**
   * 展示序排名：与区间查询共用同一份有序轴缓存，O(log N) 二分，
   * 不物化样本数组。rank 为 axis 时间严格小于 tUs 的样本数
   * （0-based 展示下标，重复时间戳共享排名）；ordinal 为与 tUs
   * 精确相等的首个样本的包表下标（解码顺序号），无精确匹配为 null。
   */
  rank(
    packets: ArrayLike<PacketView> & { length: number },
    firstPtsUs: number,
    axis: 'pts' | 'dts',
    tUs: number,
  ): { rank: number; total: number; ordinal: number | null };
  sampleAtNumber(
    packets: ArrayLike<PacketView> & { length: number }, firstPtsUs: number,
    axis: 'pts' | 'dts', number: number,
  ): number | null;
}
export function createSourceQuerier(): SourceQuerier {
  let cached: { packets: unknown; length: number; firstPtsUs: number; axis: string; sorted: SortedAxis } | undefined;
  // 同一包表（引用 + 长度 + 原点 + 轴）的有序轴只排一次，区间查询与排名共用。
  const sortedFor = (
    packets: ArrayLike<PacketView> & { length: number },
    firstPtsUs: number,
    axis: 'pts' | 'dts',
  ): SortedAxis => {
    let sorted = cached && cached.packets === packets && cached.length === packets.length
      && cached.firstPtsUs === firstPtsUs && cached.axis === axis ? cached.sorted : undefined;
    if (!sorted) {
      const prev = cached && cached.packets === packets
        && cached.firstPtsUs === firstPtsUs && cached.axis === axis ? cached : undefined;
      if (prev && packets.length > prev.length) {
        sorted = mergeAppendedSort(packets, firstPtsUs, axis, prev.sorted, prev.length);
      } else {
        sorted = sortByAxis(packets, firstPtsUs, axis);
      }
      cached = { packets, length: packets.length, firstPtsUs, axis, sorted };
    }
    return sorted;
  };
  function queryFn(
    packets: ArrayLike<PacketView> & { length: number },
    ctx: SourceQueryContext,
    query: AnalysisQuery & { requestId: number },
  ): AnalysisResult {
    const startUs = Math.min(query.startUs, query.endUs);
    const endUs = Math.max(query.startUs, query.endUs);
    if (ctx.capability.hasDts === false && query.axis === 'dts') {
      throw new Error('该片源没有可用的 DTS 时间，无法按解码时间查看。');
    }
    const sorted = sortedFor(packets, ctx.firstPtsUs, query.axis);
    return executeSortedQuery(packets, ctx, query, startUs, endUs, query.maxSamples ?? MAX_SAMPLES_DEFAULT, sorted);
  }
  const querier = queryFn as SourceQuerier;
  querier.rank = (
    packets: ArrayLike<PacketView> & { length: number },
    firstPtsUs: number,
    axis: 'pts' | 'dts',
    tUs: number,
  ): { rank: number; total: number; ordinal: number | null } => {
    if (axis !== 'pts' && axis !== 'dts') throw new Error('时间基准必须是 pts 或 dts。');
    if (!Number.isFinite(tUs)) throw new Error('排名时间必须是有限微秒数。');
    const sorted = sortedFor(packets, firstPtsUs, axis);
    // 包时间戳与查询点都是整数微秒，可精确比较；命中 lowerBound 首位即
    // (t,pos) 稳定序下该时间的首个样本，其包表下标就是解码顺序号。
    const lo = lowerBound(sorted.times, tUs);
    return { rank: lo, total: sorted.times.length, ordinal: sorted.times[lo] === tUs ? sorted.order[lo] : null };
  };
  querier.sampleAtNumber = (packets, firstPtsUs, axis, number) => {
    if (!Number.isSafeInteger(number) || number < 0 || axis !== 'pts' && axis !== 'dts') return null;
    if (axis === 'dts') return number < packets.length ? packets[number].pts - firstPtsUs : null;
    const sorted = sortedFor(packets, firstPtsUs, 'pts');
    return number < sorted.times.length ? packets[sorted.order[number]].pts - firstPtsUs : null;
  };
  return querier;
}

/**
 * 增量合并：旧表已有序（0..oldLength-1），新包只出现在尾部
 * （oldLength..packets.length-1）。新区间独立排序后与旧有序归并，
 * 结果与全量 sortByAxis 一致（含 (t,pos) 稳定序），前缀和重建为 O(N)。
 */
export function mergeAppendedSort(
  packets: ArrayLike<PacketView>,
  firstPtsUs: number,
  axis: 'pts' | 'dts',
  prev: SortedAxis,
  oldLength: number,
): SortedAxis {
  const total = (packets as { length: number }).length;
  const fresh: { pos: number; t: number }[] = [];
  for (let i = oldLength; i < total; i++) {
    const raw = axis === 'pts' ? packets[i].pts : packets[i].dts;
    if (raw == null || !Number.isFinite(raw)) continue;
    fresh.push({ pos: i, t: raw - firstPtsUs });
  }
  fresh.sort((a, b) => a.t - b.t || a.pos - b.pos);
  const oldOrder = prev.order, oldTimes = prev.times;
  const order = new Array<number>(oldOrder.length + fresh.length);
  const times = new Float64Array(oldOrder.length + fresh.length);
  let i = 0, j = 0, k = 0;
  while (i < oldOrder.length && j < fresh.length) {
    const ot = oldTimes[i], ft = fresh[j].t;
    if (ot < ft || (ot === ft && oldOrder[i] < fresh[j].pos)) {
      order[k] = oldOrder[i]; times[k] = ot; i++;
    } else {
      order[k] = fresh[j].pos; times[k] = ft; j++;
    }
    k++;
  }
  while (i < oldOrder.length) { order[k] = oldOrder[i]; times[k] = oldTimes[i]; i++; k++; }
  while (j < fresh.length) { order[k] = fresh[j].pos; times[k] = fresh[j].t; j++; k++; }
  const sizes = new Float64Array(order.length);
  for (let n = 0; n < order.length; n++) sizes[n] = packets[order[n]].size;
  return { order, times, prefix: buildBytePrefixSum(sizes) };
}

export function unsupportedCapability(note: string): AnalysisCapability {
  return {
    hasSize: false, hasDts: false, keySource: 'unavailable',
    pictureType: 'unavailable', qp: 'unsupported', indexState: 'complete', note,
  };
}
