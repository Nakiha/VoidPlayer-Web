export const DEFAULT_ANALYSIS_CONCURRENCY = 8;
export const MAX_ANALYSIS_CONCURRENCY = 32;
export function validAnalysisConcurrency(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_ANALYSIS_CONCURRENCY;
}
export const ANALYSIS_WORKER_HEAP_BYTES = 512 * 1024 * 1024;
