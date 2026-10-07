import type { NativeAnalysisCommands, NativeAnalysisReply } from './native-protocol.ts';

/** Dedicated metadata worker: no decoded frames or playback buffers cross
 * this channel. Cancellation immediately settles callers and stops queued or executing work at the next bounded worker turn. */
export class NativeAnalysisClient {
  private worker?: Worker;
  private opening?: Promise<Worker>;
  private nextId = 0;
  private failure?: Error;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }>();

  private open() {
    return this.opening ??= (async () => {
      const worker = typeof Worker !== 'undefined'
        ? new Worker(new URL('./native-worker.ts', import.meta.url), { type: 'module' })
        : new (await import('node:worker_threads')).Worker(new URL('./native-worker.ts', import.meta.url)) as unknown as Worker;
      if (this.failure) { void worker.terminate(); throw this.failure; }
      this.worker = worker;
      const receive = (reply: NativeAnalysisReply) => {
        if ('event' in reply) return;
        const request = this.pending.get(reply.id); if (!request) return;
        this.pending.delete(reply.id); request.cleanup();
        if (reply.ok) request.resolve(reply.data); else { const error = new Error(reply.error); error.name = reply.name ?? 'Error'; request.reject(error); }
      };
      if (typeof worker.addEventListener === 'function') {
        worker.addEventListener('message', event => receive(event.data));
        worker.addEventListener('error', event => this.close(new Error(event.message)));
        worker.addEventListener('messageerror', () => this.close(new Error('Invalid native analysis worker reply.')));
      } else {
        const node = worker as unknown as import('node:worker_threads').Worker;
        node.on('message', receive); node.on('error', error => this.close(error instanceof Error ? error : new Error(String(error))));
        node.on('exit', code => this.close(new Error(`Native analysis worker exit ${code}.`)));
      }
      return worker;
    })();
  }

  async call<K extends keyof NativeAnalysisCommands>(type: K, input: NativeAnalysisCommands[K]['input'], signal?: AbortSignal, transfer: Transferable[] = []): Promise<NativeAnalysisCommands[K]['output']> {
    signal?.throwIfAborted(); if (this.failure) throw this.failure;
    const worker = await this.open();
    signal?.throwIfAborted(); if (this.failure) throw this.failure;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id); cleanup();
        try { worker.postMessage({ type: 'cancel', id }); } catch { /* Worker may already have exited. */ }
        reject(signal?.reason);
      };
      const timer = setTimeout(() => this.close(new Error('Native analysis worker timed out.')), 30_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      try { worker.postMessage({ id, type, input }, transfer); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  close(error = new Error('Native analysis source disposed.')) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) { request.cleanup(); request.reject(error); }
    this.pending.clear(); void this.worker?.terminate();
  }
}
