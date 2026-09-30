import { FLV_MEDIA_INDEX_IDENTITY } from './media-index-identity.ts';
import type { MediaIndexIdentity } from './media-index-identity.ts';
import { decodeIndexBase64 } from './index-stream-encoding.ts';
import { IndexStreamTransport } from './index-stream-transport.ts';
import type { IndexStreamEventResult } from './index-stream-transport.ts';
import { FfmpegIndexConsumer } from './ffmpeg-index-consumer.ts';
import type { MediaIndexClientTrace, MediaIndexRecordBatch, MediaIndexRecordManifest, MediaIndexScanProgress, ServerIndexResult } from './media-index-types.ts';
export type { MediaIndexClientTrace, MediaIndexRecordBatch, MediaIndexRecordManifest, MediaIndexScanProgress, ServerIndexResult } from './media-index-types.ts';

const STREAM_BATCH_BYTES = 64 * 1024;

function sameManifest(a: any, b: any): boolean {
  return a.protocol === b.protocol && a.epoch === b.epoch && a.kind === b.kind
    && a.encoding === b.encoding && a.totalBytes === b.totalBytes
    && a.batchBytes === b.batchBytes && a.lastSeq === b.lastSeq;
}


export class MediaIndexClient {
  private controller = new AbortController();
  private endpoint?: string;
  private lookup: Promise<ServerIndexResult | null>;
  private transport: IndexStreamTransport;
  private ffmpegConsumer?: FfmpegIndexConsumer;
  private readonly kind: 'flv' | 'ffmpeg';
  private readonly maxBytes: number;
  private readonly onScanProgress?: (progress: MediaIndexScanProgress) => void;
  private readonly traceStartedAt = performance.now();
  private trace: Partial<MediaIndexClientTrace> = {};
  constructor(url: string | undefined, kind: 'flv' | 'ffmpeg', maxBytes: number, idleTimeoutMs = 120000, requestBuild = false, identity?: MediaIndexIdentity, onScanProgress?: (progress: MediaIndexScanProgress) => void, onRecordManifest?: (manifest: MediaIndexRecordManifest) => void, onRecordBatch?: (batch: MediaIndexRecordBatch) => void, onRecordComplete?: (manifest: MediaIndexRecordManifest, frames: number) => void) {
    this.kind = kind;
    this.maxBytes = maxBytes;
    this.onScanProgress = onScanProgress;
    this.ffmpegConsumer = kind === 'ffmpeg' ? new FfmpegIndexConsumer({
      identity, maxBytes, startedAt: this.traceStartedAt, onScanProgress,
      onRecordManifest, onRecordBatch, onRecordComplete,
    }) : undefined;
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
          if (requestBuild) source.searchParams.set('build', '1');
          this.endpoint = source.href;
        }
      } catch { /* local files and arbitrary URLs have no cache API */ }
    }
    this.transport = new IndexStreamTransport({ idleTimeoutMs, maxBytes, signal: this.controller.signal });
    this.lookup = this.load().catch(() => null);
  }

  private async load(): Promise<ServerIndexResult | null> {
    if (!this.endpoint) return null;
    let manifest: any;
    let buildingManifest: any;
    let transferBytes = new Uint8Array(0);
    let receivedBytes = 0;
    let lastSeq = -1;
    let complete = false;
    const consumeLegacyEvent = (event: any): IndexStreamEventResult => {
      const ffmpegResult = this.ffmpegConsumer?.accept(event);
      if (ffmpegResult && ffmpegResult !== 'unhandled') return ffmpegResult;
      if (event?.type === 'manifest') {
          if (event.protocol !== 1 || event.kind !== this.kind || !Number.isSafeInteger(event.epoch) || event.epoch < 0
            || event.batchBytes !== STREAM_BATCH_BYTES) throw new Error('索引流 manifest 无效。');
          if (event.state === 'building') {
            if (manifest || (buildingManifest && buildingManifest.epoch !== event.epoch)) {
              throw new Error('索引流 building manifest 在续传期间改变。');
            }
            buildingManifest = event;
            return 'continue';
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
          return 'continue';
        }
        if (event?.type === 'batch') {
          if (!manifest || event.seq !== lastSeq + 1 || event.seq > manifest.lastSeq) throw new Error('索引流序号不连续。');
          const bytes = decodeIndexBase64(event.data);
          const expected = Math.min(manifest.batchBytes, manifest.totalBytes - event.seq * manifest.batchBytes);
          if (bytes.byteLength !== expected || receivedBytes + bytes.byteLength > manifest.totalBytes) throw new Error('索引流分块长度无效。');
          transferBytes.set(bytes, event.seq * manifest.batchBytes);
          receivedBytes += bytes.byteLength;
          if (this.trace.firstIndexBatchMs === undefined) this.trace.firstIndexBatchMs = performance.now() - this.traceStartedAt;
          lastSeq = event.seq;
          return 'continue';
        }
        if (event?.type === 'progress') {
          if (event.phase === 'scan') {
            if ((!buildingManifest && !manifest) || !Number.isSafeInteger(event.packets) || event.packets < 0
              || !Number.isSafeInteger(event.scannedBytes) || event.scannedBytes < 0
              || !Number.isSafeInteger(event.totalBytes) || event.totalBytes < event.scannedBytes
              || (buildingManifest && event.totalBytes <= 0)) throw new Error('索引扫描 progress 无效。');
            try {
              this.onScanProgress?.({ packets: event.packets, scannedBytes: event.scannedBytes, totalBytes: event.totalBytes });
            } catch { /* Progress reporting must not interrupt index transfer. */ }
            return 'continue';
          }
          if (event.phase !== 'transfer' || !manifest || event.seq > lastSeq || !Number.isSafeInteger(event.bytesSent)
            || event.bytesSent < 0 || event.bytesSent > manifest.totalBytes) throw new Error('索引流 progress 无效。');
          return 'continue';
        }
        if (event?.type === 'complete') {
          if (!manifest || event.lastSeq !== manifest.lastSeq || lastSeq !== manifest.lastSeq
            || event.totalBytes !== manifest.totalBytes || receivedBytes !== manifest.totalBytes) {
            throw new Error('索引流在 complete 前缺少分块。');
          }
          complete = true;
          this.trace.indexCompleteMs = performance.now() - this.traceStartedAt;
          return 'complete';
        }
        if (event?.type === 'error') {
          return 'stop';
        }
        throw new Error('索引流事件类型未知。');
      };

    const transportResult = await this.transport.read(this.endpoint, {
      cursor: () => this.ffmpegConsumer?.isActive ? this.ffmpegConsumer.cursor() : { after: lastSeq },
      onEvent: consumeLegacyEvent,
    });
    if (transportResult.status === 'legacy') {
      if (this.ffmpegConsumer?.isActive) return null;
      try {
        const result = JSON.parse(new TextDecoder().decode(transportResult.bytes)) as ServerIndexResult;
        return Number.isSafeInteger(result.epoch) && result.epoch >= 0 ? result : null;
      } catch { return null; }
    }
    if (transportResult.status !== 'complete') return null;
    const streamed = this.ffmpegConsumer?.result();
    if (streamed) return streamed;
    if (!complete || !manifest) return null;
    try {
      const result = JSON.parse(new TextDecoder().decode(transferBytes)) as ServerIndexResult;
      if (!Number.isSafeInteger(result.epoch) || result.epoch < 0 || result.epoch !== manifest.epoch) return null;
      return result;
    } catch { return null; }
  }

  get hasEndpoint(): boolean { return !!this.endpoint; }

  async read() {
    const result = await this.lookup;
    return result?.index ?? null;
  }

  diagnostics(): MediaIndexClientTrace {
    const trace = { ...this.transport.diagnostics(), ...this.ffmpegConsumer?.diagnostics(), ...this.trace };
    return { ...trace, ...(trace.indexIdentity ? { indexIdentity: { ...trace.indexIdentity } } : {}) } as MediaIndexClientTrace;
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
