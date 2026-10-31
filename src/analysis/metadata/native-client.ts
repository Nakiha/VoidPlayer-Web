import type { NativeAnalysisCommands, NativeAnalysisReply } from '../../../shared/analysis/metadata/native-protocol.ts';

/** Dedicated metadata worker: no decoded frames or playback buffers cross
 * this channel. Cancellation immediately settles callers and stops queued or executing work at the next bounded worker turn. */
export class NativeAnalysisClient {
  private worker?: Worker;
  private opening?: Promise<Worker>;
  private detachListeners?:()=>void;
  private factory?:()=>Worker;
  constructor(factory?:()=>Worker){this.factory=factory;}
  private nextId = 0;
  private failure?: Error;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }>();

  private open() {
    return this.opening ??= (async () => {
      const worker = this.factory ? this.factory() : new Worker(new URL('./native-worker.ts', import.meta.url), { type: 'module' });
      if (this.failure) { void worker.terminate(); throw this.failure; }
      this.worker = worker;
      const receive = (reply: NativeAnalysisReply) => {
        if ('event' in reply) return;
        const request = this.pending.get(reply.id); if (!request) return;
        this.pending.delete(reply.id); request.cleanup();
        if (reply.ok) request.resolve(reply.data); else { const error = new Error(reply.error); error.name = reply.name ?? 'Error'; request.reject(error); }
      };
      if (typeof worker.addEventListener === 'function') {
        const message=(event:MessageEvent)=>receive(event.data);
        const error=(event:ErrorEvent)=>this.close(new Error(event.message));
        const invalid=()=>this.close(new Error('Invalid native analysis worker reply.'));
        worker.addEventListener('message',message);worker.addEventListener('error',error);worker.addEventListener('messageerror',invalid);
        this.detachListeners=()=>{worker.removeEventListener('message',message);worker.removeEventListener('error',error);worker.removeEventListener('messageerror',invalid);};
      } else {
        const node = worker as unknown as { on(type: string, listener: (...args: any[]) => void): void; off(type: string, listener: (...args: any[]) => void): void };
        const error=(error:unknown)=>this.close(error instanceof Error?error:new Error(String(error)));
        const exit=(code:number)=>this.close(new Error(`Native analysis worker exit ${code}.`));
        const invalid=()=>this.close(new Error('Invalid native analysis worker reply.'));
        node.on('message',receive);node.on('error',error);node.on('exit',exit);node.on('messageerror',invalid);
        this.detachListeners=()=>{node.off('message',receive);node.off('error',error);node.off('exit',exit);node.off('messageerror',invalid);};
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
    this.pending.clear();
    const detach=this.detachListeners;this.detachListeners=undefined;
    const worker=this.worker;this.worker=undefined;
    // Keep Node's error handler until termination completes so a late event
    // cannot become an unhandled EventEmitter error. Browser terminate is synchronous.
    try {const ended=worker?.terminate();if(ended&&typeof (ended as unknown as Promise<unknown>).then==='function')
      void Promise.resolve(ended).then(()=>detach?.(),()=>detach?.());else detach?.();}
    catch(error){detach?.();throw error;}
  }
}
