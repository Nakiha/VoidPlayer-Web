// 各媒体路径的只读分析查询：同一套纯查询逻辑同时跑在 packet worker
// （FLV/MP4 压缩包路径）与主线程（原生 Mediabunny 路径）里。
// 口径：视频样本负载（demux sample/packet 源长度，保留编码头与长度前缀）；
// 文件级配置头、容器头不分摊。sample/packet 不保证对应一张输出画面时，
// UI 称「样本大小」。

import { bitrateAt, bucketize, buildBytePrefixSum, lowerBound } from './statistics.ts';
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
  const truncated = inRange > maxSamples;
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
  // 聚合桶锚定归一化媒体原点 0，避免平移跳变。
  const bucketWidth = Math.max(1, Math.floor((endUs - startUs) / pixelWidth) || 1);
  const bucketInputs = (() => {
    const arr: { axisUs: number; sizeBytes: number; key: boolean | null; sampleId: string }[] = [];
    for (let k = lo; k < hi; k++) {
      const pos = order[k];
      arr.push({ axisUs: times[k], sizeBytes: packets[pos].size, key: packets[pos].key, sampleId: `${ctx.mediaId}:v:${pos}` });
    }
    return arr;
  })();
  const rawBuckets = bucketize(bucketInputs, startUs, endUs, bucketWidth, 0);
  const coverage = ctx.coverageUs ? [{ start: ctx.coverageUs.start, end: ctx.coverageUs.end }] : null;
  const buckets: AnalysisBucket[] = rawBuckets.map(b => ({
    ...b,
    complete: coverage ? b.startUs >= coverage[0].start && b.endUs <= coverage[0].end : false,
  }));
  const bitrate: BitratePoint[] = [];
  const step = (endUs - startUs) / pixelWidth;
  const mediaBounds = { start: 0, end: ctx.durationUs };
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
