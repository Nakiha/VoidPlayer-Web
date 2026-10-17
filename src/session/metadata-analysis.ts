import type { AnalysisAxis, AnalysisQuery, AnalysisRank, AnalysisResult, AnalysisSample, AnalysisStatus } from '../../shared/analysis/metadata/types.ts';
import type { MediaSource } from '../media/source.ts';
import { abortableWait } from '../../shared/media/io/media-abort.ts';
import type { Slot } from '../../shared/review/model.ts';
import { slotValue } from '../../shared/review/model.ts';

export interface SessionAnalysisTrack {
  readonly source: MediaSource;
  readonly offsetUs: number;
  readonly failure?: { message: string; positionUs: number };
  readonly sourceGen: number;
}

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function getTrackAnalysisCapabilities(tracks: Iterable<[Slot, SessionAnalysisTrack]>): AnalysisStatus[] {
  return [...tracks].map(([slot, t]) => ({
    slot,
    mediaId: t.source.info.id,
    capability: t.source.getAnalysisCapability?.() ?? {
      hasSize: false, hasDts: false, keySource: 'unavailable' as const,
      pictureType: 'unavailable' as const, qp: 'unsupported' as const,
      indexState: 'complete' as const, note: '该解码路径暂不支持码流分析。',
    },
  }));
}

export async function queryTrackAnalysis(
  slot: Slot,
  track: SessionAnalysisTrack | undefined,
  query: AnalysisQuery,
  nextRequestId: () => number,
): Promise<AnalysisResult> {
  slotValue(slot);
  const { startUs, endUs, axis, pixelWidth, bitrateWindowUs } = query;
  // 起点可为负：正偏移轨道的片内区间起点为 sessionStart - offset；
  // DTS 轴本身也允许合法负时间（预滚），一律不钳到零。
  if (!Number.isInteger(startUs) || !Number.isInteger(endUs)) {
    throw new Error('分析查询区间必须是整数微秒。');
  }
  if (axis !== 'pts' && axis !== 'dts') throw new Error('时间基准必须是 pts 或 dts。');
  if (!Number.isInteger(pixelWidth) || pixelWidth < 32 || pixelWidth > 4096) throw new Error('查询像素宽度超出范围。');
  if (!Number.isInteger(bitrateWindowUs) || bitrateWindowUs <= 0) throw new Error('码率滑窗必须为正整数微秒。');
  // 曲线区间缺省复用样本区间；显式传入时同样要求整数微秒与合法像素宽。
  const hasCurve = query.curveStartUs !== undefined || query.curveEndUs !== undefined || query.curvePixelWidth !== undefined;
  if (hasCurve) {
    if (!Number.isInteger(query.curveStartUs) || !Number.isInteger(query.curveEndUs)) {
      throw new Error('分析曲线区间必须是整数微秒。');
    }
    if (!Number.isInteger(query.curvePixelWidth) || (query.curvePixelWidth as number) < 32 || (query.curvePixelWidth as number) > 4096) {
      throw new Error('曲线像素宽度超出范围。');
    }
  }
  if (!track) throw new Error('轨道尚未载入。');
  if (track.failure) throw new Error(track.failure.message);
  if (!track.source.queryAnalysis) throw new Error('该片源的解码路径暂不支持码流分析。');
  const requestId = nextRequestId();
  const offsetUs = track.offsetUs;
  // 共享桶原点：会话域 0 对齐，换算到片内归一化域（会话原点 - offset）。
  const bucketOriginUs = (query.bucketOriginUs ?? 0) - offsetUs;
  const result = await track.source.queryAnalysis({
    ...query, requestId, bucketOriginUs,
    startUs: query.startUs - offsetUs, endUs: query.endUs - offsetUs,
    ...(hasCurve ? {
      curveStartUs: (query.curveStartUs as number) - offsetUs,
      curveEndUs: (query.curveEndUs as number) - offsetUs,
    } : {}),
  });
  const shift = (t: number) => t + offsetUs;
  return {
    ...result,
    requestId,
    // source 实例 generation 盖章：同 mediaId 重建（色彩模式切换等）后，
    // 旧实例的异步结果与缓存不得被当成当前实例的数据。
    sourceVersion: `${track.sourceGen}#${result.sourceVersion}`,
    origin: { firstPtsUs: track.source.info.firstPtsUs, offsetUs },
    samples: result.samples.map(s => ({
      ...s,
      effectivePtsUs: s.effectivePtsUs == null ? null : shift(s.effectivePtsUs),
      dtsUs: s.dtsUs == null ? null : shift(s.dtsUs),
    })),
    buckets: result.buckets?.map(b => ({ ...b, startUs: shift(b.startUs), endUs: shift(b.endUs) })) ?? null,
    bitrate: result.bitrate?.map(p => ({ ...p, tUs: shift(p.tUs) })) ?? null,
    coverageUs: result.coverageUs ? { start: shift(result.coverageUs.start), end: shift(result.coverageUs.end) } : null,
    sampleCoverageUs: result.sampleCoverageUs ? { start: shift(result.sampleCoverageUs.start), end: shift(result.sampleCoverageUs.end) } : (result.sampleCoverageUs ?? null),
    bitrateRangeUs: result.bitrateRangeUs ? { start: shift(result.bitrateRangeUs.start), end: shift(result.bitrateRangeUs.end) } : (result.bitrateRangeUs ?? null),
    bitrateStepUs: result.bitrateStepUs ?? null,
    bucketGrid: result.bucketGrid ? { originUs: result.bucketGrid.originUs + offsetUs, widthUs: result.bucketGrid.widthUs } : (result.bucketGrid ?? null),
  };
}

export function resolveTrackAnalysisSeek(
  slot: Slot,
  track: SessionAnalysisTrack | undefined,
  sample: { effectivePtsUs: number | null },
): { sessionPtsUs: number } | { reason: string } {
  slotValue(slot);
  if (!track || track.failure) return { reason: '轨道尚未载入或已停用。' };
  if (sample.effectivePtsUs == null) return { reason: '该样本没有可展示时间，无法定位。' };
  // 预滚判断在片内可展示映射域做：源负时间加正 offset 后变正，不等于成了可显示帧。
  const normalizedPts = sample.effectivePtsUs - track.offsetUs;
  if (normalizedPts < 0) return { reason: '该样本位于轨道开始之前（预滚），没有可展示画面。' };
  return { sessionPtsUs: Math.max(0, Math.round(sample.effectivePtsUs)) };
}

/**
 * Shared bounded sample locator for both read-only lookup (`locateAnalysisSample`)
 * and seek-producing navigation (`seekAnalysisSample`).
 */
export async function locateTrackAnalysisSample(
  slot: Slot,
  getTrack: (slot: Slot) => SessionAnalysisTrack | undefined,
  acquireIntentToken: () => number,
  currentIntentToken: () => number,
  sampleId: string,
  opts?: { signal?: AbortSignal },
): Promise<{ sample: AnalysisSample; token: number } | { reason: string }> {
  slotValue(slot);
  if (typeof sampleId !== 'string' || !sampleId) return { reason: '样本身份无效。' };
  const track = getTrack(slot);
  if (!track || track.failure) return { reason: '轨道尚未载入或已停用。' };
  const locateFn = track.source.locateAnalysisSample;
  if (!locateFn) return { reason: '该片源的解码路径暂不支持按样本定位。' };
  const gen = track.sourceGen;
  const mediaId = track.source.info.id;
  const offsetUs = track.offsetUs;
  const source = track.source;
  const token = acquireIntentToken();
  if (opts?.signal?.aborted) throw opts.signal.reason ?? new DOMException('定位已取消。', 'AbortError');
  let found: AnalysisSample | null;
  try {
    const call = locateFn.call(source, sampleId);
    // B3：共用 abortableWait，settled 后清理监听器，避免长期 signal 累积。
    found = await abortableWait(call, opts?.signal);
  } catch (error) {
    // 旧实例在等待期间被释放（换片/重建）：按失效处理，不抛释放错误。
    const current = getTrack(slot);
    if (!current || current.sourceGen !== gen || current.source.info.id !== mediaId) {
      return { reason: '该样本不在当前索引中（可能已换片或索引尚未覆盖）。' };
    }
    throw error;
  }
  // 新定位意图、换片、重建、改 offset 使旧结果失效：静默丢弃，不覆盖新意图。
  if (token !== currentIntentToken()) return { reason: '定位已被更新的请求取代。' };
  if (opts?.signal?.aborted) throw opts.signal.reason ?? new DOMException('定位已取消。', 'AbortError');
  const current = getTrack(slot);
  if (!current || current.sourceGen !== gen || current.source.info.id !== mediaId || current.offsetUs !== offsetUs) {
    return { reason: '该样本不在当前索引中（可能已换片或索引尚未覆盖）。' };
  }
  if (!found) return { reason: '该样本不在当前索引中（可能已换片或索引尚未覆盖）。' };
  return {
    token,
    sample: {
      ...found,
      effectivePtsUs: found.effectivePtsUs == null ? null : found.effectivePtsUs + offsetUs,
      dtsUs: found.dtsUs == null ? null : found.dtsUs + offsetUs,
    },
  };
}

export async function rankTrackAnalysisFrame(
  slot: Slot,
  getTrack: (slot: Slot) => SessionAnalysisTrack | undefined,
  sessionPtsUs: number,
  axis: AnalysisAxis = 'pts',
): Promise<AnalysisRank | { reason: string }> {
  slotValue(slot);
  if (!Number.isInteger(sessionPtsUs)) return { reason: '展示时间必须是整数微秒。' };
  if (axis !== 'pts' && axis !== 'dts') return { reason: '时间基准必须是 pts 或 dts。' };
  const track = getTrack(slot);
  if (!track || track.failure) return { reason: '轨道尚未载入或已停用。' };
  const source = track.source;
  if (!source.rankAnalysisTime) return { reason: '该片源的解码路径暂不支持展示序查询。' };
  const gen = track.sourceGen;
  const mediaId = source.info.id;
  const offsetUs = track.offsetUs;
  let rank: AnalysisRank;
  try {
    rank = await source.rankAnalysisTime(sessionPtsUs - offsetUs, axis);
  } catch (error) {
    return { reason: errorText(error) };
  }
  const current = getTrack(slot);
  if (!current || current.sourceGen !== gen || current.source.info.id !== mediaId || current.offsetUs !== offsetUs) {
    return { reason: '该样本不在当前索引中（可能已换片或索引尚未覆盖）。' };
  }
  return rank;
}
