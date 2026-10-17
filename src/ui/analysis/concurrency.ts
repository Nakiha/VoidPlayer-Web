import { DEFAULT_ANALYSIS_CONCURRENCY, validateAnalysisConcurrency } from '../../../shared/analysis/bitstream/task-pool.ts';
const KEY = 'voidplayer.analysis-concurrency';
export const ANALYSIS_CONCURRENCY_EVENT = 'analysis-concurrency-change';
let current: number | undefined;
export function analysisConcurrency() {
  if (current !== undefined) return current;
  try { return validateAnalysisConcurrency(Number(localStorage.getItem(KEY) ?? DEFAULT_ANALYSIS_CONCURRENCY)); }
  catch { return DEFAULT_ANALYSIS_CONCURRENCY; }
}
export function setAnalysisConcurrency(value: number) {
  current = validateAnalysisConcurrency(value);
  try { localStorage.setItem(KEY, String(value)); } catch { /* Apply in memory when storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent(ANALYSIS_CONCURRENCY_EVENT, { detail: value }));
}
window.addEventListener('storage', event => {
  if (event.key === KEY || event.key === null) {
    current = undefined;
    window.dispatchEvent(new CustomEvent(ANALYSIS_CONCURRENCY_EVENT, { detail: analysisConcurrency() }));
  }
});
