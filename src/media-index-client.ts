export interface ServerIndexResult { epoch: number; index: unknown | null; }
export class MediaIndexClient {
  private controller = new AbortController();
  private endpoint?: string;
  private lookup: Promise<ServerIndexResult | null>;
  constructor(url: string | undefined, private readonly kind: 'flv' | 'ffmpeg', private readonly maxBytes: number, private readonly timeoutMs = 2000) {
    if (url) {
      try {
        const source = new URL(url, globalThis.location?.href);
        if (/^\/api\/media\/[0-9a-f]{24}$/.test(source.pathname) && source.searchParams.has('v')) {
          source.pathname += '/frame-index';
          source.searchParams.set('kind', kind);
          this.endpoint = source.href;
        }
      } catch { /* local files and arbitrary URLs have no cache API */ }
    }
    this.lookup = this.load().catch(() => null);
  }
  private async load(): Promise<ServerIndexResult | null> {
    if (!this.endpoint) return null;
    const response = await fetch(this.endpoint, {
      cache: 'no-store',
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs)]),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
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
