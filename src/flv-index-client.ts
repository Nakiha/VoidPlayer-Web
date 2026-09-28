import { FLV_INDEX_BYTES, parseFlvIndex, serializeFlvIndex } from './flv-index-cache.ts';
import type { FlvIndex } from './flv-demux.ts';
import { MediaIndexClient } from './media-index-client.ts';

/** Optional cache service. Failures never prevent decoding the original media. */
export class FlvIndexClient {
  private transport: MediaIndexClient;
  constructor(url: string | undefined, privateSize: number) {
    this.size = privateSize;
    this.transport = new MediaIndexClient(url, 'flv', FLV_INDEX_BYTES + 1024);
  }
  private size: number;
  async read(prefix: FlvIndex) {
    const value = await this.transport.read();
    const cached = value ? parseFlvIndex(value, this.size) : null;
    if (!cached || cached.codec !== prefix.codec || cached.description.length !== prefix.description.length
      || cached.description.some((b, i) => b !== prefix.description[i]) || cached.packets.length < prefix.packets.length) return null;
    const originalConfigs = prefix.configurations ?? [prefix.description], cachedConfigs = cached.configurations ?? [cached.description];
    if (originalConfigs.some((c, i) => !cachedConfigs[i] || c.length !== cachedConfigs[i].length || c.some((b, j) => b !== cachedConfigs[i][j]))) return null;
    // Verify against bytes just read from the source before trusting a cache.
    for (let i = 0; i < prefix.packets.length; i++) {
      const a = prefix.packets[i], b = cached.packets[i];
      if (a.offset !== b.offset || a.size !== b.size || a.pts !== b.pts || a.dts !== b.dts || a.key !== b.key || (a.configuration ?? 0) !== (b.configuration ?? 0)) return null;
    }
    return cached;
  }
  async save(index: FlvIndex) {
    await this.transport.save(serializeFlvIndex(index, this.size));
  }
  close() { this.transport.close(); }
}
