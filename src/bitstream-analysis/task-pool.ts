import { AnalysisFailure } from './failure.ts';

/** Queue waiting is distinct from decoder work; polling alone is not progress. */
export class AnalysisPollingBudget {
  private started: number | undefined;
  private advanced: number;
  private seq: number | undefined;
  private continuous: boolean;
  private submitted: number;
  constructor(continuous: boolean, submitted = performance.now()) {
    this.continuous = continuous;
    this.submitted = submitted;
    this.advanced = submitted;
  }
  progress(now = performance.now()) { this.advanced = now; }
  observe(state: { state: string; seq?: number }, now = performance.now()) {
    if (!['queued', 'running', 'complete', 'error', 'cancelled', 'limited', 'unsupported'].includes(state.state) ||
        !Number.isSafeInteger(state.seq) || state.seq! < 0)
      throw new AnalysisFailure('internal-error', 'Invalid analysis task status');
    if (state.state === 'queued') {
      if (this.started !== undefined) throw new AnalysisFailure('internal-error', 'Analysis task returned to queue');
      if (now - this.submitted >= 120000) throw new AnalysisFailure('resource-limit', 'Analysis queue wait exceeded');
      return;
    }
    this.started ??= now;
    if (state.seq !== this.seq) { this.seq = state.seq; this.advanced = now; }
    if (state.state === 'running' && now - (this.continuous ? this.advanced : this.started) >= 30000)
      throw new AnalysisFailure('resource-limit', 'Analysis execution stalled');
  }
}

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
