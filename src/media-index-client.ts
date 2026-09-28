import { FLV_MEDIA_INDEX_IDENTITY } from './media-index-identity.ts';
import type { MediaIndexIdentity } from './media-index-identity.ts';

export interface ServerIndexResult { epoch: number; index: unknown | null; }

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

export class MediaIndexClient {
  private controller = new AbortController();
  private endpoint?: string;
  private lookup: Promise<ServerIndexResult | null>;
  constructor(url: string | undefined, private readonly kind: 'flv' | 'ffmpeg', private readonly maxBytes: number, private readonly timeoutMs = 30000, requestBuild = false, identity?: MediaIndexIdentity) {
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
    let transferBytes = new Uint8Array(0);
    let receivedBytes = 0;
    let lastSeq = -1;
    let complete = false;

    for (let attempt = 0; attempt < STREAM_ATTEMPTS && !complete; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.controller.signal.aborted) return null;
      const requestUrl = new URL(this.endpoint);
      requestUrl.searchParams.set('after', String(lastSeq));
      let response: Response;
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
        const legacy = await this.readLegacy(response);
        return legacy;
      }
      const reader = response.body?.getReader();
      if (!reader) return null;
      let buffer = '';
      const decoder = new TextDecoder();
      let streamFailed = false;

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event?.type === 'manifest') {
          if (event.protocol !== 1 || event.kind !== this.kind || event.state !== 'complete' || event.encoding !== 'json-utf8-base64'
            || !Number.isSafeInteger(event.epoch) || event.epoch < 0
            || !Number.isSafeInteger(event.totalBytes) || event.totalBytes < 0 || event.totalBytes > this.maxBytes
            || event.batchBytes !== STREAM_BATCH_BYTES
            || !Number.isSafeInteger(event.lastSeq)
            || event.lastSeq !== Math.ceil(event.totalBytes / event.batchBytes) - 1) {
            throw new Error('索引流 manifest 无效。');
          }
          if (manifest && !sameManifest(manifest, event)) throw new Error('索引流 manifest 在续传期间改变。');
          if (!manifest) transferBytes = new Uint8Array(event.totalBytes);
          manifest = event;
          return;
        }
        if (event?.type === 'batch') {
          if (!manifest || event.seq !== lastSeq + 1 || event.seq > manifest.lastSeq) throw new Error('索引流序号不连续。');
          const bytes = decodeBase64(event.data);
          const expected = Math.min(manifest.batchBytes, manifest.totalBytes - event.seq * manifest.batchBytes);
          if (bytes.byteLength !== expected || receivedBytes + bytes.byteLength > manifest.totalBytes) throw new Error('索引流分块长度无效。');
          transferBytes.set(bytes, event.seq * manifest.batchBytes);
          receivedBytes += bytes.byteLength;
          lastSeq = event.seq;
          return;
        }
        if (event?.type === 'progress') {
          if (!manifest || event.seq > lastSeq || !Number.isSafeInteger(event.bytesSent)
            || event.bytesSent < 0 || event.bytesSent > manifest.totalBytes) throw new Error('索引流 progress 无效。');
          return;
        }
        if (event?.type === 'complete') {
          if (!manifest || event.lastSeq !== manifest.lastSeq || lastSeq !== manifest.lastSeq
            || event.totalBytes !== manifest.totalBytes || receivedBytes !== manifest.totalBytes) {
            throw new Error('索引流在 complete 前缺少分块。');
          }
          complete = true;
          return;
        }
        if (event?.type === 'error') throw new Error(typeof event.message === 'string' ? event.message : '服务端索引流失败。');
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
      if (this.controller.signal.aborted) return null;
      if (streamFailed || !complete) continue;
    }

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
