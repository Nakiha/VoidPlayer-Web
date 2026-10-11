export const DEFAULT_ANALYSIS_CONCURRENCY = 2;
export const MAX_ANALYSIS_CONCURRENCY = 8;
export function validateAnalysisConcurrency(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ANALYSIS_CONCURRENCY)
    throw new RangeError('Analysis concurrency must be between 1 and 8');
  return value;
}
/** A page-wide admission limit. Reducing it drains existing work without cancellation. */
export class AnalysisTaskPool {
  private active = 0;
  private limit = DEFAULT_ANALYSIS_CONCURRENCY;
  private waiting: { signal: AbortSignal; start: () => void; abort: () => void }[] = [];
  get concurrency() { return this.limit; }
  setConcurrency(value: number) { this.limit = validateAnalysisConcurrency(value); this.pump(); }
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = { signal, start: () => {
        signal.removeEventListener('abort', entry.abort);
        this.active++;
        let released = false;
        resolve(() => { if (!released) { released = true; this.active--; this.pump(); } });
      }, abort: () => {
        this.waiting = this.waiting.filter(item => item !== entry);
        reject(signal.reason); this.pump();
      } };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.waiting.push(entry); this.pump();
    });
  }
  private pump() {
    while (this.active < this.limit && this.waiting.length) this.waiting.shift()!.start();
  }
}
