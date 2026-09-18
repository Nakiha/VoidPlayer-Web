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
    for (let k = lo; k < hi; k++) {
      const pos = order[k];
      const p = packets[pos];
      samples.push({
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
      });
    }
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
  const axisMin = times.length ? times[0] : startUs;
  const axisMax = times.length ? times[times.length - 1] : endUs;
  const mediaBounds = query.axis === 'dts'
    ? { start: Math.min(0, axisMin), end: Math.max(ctx.durationUs, axisMax) }
    : { start: 0, end: ctx.durationUs };
  let coverage = ctx.coverageUs ? [{ start: ctx.coverageUs.start, end: ctx.coverageUs.end }] : null;
  if (query.axis === 'dts' && coverage && times.length) {
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
  const bitrate: BitratePoint[] = [];
  const step = (endUs - startUs) / pixelWidth;
  for (let i = 0; i < pixelWidth; i++) {
    const t = startUs + (i + 0.5) * step;
    if (!(t < endUs)) break;
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
    coverageUs: ctx.coverageUs,
  };
}

/** FlvPacket（含 offset 等多余字段）到包视图的零拷贝投影。 */
export function flvPacketsToViews(packets: { pts: number; dts: number; size: number; key: boolean; originalPts?: number }[]): PacketView[] {
  return packets.map(p => ({ pts: p.pts, dts: p.dts, size: p.size, key: p.key, ...(p.originalPts === undefined ? {} : { originalPts: p.originalPts }) }));
}

/**
 * 带轴排序缓存的查询器：同一包表（引用 + 长度 + 原点 + 轴）复用排序与
 * 前缀和，hover/缩放的重复查询只付区间二分 + 有界物化的成本。
 * 首个大索引排序仍是同步长任务，调用方（worker/后台）不得把它放进
 * 解码链的关键路径，见 packet-worker 的 analysis 分支说明。
 */
export function createSourceQuerier() {
  let cached: { packets: unknown; length: number; firstPtsUs: number; axis: string; sorted: SortedAxis } | undefined;
  return (
    packets: ArrayLike<PacketView> & { length: number },
    ctx: SourceQueryContext,
    query: AnalysisQuery & { requestId: number },
  ): AnalysisResult => {
    const startUs = Math.min(query.startUs, query.endUs);
    const endUs = Math.max(query.startUs, query.endUs);
    if (ctx.capability.hasDts === false && query.axis === 'dts') {
      throw new Error('该片源没有可用的 DTS 时间，无法按解码时间查看。');
    }
    let sorted = cached && cached.packets === packets && cached.length === packets.length
      && cached.firstPtsUs === ctx.firstPtsUs && cached.axis === query.axis ? cached.sorted : undefined;
    if (!sorted) {
      sorted = sortByAxis(packets, ctx.firstPtsUs, query.axis);
      cached = { packets, length: packets.length, firstPtsUs: ctx.firstPtsUs, axis: query.axis, sorted };
    }
    return executeSortedQuery(packets, ctx, query, startUs, endUs, query.maxSamples ?? MAX_SAMPLES_DEFAULT, sorted);
  };
}

export function unsupportedCapability(note: string): AnalysisCapability {
  return {
    hasSize: false, hasDts: false, keySource: 'unavailable',
    pictureType: 'unavailable', qp: 'unsupported', indexState: 'complete', note,
  };
}
