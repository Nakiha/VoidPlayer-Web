// 原生 Mediabunny 路径的只读分析适配器。
// 用 EncodedPacketSink(metadataOnly) 枚举压缩包元数据，不装载包负载；
// 关键标记来自容器（未做位流验证），与 metadataOnly 不得混为一次廉价操作
// 的是后续阶段 B 的 verified 标记。Mediabunny 包没有 DTS，本路径 hasDts
// 为 false，不得用 PTS 或平均帧率伪造。
// 主线程只枚举有界元数据批次；包表、排序和统计由独立 Worker 持有。
// 与播放共用同一 track 的独立游标，不改解码路径选择。

import { EncodedPacketSink } from 'mediabunny';
import type { InputVideoTrack } from 'mediabunny';
import { NativeAnalysisClient } from './native-client.ts';
import type { SourceQueryContext } from './adapters.ts';
import type { AnalysisCapability, AnalysisQuery, AnalysisResult, AnalysisSample } from './types.ts';

const MAX_PACKETS = 2_000_000;
const YIELD_EVERY = 2000;

export class NativeAnalysisAdapter {
  private packetCount = 0;
  private building: Promise<void> | undefined;
  private buildError: unknown;
  private done = false;
  private closed = false;
  private client = new NativeAnalysisClient();
  private track: InputVideoTrack;
  private mediaId: string;
  private firstPtsUs: number;
  private durationUs: number;

  constructor(track: InputVideoTrack, mediaId: string, firstPtsUs: number, durationUs: number, onAdvance?: () => void) {
    this.track = track;
    this.mediaId = mediaId;
    this.firstPtsUs = firstPtsUs;
    this.durationUs = durationUs;
    this.onAdvance = onAdvance;
  }
  private onAdvance?: () => void;

  private ensureStarted(): void {
    if (this.building) return;
    this.building = (async () => {
      const sink = new EncodedPacketSink(this.track);
      let batch = new Float64Array(YIELD_EVERY * 3), count = 0;
      const flush = async () => {
        if (!count) return;
        const records = batch.subarray(0, count * 3);
        this.packetCount = await this.client.call('append', { records }, undefined, [records.buffer]);
        batch = new Float64Array(YIELD_EVERY * 3); count = 0;
        if (!this.closed) this.onAdvance?.();
      };
      try {
        for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
          if (this.closed) break;
          if (this.packetCount + count >= MAX_PACKETS) throw new Error('原生包索引超过上限。');
          batch[count * 3] = Math.round(packet.timestamp * 1e6);
          batch[count * 3 + 1] = packet.byteLength;
          batch[count * 3 + 2] = packet.type === 'key' ? 1 : 0;
          if (++count === YIELD_EVERY) await flush();
        }
        if (!this.closed) await flush();
        if (!this.closed) this.done = true;
      } catch (error) {
        if (!this.closed) this.buildError = error;
      } finally {
        if (!this.closed) this.onAdvance?.();
      }
    })();
  }

  getCapability(): AnalysisCapability {
    return {
      hasSize: true, hasDts: false, keySource: 'container',
      pictureType: 'key-only', qp: 'unsupported',
      indexState: this.buildError ? 'error' : this.done ? 'complete' : 'building',
      ...(this.buildError ? { indexError: this.buildError instanceof Error ? this.buildError.message : String(this.buildError) } : {}),
      ...(!this.done && !this.buildError ? { note: '原生包元数据枚举中，数值为暂定。' } : {}),
    };
  }

  get revision(): number {
    return this.packetCount;
  }

  async query(query: AnalysisQuery & { requestId: number }): Promise<AnalysisResult> {
    if (this.closed) throw new Error('媒体已释放。');
    if (query.signal?.aborted) throw query.signal.reason;
    this.ensureStarted();
    if (this.buildError) throw this.buildError;
    const ctx: SourceQueryContext = {
      mediaId: this.mediaId,
      firstPtsUs: this.firstPtsUs,
      durationUs: this.durationUs,
      sourceVersion: `${this.mediaId}@${this.packetCount}`,
      indexRevision: this.packetCount,
      capability: this.getCapability(),
      coverageUs: this.done ? { start: 0, end: this.durationUs } : null,
    };
    const { signal, ...request } = query;
    return this.client.call('query', { context: ctx, query: request }, signal);
  }

  /** 按样本身份有界定位：O(1) 反查包表；索引尚未覆盖时返回 null。 */
  locate(sampleId: string): Promise<AnalysisSample | null> {
    if (this.closed) return Promise.resolve(null);
    return this.client.call('locate', { mediaId: this.mediaId, firstPtsUs: this.firstPtsUs, sampleId });
  }

  /**
   * 展示序排名（只读，不解码）：axis 时间严格小于 tUs 的样本数，另附
   * 精确命中的解码顺序号。与区间查询共用同一份有序轴缓存；索引构建中
   * 返回已确认部分的暂定排名（complete=false），调用方不得当精确值展示。
   */
  async rank(tUs: number, axis: 'pts' | 'dts'): Promise<{ rank: number; total: number; ordinal: number | null; complete: boolean }> {
    if (this.closed) throw new Error('媒体已释放。');
    if (axis === 'dts') throw new Error('该片源没有可用的 DTS 时间，无法按解码时间查看。');
    this.ensureStarted();
    if (this.buildError) throw this.buildError;
    const complete = this.done;
    const result = await this.client.call('rank', { firstPtsUs: this.firstPtsUs, axis, tUs });
    return { ...result, complete };
  }

  async sampleAtNumber(number: number, axis: 'pts' | 'dts'): Promise<{ ptsUs: number | null; complete: boolean }> {
    if (this.closed) throw new Error('媒体已释放。');
    // The DTS status displays a packet ordinal even without DTS timestamps.
    this.ensureStarted();
    if (this.buildError) throw this.buildError;
    const complete = this.done;
    return { ptsUs: await this.client.call('number', { firstPtsUs: this.firstPtsUs, axis, number }), complete };
  }

  close(): void {
    this.closed = true; this.client.close();
  }
}
