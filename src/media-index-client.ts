import { FLV_MEDIA_INDEX_IDENTITY } from './media-index-identity.ts';
import type { MediaIndexIdentity } from './media-index-identity.ts';
import { FFMPEG_INDEX_RECORD_BYTES, FFMPEG_INDEX_RECORD_LIMIT, parseFfmpegIndex } from './ffmpeg-index-cache.ts';

export interface ServerIndexResult { epoch: number; index: unknown | null; }
export interface MediaIndexScanProgress { scannedBytes: number; totalBytes: number; packets: number; }
export interface MediaIndexRecordManifest {
  epoch: number; buildId: string; kind: 'ffmpeg'; state: 'building' | 'streaming' | 'complete' | 'failed';
  identity: MediaIndexIdentity; metadata: Record<string, unknown>; recordBytes: number; lastSeq: number;
}
export interface MediaIndexRecordBatch {
  buildId: string; seq: number; records: Uint8Array; count: number; safePresentationUs: number;
}
export interface MediaIndexClientTrace {
  serverIndexRequests: number;
  reconnects: number;
  indexBuildId?: string;
  indexIdentity?: MediaIndexIdentity;
  firstIndexBatchMs?: number;
  indexCompleteMs?: number;
  /** Time spent importing delivered records into the decoder core (diagnostic only). */
  recordImportMs?: number;
}

const STREAM_BATCH_BYTES = 64 * 1024;
const STREAM_ATTEMPTS = 3;

function decodeBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('索引流分块编码无效。');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameManifest(a: any, b: any): boolean {
  return a.protocol === b.protocol && a.epoch === b.epoch && a.kind === b.kind
    && a.encoding === b.encoding && a.totalBytes === b.totalBytes
    && a.batchBytes === b.batchBytes && a.lastSeq === b.lastSeq;
}

function sameRecordIdentity(a: MediaIndexRecordManifest, b: MediaIndexRecordManifest): boolean {
  if (a.epoch !== b.epoch || a.buildId !== b.buildId || a.recordBytes !== b.recordBytes
    || a.identity.kind !== b.identity.kind || a.identity.streamKey !== b.identity.streamKey
    || a.identity.schemaVersion !== b.identity.schemaVersion || a.identity.indexerBuild !== b.identity.indexerBuild) return false;
  const stableFields = ['schema', 'kind', 'size', 'codec', 'timeBaseNum', 'timeBaseDen', 'width', 'height',
    'recordBytes', 'streamIndex', 'indexerBuild', 'firstPts', 'originVerified'] as const;
  return stableFields.every(key => a.metadata[key] === b.metadata[key]);
}

export class MediaIndexClient {
  private controller = new AbortController();
  private endpoint?: string;
  private lookup: Promise<ServerIndexResult | null>;
  private readonly kind: 'flv' | 'ffmpeg';
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly identity?: MediaIndexIdentity;
  private readonly onScanProgress?: (progress: MediaIndexScanProgress) => void;
  private readonly onRecordManifest?: (manifest: MediaIndexRecordManifest) => void;
  private readonly onRecordBatch?: (batch: MediaIndexRecordBatch) => void;
  private readonly onRecordComplete?: (manifest: MediaIndexRecordManifest, frames: number) => void;
  private readonly traceStartedAt = performance.now();
  private trace: MediaIndexClientTrace = { serverIndexRequests: 0, reconnects: 0 };
  constructor(url: string | undefined, kind: 'flv' | 'ffmpeg', maxBytes: number, timeoutMs = 300000, requestBuild = false, identity?: MediaIndexIdentity, onScanProgress?: (progress: MediaIndexScanProgress) => void, onRecordManifest?: (manifest: MediaIndexRecordManifest) => void, onRecordBatch?: (batch: MediaIndexRecordBatch) => void, onRecordComplete?: (manifest: MediaIndexRecordManifest, frames: number) => void) {
    this.kind = kind;
    this.maxBytes = maxBytes;
    this.timeoutMs = timeoutMs;
    this.identity = identity;
    this.onScanProgress = onScanProgress;
    this.onRecordManifest = onRecordManifest;
    this.onRecordBatch = onRecordBatch;
    this.onRecordComplete = onRecordComplete;
    if (url) {
      try {
        const source = new URL(url, globalThis.location?.href);
        if (/^\/api\/media\/[0-9a-f]{24}$/.test(source.pathname) && source.searchParams.has('v')) {
          source.pathname += '/frame-index';
          source.searchParams.set('kind', kind);
          const resolvedIdentity = identity ?? (kind === 'flv' ? FLV_MEDIA_INDEX_IDENTITY : undefined);
          if (resolvedIdentity) {
            source.searchParams.set('stream', resolvedIdentity.streamKey);
            source.searchParams.set('schema', String(resolvedIdentity.schemaVersion));
            source.searchParams.set('indexer', resolvedIdentity.indexerBuild);
          }
          if (kind === 'ffmpeg' && requestBuild) source.searchParams.set('build', '1');
          this.endpoint = source.href;
        }
      } catch { /* local files and arbitrary URLs have no cache API */ }
    }
    this.lookup = this.load().catch(() => null);
  }

  private async load(): Promise<ServerIndexResult | null> {
    if (!this.endpoint) return null;
    const deadline = Date.now() + this.timeoutMs;
    let manifest: any;
    let buildingManifest: any;
    let transferBytes = new Uint8Array(0);
    let receivedBytes = 0;
    let lastSeq = -1;
    let complete = false;
    let buildId: string | undefined;
    let recordManifest: MediaIndexRecordManifest | undefined;
    let recordFrames = 0;
    let recordBytesTotal = 0;
    let previousSafeUs = -1;
    let recordStream = false;

    for (let attempt = 0; attempt < STREAM_ATTEMPTS && !complete; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.controller.signal.aborted) return null;
      const requestUrl = new URL(this.endpoint);
      requestUrl.searchParams.set('after', String(lastSeq));
      if (buildId) requestUrl.searchParams.set('buildId', buildId);
      let response: Response;
      this.trace.serverIndexRequests++;
      if (attempt > 0) this.trace.reconnects++;
      try {
        response = await fetch(requestUrl, {
          cache: 'no-store',
          headers: { accept: 'application/x-ndjson, application/json;q=0.8' },
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(Math.max(1, remaining))]),
        });
      } catch {
        if (this.controller.signal.aborted) return null;
        continue;
      }

      if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/x-ndjson')) {
        if (recordFrames > 0) return null;
        const legacy = await this.readLegacy(response);
        return legacy;
      }
      const reader = response.body?.getReader();
      if (!reader) return null;
      let buffer = '';
      const decoder = new TextDecoder();
      let streamFailed = false;
      let serverRejected = false;

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event?.type === 'manifest') {
          if (event.protocol === 2) {
            const identity = event.identity as MediaIndexIdentity | undefined;
            const metadata = event.metadata as Record<string, unknown> | undefined;
            if (this.kind !== 'ffmpeg' || event.kind !== 'ffmpeg' || event.encoding !== 'ffmpeg-records-base64'
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
              || (this.identity && (identity.streamKey !== this.identity.streamKey || identity.schemaVersion !== this.identity.schemaVersion || identity.indexerBuild !== this.identity.indexerBuild))
              || !['building', 'streaming', 'complete', 'failed'].includes(event.state)
              || !Number.isSafeInteger(event.lastSeq) || event.lastSeq < -1 || event.lastSeq < lastSeq) {
              throw new Error('FFmpeg 索引记录 manifest 无效。');
            }
            const activeBuildId = String(event.buildId);
            if (buildId && buildId !== activeBuildId) throw new Error('FFmpeg 索引 buildId 在续传期间改变。');
            if (!buildId) buildId = activeBuildId;
            this.trace.indexBuildId = activeBuildId;
            this.trace.indexIdentity = identity;
            const nextManifest: MediaIndexRecordManifest = { epoch: event.epoch, buildId: activeBuildId, kind: 'ffmpeg', state: event.state, identity, metadata, recordBytes: event.recordBytes, lastSeq: event.lastSeq };
            if (recordManifest && !sameRecordIdentity(recordManifest, nextManifest)) throw new Error('FFmpeg 索引续传期间 manifest 身份发生改变。');
            recordManifest = nextManifest;
            recordStream = true;
            try { this.onRecordManifest?.(recordManifest); } catch (error) { throw error; }
            return;
          }
          if (event.protocol !== 1 || event.kind !== this.kind || !Number.isSafeInteger(event.epoch) || event.epoch < 0
            || event.batchBytes !== STREAM_BATCH_BYTES) throw new Error('索引流 manifest 无效。');
          if (event.state === 'building') {
            if (manifest || (buildingManifest && buildingManifest.epoch !== event.epoch)) {
              throw new Error('索引流 building manifest 在续传期间改变。');
            }
            buildingManifest = event;
            return;
          }
          if (event.state !== 'complete' || event.encoding !== 'json-utf8-base64'
            || !Number.isSafeInteger(event.totalBytes) || event.totalBytes < 0 || event.totalBytes > this.maxBytes
            || !Number.isSafeInteger(event.lastSeq)
            || event.lastSeq !== Math.ceil(event.totalBytes / event.batchBytes) - 1
            || (buildingManifest && buildingManifest.epoch !== event.epoch)) {
            throw new Error('索引流 manifest 无效。');
          }
          if (manifest && !sameManifest(manifest, event)) throw new Error('索引流 manifest 在续传期间改变。');
          if (!manifest) transferBytes = new Uint8Array(event.totalBytes);
          manifest = event;
          return;
        }
        if (event?.type === 'batch') {
          if (recordStream) {
            if (!recordManifest || event.buildId !== buildId || event.seq !== lastSeq + 1
              || !Number.isSafeInteger(event.count) || event.count <= 0
              || !Number.isSafeInteger(event.safePresentationUs) || event.safePresentationUs < previousSafeUs) {
              throw new Error('FFmpeg 索引记录 batch 序号或 watermark 无效。');
            }
            const records = decodeBase64(event.data);
            if (records.byteLength !== event.count * FFMPEG_INDEX_RECORD_BYTES) throw new Error('FFmpeg 索引记录 batch 长度无效。');
            if (recordFrames + event.count > FFMPEG_INDEX_RECORD_LIMIT
              || recordBytesTotal + records.byteLength > this.maxBytes) throw new Error('FFmpeg 索引记录流超过缓存上限。');
            const parsed = parseFfmpegIndex({ ...recordManifest.metadata, count: event.count, records: event.data }, Number(recordManifest.metadata.size));
            if (!parsed) throw new Error('FFmpeg 索引记录 batch 内容无效。');
            const view = new DataView(parsed.records.buffer, parsed.records.byteOffset, parsed.records.byteLength);
            const safeTick = view.getBigInt64(parsed.records.byteLength - FFMPEG_INDEX_RECORD_BYTES, true);
            const firstPts = BigInt(String(recordManifest.metadata.firstPts));
            const expectedSafeUs = Math.max(0, Math.floor(Number(safeTick - firstPts) * 1_000_000
              * Number(recordManifest.metadata.timeBaseNum) / Number(recordManifest.metadata.timeBaseDen)));
            if (expectedSafeUs !== event.safePresentationUs) throw new Error('FFmpeg 索引 watermark 与记录末帧不匹配。');
            if (this.trace.firstIndexBatchMs === undefined) this.trace.firstIndexBatchMs = performance.now() - this.traceStartedAt;
            this.onRecordBatch?.({ buildId: recordManifest.buildId, seq: event.seq, records: parsed.records, count: event.count, safePresentationUs: event.safePresentationUs });
            recordFrames += event.count;
            recordBytesTotal += records.byteLength;
            previousSafeUs = event.safePresentationUs;
            lastSeq = event.seq;
            return;
          }
          if (!manifest || event.seq !== lastSeq + 1 || event.seq > manifest.lastSeq) throw new Error('索引流序号不连续。');
          const bytes = decodeBase64(event.data);
          const expected = Math.min(manifest.batchBytes, manifest.totalBytes - event.seq * manifest.batchBytes);
          if (bytes.byteLength !== expected || receivedBytes + bytes.byteLength > manifest.totalBytes) throw new Error('索引流分块长度无效。');
          transferBytes.set(bytes, event.seq * manifest.batchBytes);
          receivedBytes += bytes.byteLength;
          if (this.trace.firstIndexBatchMs === undefined) this.trace.firstIndexBatchMs = performance.now() - this.traceStartedAt;
          lastSeq = event.seq;
          return;
        }
        if (event?.type === 'reset') {
          if (typeof event.buildId !== 'string' || !/^[0-9a-f-]{36}$/i.test(event.buildId)) {
            throw new Error('FFmpeg 索引重建期间无法安全续传已导入前缀。');
          }
          if (recordFrames > 0) {
            serverRejected = true;
            throw new Error('FFmpeg 索引 build 已重启，无法将新记录接到已导入前缀。');
          }
          buildId = event.buildId;
          this.trace.indexBuildId = buildId;
          lastSeq = -1;
          recordManifest = undefined;
          recordStream = false;
          previousSafeUs = -1;
          return;
        }
        if (event?.type === 'progress') {
          if (event.phase === 'scan') {
            if ((!buildingManifest && !manifest && !recordManifest) || !Number.isSafeInteger(event.packets) || event.packets < 0
              || !Number.isSafeInteger(event.scannedBytes) || event.scannedBytes < 0
              || !Number.isSafeInteger(event.totalBytes) || event.totalBytes < event.scannedBytes
              || (buildingManifest && event.totalBytes <= 0)) throw new Error('索引扫描 progress 无效。');
            try {
              this.onScanProgress?.({ packets: event.packets, scannedBytes: event.scannedBytes, totalBytes: event.totalBytes });
            } catch { /* Progress reporting must not interrupt index transfer. */ }
            return;
          }
          if (event.phase !== 'transfer' || !manifest || event.seq > lastSeq || !Number.isSafeInteger(event.bytesSent)
            || event.bytesSent < 0 || event.bytesSent > manifest.totalBytes) throw new Error('索引流 progress 无效。');
          return;
        }
        if (event?.type === 'complete') {
          if (recordStream) {
            if (!recordManifest || event.buildId !== buildId || event.lastSeq !== lastSeq
              || event.frames !== recordFrames || !Number.isSafeInteger(event.stablePresentationUs)
              || event.stablePresentationUs !== previousSafeUs
              || (recordManifest.metadata.count !== undefined && recordManifest.metadata.count !== recordFrames)
              || (recordManifest.state === 'complete' && recordManifest.lastSeq !== lastSeq)) {
              throw new Error('FFmpeg 索引记录流在 complete 前缺少 batch。');
            }
            this.onRecordComplete?.(recordManifest, recordFrames);
            this.trace.indexCompleteMs = performance.now() - this.traceStartedAt;
            complete = true;
            return;
          }
          if (!manifest || event.lastSeq !== manifest.lastSeq || lastSeq !== manifest.lastSeq
            || event.totalBytes !== manifest.totalBytes || receivedBytes !== manifest.totalBytes) {
            throw new Error('索引流在 complete 前缺少分块。');
          }
          this.trace.indexCompleteMs = performance.now() - this.traceStartedAt;
          complete = true;
          return;
        }
        if (event?.type === 'error') {
          serverRejected = true;
          throw new Error(typeof event.message === 'string' ? event.message : '服务端索引流失败。');
        }
        throw new Error('索引流事件类型未知。');
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            consumeLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
          if (buffer.length > STREAM_BATCH_BYTES * 2 + 4096) throw new Error('索引流事件超过大小上限。');
        }
        buffer += decoder.decode();
        if (buffer.trim()) consumeLine(buffer);
      } catch {
        streamFailed = true;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (this.controller.signal.aborted || serverRejected) return null;
      if (streamFailed || !complete) continue;
    }

    if (recordStream) return complete && recordManifest
      ? { epoch: recordManifest.epoch, index: { streamed: true, buildId: recordManifest.buildId, count: recordFrames, metadata: recordManifest.metadata } }
      : null;
    if (!complete || !manifest) return null;
    try {
      const result = JSON.parse(new TextDecoder().decode(transferBytes)) as ServerIndexResult;
      if (!Number.isSafeInteger(result.epoch) || result.epoch < 0 || result.epoch !== manifest.epoch) return null;
      return result;
    } catch { return null; }
  }

  private async readLegacy(response: Response): Promise<ServerIndexResult | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > this.maxBytes) throw new Error('索引缓存超过上限。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const result = JSON.parse(new TextDecoder().decode(bytes)) as ServerIndexResult;
    if (!Number.isSafeInteger(result.epoch) || result.epoch < 0) return null;
    return result;
  }

  async read() {
    const result = await this.lookup;
    return result?.index ?? null;
  }

  diagnostics(): MediaIndexClientTrace {
    return { ...this.trace, ...(this.trace.indexIdentity ? { indexIdentity: { ...this.trace.indexIdentity } } : {}) };
  }

  async save(index: unknown) {
    const result = await this.lookup;
    if (!this.endpoint || !result || this.controller.signal.aborted) return;
    const body = JSON.stringify({ epoch: result.epoch, kind: this.kind, index });
    if (body.length > this.maxBytes) return;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voidplayer-action': 'frame-index' },
      body,
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
    });
    await response.body?.cancel();
  }

  close() { this.controller.abort(); }
}
