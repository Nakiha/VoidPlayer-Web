import { FramePairError, pairBudget } from '../../../shared/analysis/quality/frame-pair.ts';
import type { FramePairRequest, FramePairResult } from '../../../shared/analysis/quality/frame-pair.ts';
import type { PreparedPairSource } from './source.ts';

export type PairWorker = { postMessage(data: unknown): void; onmessage: ((event: MessageEvent) => unknown) | null; onerror: ((event: ErrorEvent) => unknown) | null; onmessageerror: ((event: MessageEvent) => unknown) | null } & { terminate(): void | Promise<unknown> };
/** Internal one-shot bridge. One admitted worker per client; no queue, storage or UI. */
export class FramePairClient {
  private active = false;
  private createWorker: () => PairWorker;
  constructor(createWorker: () => PairWorker = () => new Worker(new URL('./pair-worker.ts', import.meta.url), { type: 'module' })) { this.createWorker = createWorker; }
  measure(request: FramePairRequest, sources: [PreparedPairSource, PreparedPairSource], base: string, signal: AbortSignal): Promise<FramePairResult> {
    const budget = pairBudget(request);
    signal.throwIfAborted();
    if (this.active) return Promise.reject(new FramePairError('busy', 'A pair is already running'));
    this.active = true;
    return new Promise((resolve, reject) => {
      let worker: PairWorker | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false;
      const finish = (outcome: { ok: true; result: FramePairResult } | { ok: false; error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        const release = () => { this.active = false; if (outcome.ok) resolve(outcome.result); else reject(outcome.error); };
        if (worker) {
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          // Browser termination is synchronous; asynchronous test hosts must acknowledge exit.
          try { const stopped = worker.terminate(); if (stopped) { stopped.then(release, reject); return; } } catch (failure) { reject(failure); return; }
        }
        release();
      };
      const abort = () => finish({ ok: false, error: signal.reason });
      try {
        worker = this.createWorker();
        worker.onmessage = ({ data }) => {
          if (data?.ok === true) finish({ ok: true, result: data.result });
          else finish({ ok: false, error: new FramePairError(data?.code ?? 'decoder-error', data?.error ?? 'Invalid Worker reply', data?.field) });
        };
        worker.onerror = event => finish({ ok: false, error: new FramePairError('decoder-error', event.message) });
        worker.onmessageerror = () => finish({ ok: false, error: new FramePairError('decoder-error', 'Worker message could not be decoded') });
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish({ ok: false, error: new FramePairError('budget-exceeded', 'Worker execution deadline exceeded') }), budget.maxElapsedMs);
        if (signal.aborted) { abort(); return; }
        worker.postMessage({ request, sources, base });
      } catch (error) { finish({ ok: false, error }); }
    });
  }
}
