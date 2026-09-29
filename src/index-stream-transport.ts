export interface IndexStreamCursor {
  after: number;
  buildId?: string;
}

export type IndexStreamEventResult = 'continue' | 'complete' | 'stop';
export interface IndexStreamTransportHandlers {
  cursor(): IndexStreamCursor;
  onEvent(event: unknown): IndexStreamEventResult;
}
export type IndexStreamTransportResult =
  | { status: 'complete' | 'stopped' | 'aborted' | 'failed' }
  | { status: 'legacy'; bytes: Uint8Array };
export interface IndexStreamTransportTrace {
  serverIndexRequests: number;
  reconnects: number;
}

const MAX_EVENT_CHARS = 64 * 1024 * 2 + 4096;
const RETRY_DELAY_BASE_MS = 100;
const RETRY_DELAY_MAX_MS = 2000;

function retryDelay(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = (retry: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(retry);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** HTTP and NDJSON transport for resumable media-index streams. It only knows
 * the generic sequence/build cursor; container-specific event meaning stays
 * with the consumer. */
export class IndexStreamTransport {
  private readonly trace: IndexStreamTransportTrace = { serverIndexRequests: 0, reconnects: 0 };
  private readonly options: { idleTimeoutMs: number; maxBytes: number; signal: AbortSignal };

  constructor(options: { idleTimeoutMs: number; maxBytes: number; signal: AbortSignal }) { this.options = options; }

  async read(endpoint: string, handlers: IndexStreamTransportHandlers): Promise<IndexStreamTransportResult> {
    let attempt = 0;
    while (!this.options.signal.aborted) {
      const cursor = handlers.cursor();
      const url = new URL(endpoint);
      url.searchParams.set('after', String(cursor.after));
      if (cursor.buildId) url.searchParams.set('buildId', cursor.buildId);

      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      this.options.signal.addEventListener('abort', abortRequest, { once: true });
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdleTimeout = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => requestController.abort(), this.options.idleTimeoutMs);
      };
      const clearRequestTimeout = () => {
        clearTimeout(idleTimer);
        this.options.signal.removeEventListener('abort', abortRequest);
      };
      const retry = async () => {
        clearRequestTimeout();
        const delayMs = Math.min(RETRY_DELAY_BASE_MS * (2 ** Math.min(attempt, 4)), RETRY_DELAY_MAX_MS);
        attempt++;
        return retryDelay(this.options.signal, delayMs);
      };
      resetIdleTimeout();
      this.trace.serverIndexRequests++;
      if (attempt > 0) this.trace.reconnects++;

      let response: Response;
      try {
        response = await fetch(url, {
          cache: 'no-store',
          headers: { accept: 'application/x-ndjson, application/json;q=0.8' },
          signal: requestController.signal,
        });
      } catch {
        if (this.options.signal.aborted) { clearRequestTimeout(); return { status: 'aborted' }; }
        if (!await retry()) return { status: 'aborted' };
        continue;
      }

      if (!response.ok) {
        clearRequestTimeout();
        await response.body?.cancel().catch(() => {});
        if (response.status >= 500) {
          if (!await retry()) return { status: 'aborted' };
          continue;
        }
        return { status: 'failed' };
      }

      if (!response.headers.get('content-type')?.toLowerCase().includes('application/x-ndjson')) {
        let result: Uint8Array | null;
        try { result = await this.readLegacy(response, resetIdleTimeout); }
        finally { clearRequestTimeout(); }
        return result ? { status: 'legacy', bytes: result } : { status: 'failed' };
      }

      const reader = response.body?.getReader();
      if (!reader) { clearRequestTimeout(); return { status: 'failed' }; }
      const decoder = new TextDecoder();
      let buffer = '';
      let streamFailed = false;
      let terminal: IndexStreamEventResult | undefined;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.byteLength) { resetIdleTimeout(); attempt = 0; }
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            try { terminal = handlers.onEvent(JSON.parse(line)); }
            catch { terminal = 'stop'; }
            if (terminal === 'complete' || terminal === 'stop') break;
          }
          if (terminal === 'complete' || terminal === 'stop') break;
          if (buffer.length > MAX_EVENT_CHARS) { terminal = 'stop'; break; }
        }
        if (terminal !== 'complete' && terminal !== 'stop') {
          buffer += decoder.decode();
          if (buffer.trim()) {
            try { terminal = handlers.onEvent(JSON.parse(buffer)); }
            catch { terminal = 'stop'; }
          }
        }
      } catch {
        streamFailed = true;
      } finally {
        clearRequestTimeout();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }

      if (this.options.signal.aborted) return { status: 'aborted' };
      if (terminal === 'complete') return { status: 'complete' };
      if (terminal === 'stop') return { status: 'stopped' };
      if (streamFailed || terminal === 'continue' || !terminal) {
        if (!await retry()) return { status: 'aborted' };
      }
    }
    return { status: 'aborted' };
  }

  diagnostics(): IndexStreamTransportTrace { return { ...this.trace }; }

  private async readLegacy(response: Response, onChunk: () => void): Promise<Uint8Array | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        onChunk();
        size += value.length;
        if (size > this.options.maxBytes) throw new Error('索引缓存超过上限。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
}
