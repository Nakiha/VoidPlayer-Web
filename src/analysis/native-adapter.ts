// 原生 Mediabunny 路径的只读分析适配器。
// 用 EncodedPacketSink(metadataOnly) 枚举压缩包元数据，不装载包负载；
// 关键标记来自容器（未做位流验证），与 metadataOnly 不得混为一次廉价操作
// 的是后续阶段 B 的 verified 标记。Mediabunny 包没有 DTS，本路径 hasDts
// 为 false，不得用 PTS 或平均帧率伪造。
// 枚举按块让出主线程；与播放共用同一 track 的独立游标，不改解码路径选择。

import { EncodedPacketSink } from 'mediabunny';
import type { InputVideoTrack } from 'mediabunny';
import { createSourceQuerier, locateSampleById } from './adapters.ts';
import { abortableWait } from '../media-abort.ts';
import type { PacketView, SourceQueryContext } from './adapters.ts';
import type { AnalysisCapability, AnalysisQuery, AnalysisResult, AnalysisSample } from './types.ts';

const MAX_PACKETS = 2_000_000;
const YIELD_EVERY = 2000;

export class NativeAnalysisAdapter {
  private packets: PacketView[] = [];
  private building: Promise<void> | undefined;
  private buildError: unknown;
  private done = false;
  private closed = false;
  private querier = createSourceQuerier();
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
      let count = 0;
      try {
        for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
          if (this.closed) break;
          if (this.packets.length >= MAX_PACKETS) throw new Error('原生包索引超过上限。');
          this.packets.push({
            pts: Math.round(packet.timestamp * 1e6),
            dts: null,
            size: packet.byteLength,
            key: packet.type === 'key',
          });
          if (++count % YIELD_EVERY === 0) {
            this.onAdvance?.();
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        }
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
    return this.packets.length;
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
      sourceVersion: `${this.mediaId}@${this.packets.length}`,
      indexRevision: this.packets.length,
      capability: this.getCapability(),
      coverageUs: this.done ? { start: 0, end: this.durationUs } : null,
    };
    const run = async () => this.querier(this.packets, ctx, query);
    // REVIEW-04：querier 已对同引用尾部追加做增量合并，渐进枚举不再每次全量重排；
    // 但首个大索引与新轴/新原点仍是主线程同步任务，signal 仅表示调用方不再等待
    // （旧查询不覆盖新图），不撤销已开始的排序/聚合。只传包元数据
    // （pts/dts/size/key），不转移播放缓冲。完整 Worker 化（增量索引、
    // 查询合并与分片取消）仍是后续专项，见 test/analysis-incremental.test.ts 的
    // 有界与增量回归；面板关闭只停止自己的刷新与排队查询，不取消播放器需要的容器索引。
    // B3：共用 abortableWait，settled 后清理监听器。
    if (!query.signal) return run();
    return abortableWait(run(), query.signal);
  }

  /** 按样本身份有界定位：O(1) 反查包表；索引尚未覆盖时返回 null。 */
  locate(sampleId: string): Promise<AnalysisSample | null> {
    if (this.closed) return Promise.resolve(null);
    return Promise.resolve(locateSampleById(this.packets, this.mediaId, this.firstPtsUs, sampleId));
  }

  /**
   * 展示序排名（只读，不解码）：axis 时间严格小于 tUs 的样本数，另附
   * 精确命中的解码顺序号。与区间查询共用同一份有序轴缓存；索引构建中
   * 返回已确认部分的暂定排名（complete=false），调用方不得当精确值展示。
   */
  rank(tUs: number, axis: 'pts' | 'dts'): { rank: number; total: number; ordinal: number | null; complete: boolean } {
    if (this.closed) throw new Error('媒体已释放。');
    if (axis === 'dts') throw new Error('该片源没有可用的 DTS 时间，无法按解码时间查看。');
    this.ensureStarted();
    if (this.buildError) throw this.buildError;
    const { rank, total, ordinal } = this.querier.rank(this.packets, this.firstPtsUs, axis, tUs);
    return { rank, total, ordinal, complete: this.done };
  }

  close(): void {
    this.closed = true;
  }
}
