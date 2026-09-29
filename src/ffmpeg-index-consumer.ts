import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_RECORD_LIMIT, parseFfmpegIndex } from './ffmpeg-index-cache.ts';
import { decodeIndexBase64 } from './index-stream-encoding.ts';
import type { IndexStreamCursor, IndexStreamEventResult } from './index-stream-transport.ts';
import type { MediaIndexIdentity } from './media-index-identity.ts';
import type { MediaIndexClientTrace, MediaIndexRecordBatch, MediaIndexRecordManifest, MediaIndexScanProgress, ServerIndexResult } from './media-index-types.ts';

function sameRecordIdentity(a: MediaIndexRecordManifest, b: MediaIndexRecordManifest): boolean {
  if (a.epoch !== b.epoch || a.buildId !== b.buildId || a.recordBytes !== b.recordBytes
    || a.identity.kind !== b.identity.kind || a.identity.streamKey !== b.identity.streamKey
    || a.identity.schemaVersion !== b.identity.schemaVersion || a.identity.indexerBuild !== b.identity.indexerBuild) return false;
  const stableFields = ['schema', 'kind', 'size', 'codec', 'timeBaseNum', 'timeBaseDen', 'width', 'height',
    'recordBytes', 'streamIndex', 'indexerBuild', 'firstPts', 'originVerified'] as const;
  return stableFields.every(key => a.metadata[key] === b.metadata[key]);
}

/** Validates the FFmpeg record protocol and emits only accepted index data.
 * Decoder imports remain a consumer callback, so this class has no core/WASM
 * or network ownership. */
export class FfmpegIndexConsumer {
  private recordManifest?: MediaIndexRecordManifest;
  private recordFrames = 0;
  private recordBytesTotal = 0;
  private previousSafeUs = -1;
  private lastSeq = -1;
  private buildId?: string;
  private recordStream = false;
  private active = false;
  private complete = false;
  private stopped = false;
  private trace: Partial<MediaIndexClientTrace> = {};
  private readonly options: {
    identity?: MediaIndexIdentity;
    maxBytes: number;
    startedAt: number;
    onScanProgress?: (progress: MediaIndexScanProgress) => void;
    onRecordManifest?: (manifest: MediaIndexRecordManifest) => void;
    onRecordBatch?: (batch: MediaIndexRecordBatch) => void;
    onRecordComplete?: (manifest: MediaIndexRecordManifest, frames: number) => void;
  };

  constructor(options: {
    identity?: MediaIndexIdentity;
    maxBytes: number;
    startedAt: number;
    onScanProgress?: (progress: MediaIndexScanProgress) => void;
    onRecordManifest?: (manifest: MediaIndexRecordManifest) => void;
    onRecordBatch?: (batch: MediaIndexRecordBatch) => void;
    onRecordComplete?: (manifest: MediaIndexRecordManifest, frames: number) => void;
  }) { this.options = options; }

  accept(event: any): IndexStreamEventResult | 'unhandled' {
    if (event?.type === 'manifest' && event.protocol === 2) {
      this.acceptManifest(event);
      return 'continue';
    }
    if (event?.type === 'reset') {
      if (typeof event.buildId !== 'string' || !/^[0-9a-f-]{36}$/i.test(event.buildId)) {
        throw new Error('FFmpeg 索引重建期间无法安全续传已导入前缀。');
      }
      if (this.recordFrames > 0) {
        this.stopped = true;
        throw new Error('FFmpeg 索引 build 已重启，无法将新记录接到已导入前缀。');
      }
      this.active = true;
      this.buildId = event.buildId;
      this.trace.indexBuildId = this.buildId;
      this.lastSeq = -1;
      this.recordManifest = undefined;
      this.recordStream = false;
      this.previousSafeUs = -1;
      return 'continue';
    }
    if (event?.type === 'batch' && this.recordStream) {
      this.acceptBatch(event);
      return 'continue';
    }
    if (event?.type === 'progress' && event.phase === 'scan' && this.recordStream) {
      if (!Number.isSafeInteger(event.packets) || event.packets < 0
        || !Number.isSafeInteger(event.scannedBytes) || event.scannedBytes < 0
        || !Number.isSafeInteger(event.totalBytes) || event.totalBytes < event.scannedBytes
        || event.totalBytes <= 0) throw new Error('索引扫描 progress 无效。');
      try {
        this.options.onScanProgress?.({ packets: event.packets, scannedBytes: event.scannedBytes, totalBytes: event.totalBytes });
      } catch { /* Progress reporting must not interrupt index transfer. */ }
      return 'continue';
    }
    if (event?.type === 'complete' && this.recordStream) {
      this.acceptComplete(event);
      return 'complete';
    }
    if (event?.type === 'error' && this.recordStream) {
      this.stopped = true;
      return 'stop';
    }
    return 'unhandled';
  }

  private acceptManifest(event: any) {
    const identity = event.identity as MediaIndexIdentity | undefined;
    const metadata = event.metadata as Record<string, unknown> | undefined;
    if (event.kind !== 'ffmpeg' || event.encoding !== 'ffmpeg-records-base64'
      || !Number.isSafeInteger(event.epoch) || event.epoch < 0 || typeof event.buildId !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(event.buildId) || event.recordBytes !== FFMPEG_INDEX_RECORD_BYTES
      || !identity || identity.kind !== 'ffmpeg' || identity.streamKey !== `video:${metadata?.streamIndex}`
      || !metadata || metadata.schema !== 2 || metadata.kind !== 'ffmpeg-container' || metadata.recordBytes !== FFMPEG_INDEX_RECORD_BYTES
      || !Number.isSafeInteger(metadata.size) || Number(metadata.size) <= 0 || typeof metadata.codec !== 'string'
      || !Number.isSafeInteger(metadata.timeBaseNum) || Number(metadata.timeBaseNum) <= 0
      || !Number.isSafeInteger(metadata.timeBaseDen) || Number(metadata.timeBaseDen) <= 0
      || !Number.isSafeInteger(metadata.width) || Number(metadata.width) <= 0 || Number(metadata.width) > 16384
      || !Number.isSafeInteger(metadata.height) || Number(metadata.height) <= 0 || Number(metadata.height) > 16384
      || !Number.isSafeInteger(metadata.streamIndex) || Number(metadata.streamIndex) < 0 || Number(metadata.streamIndex) > 64
      || (metadata.originVerified !== undefined && typeof metadata.originVerified !== 'boolean')
      || !/^[a-z0-9_+-]{1,64}$/i.test(String(metadata.codec)) || !/^[a-f0-9]{40}$/.test(String(metadata.indexerBuild))
      || !/^-?\d+$/.test(String(metadata.firstPts))
      || metadata.indexerBuild !== identity.indexerBuild || metadata.schema !== identity.schemaVersion
      || (this.options.identity && (identity.streamKey !== this.options.identity.streamKey
        || identity.schemaVersion !== this.options.identity.schemaVersion || identity.indexerBuild !== this.options.identity.indexerBuild))
      || !['building', 'streaming', 'complete', 'failed'].includes(event.state)
      || !Number.isSafeInteger(event.lastSeq) || event.lastSeq < -1 || event.lastSeq < this.lastSeq) {
      throw new Error('FFmpeg 索引记录 manifest 无效。');
    }
    const activeBuildId = String(event.buildId);
    if (this.buildId && this.buildId !== activeBuildId) throw new Error('FFmpeg 索引 buildId 在续传期间改变。');
    this.active = true;
    if (!this.buildId) this.buildId = activeBuildId;
    this.trace.indexBuildId = activeBuildId;
    this.trace.indexIdentity = identity;
    const nextManifest: MediaIndexRecordManifest = {
      epoch: event.epoch, buildId: activeBuildId, kind: 'ffmpeg', state: event.state,
      identity, metadata, recordBytes: event.recordBytes, lastSeq: event.lastSeq,
    };
    if (this.recordManifest && !sameRecordIdentity(this.recordManifest, nextManifest)) {
      throw new Error('FFmpeg 索引续传期间 manifest 身份发生改变。');
    }
    this.recordManifest = nextManifest;
    this.recordStream = true;
    this.options.onRecordManifest?.(nextManifest);
  }

  private acceptBatch(event: any) {
    if (!this.recordManifest || event.buildId !== this.buildId || event.seq !== this.lastSeq + 1
      || !Number.isSafeInteger(event.count) || event.count <= 0
      || !Number.isSafeInteger(event.safePresentationUs) || event.safePresentationUs < this.previousSafeUs) {
      throw new Error('FFmpeg 索引记录 batch 序号或 watermark 无效。');
    }
    const records = decodeIndexBase64(event.data);
    if (records.byteLength !== event.count * FFMPEG_INDEX_RECORD_BYTES) throw new Error('FFmpeg 索引记录 batch 长度无效。');
    if (this.recordFrames + event.count > FFMPEG_INDEX_RECORD_LIMIT
      || this.recordBytesTotal + records.byteLength > this.options.maxBytes) throw new Error('FFmpeg 索引记录流超过缓存上限。');
    const parsed = parseFfmpegIndex({ ...this.recordManifest.metadata, count: event.count, records: event.data }, Number(this.recordManifest.metadata.size));
    if (!parsed) throw new Error('FFmpeg 索引记录 batch 内容无效。');
    const view = new DataView(parsed.records.buffer, parsed.records.byteOffset, parsed.records.byteLength);
    const safeTick = view.getBigInt64(parsed.records.byteLength - FFMPEG_INDEX_RECORD_BYTES, true);
    const firstPts = BigInt(String(this.recordManifest.metadata.firstPts));
    const expectedSafeUs = Math.max(0, Math.floor(Number(safeTick - firstPts) * 1_000_000
      * Number(this.recordManifest.metadata.timeBaseNum) / Number(this.recordManifest.metadata.timeBaseDen)));
    if (expectedSafeUs !== event.safePresentationUs) throw new Error('FFmpeg 索引 watermark 与记录末帧不匹配。');
    if (this.trace.firstIndexBatchMs === undefined) this.trace.firstIndexBatchMs = performance.now() - this.options.startedAt;
    this.options.onRecordBatch?.({ buildId: this.recordManifest.buildId, seq: event.seq, records: parsed.records,
      count: event.count, safePresentationUs: event.safePresentationUs });
    this.recordFrames += event.count;
    this.recordBytesTotal += records.byteLength;
    this.previousSafeUs = event.safePresentationUs;
    this.lastSeq = event.seq;
  }

  private acceptComplete(event: any) {
    if (!this.recordManifest || event.buildId !== this.buildId || event.lastSeq !== this.lastSeq
      || event.frames !== this.recordFrames || !Number.isSafeInteger(event.stablePresentationUs)
      || event.stablePresentationUs !== this.previousSafeUs
      || (this.recordManifest.metadata.count !== undefined && this.recordManifest.metadata.count !== this.recordFrames)
      || (this.recordManifest.state === 'complete' && this.recordManifest.lastSeq !== this.lastSeq)) {
      throw new Error('FFmpeg 索引记录流在 complete 前缺少 batch。');
    }
    this.options.onRecordComplete?.(this.recordManifest, this.recordFrames);
    this.trace.indexCompleteMs = performance.now() - this.options.startedAt;
    this.complete = true;
  }

  cursor(): IndexStreamCursor { return { after: this.lastSeq, ...(this.buildId ? { buildId: this.buildId } : {}) }; }
  get isActive() { return this.active; }
  get isComplete() { return this.complete; }
  get isStopped() { return this.stopped; }
  result(): ServerIndexResult | null {
    if (!this.complete || !this.recordManifest) return null;
    return { epoch: this.recordManifest.epoch, index: { streamed: true, buildId: this.recordManifest.buildId,
      count: this.recordFrames, metadata: this.recordManifest.metadata } };
  }
  diagnostics(): Partial<MediaIndexClientTrace> {
    return { ...this.trace, ...(this.trace.indexIdentity ? { indexIdentity: { ...this.trace.indexIdentity } } : {}) };
  }
}
