import { FLV_INDEX_BYTES, parseFlvIndex, serializeFlvIndex } from './flv-index-cache.ts';
import type { FlvIndex } from './flv-demux.ts';

/** Optional cache service. Failures never prevent decoding the original media. */
export class FlvIndexClient {
  private controller = new AbortController();
  private endpoint?: string;
  private epoch?: number;
  private lookup: Promise<FlvIndex | null>;
  constructor(url: string | undefined, privateSize: number) {
    this.size = privateSize;
    if (url) {
      try {
        const source = new URL(url, globalThis.location?.href);
        if (/^\/api\/media\/[0-9a-f]{24}$/.test(source.pathname) && source.searchParams.has('v')) {
          source.pathname += '/frame-index'; this.endpoint = source.href;
        }
      } catch { /* local files and arbitrary external URLs have no cache API */ }
    }
    this.lookup = this.load().catch(() => null);
  }
  private size: number;
  private async load() {
    if (!this.endpoint) return null;
    const response = await fetch(this.endpoint, { cache: 'no-store', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(2000)]) });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader(); if (!reader) return null;
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length; if (size > FLV_INDEX_BYTES + 1024) throw new Error('索引缓存过大。'); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!Number.isSafeInteger(result.epoch)) return null;
    this.epoch = result.epoch;
    return result.index ? parseFlvIndex(result.index, this.size) : null;
  }
  async read(prefix: FlvIndex) {
    const cached = await this.lookup;
    this.lookup = Promise.resolve(null);
    if (!cached || cached.codec !== prefix.codec || cached.description.length !== prefix.description.length
      || cached.description.some((b, i) => b !== prefix.description[i]) || cached.packets.length < prefix.packets.length) return null;
    // Verify against bytes just read from the source before trusting a cache.
    for (let i = 0; i < prefix.packets.length; i++) {
      const a = prefix.packets[i], b = cached.packets[i];
      if (a.offset !== b.offset || a.size !== b.size || a.pts !== b.pts || a.dts !== b.dts || a.key !== b.key) return null;
    }
    return cached;
  }
  async save(index: FlvIndex) {
    await this.lookup;
    if (!this.endpoint || this.epoch === undefined || this.controller.signal.aborted) return;
    const body = JSON.stringify({ epoch: this.epoch, index: serializeFlvIndex(index, this.size) });
    if (new TextEncoder().encode(body).byteLength > FLV_INDEX_BYTES) return;
    const response = await fetch(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voidplayer-action': 'frame-index' }, body,
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]) });
    await response.body?.cancel();
  }
  close() { this.controller.abort(); }
}
