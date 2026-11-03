export const DEFAULT_ANALYSIS_CONCURRENCY = 8;
export const MAX_ANALYSIS_CONCURRENCY = 32;
export function validAnalysisConcurrency(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_ANALYSIS_CONCURRENCY;
}
export const ANALYSIS_WORKER_HEAP_BYTES = 1024 ** 3;
export const MAX_ANALYSIS_THREADS = 4;
export const DEFAULT_ANALYSIS_DECODER = { threads: 1, contexts: 1 } as const;
export type AnalysisDecoderSettings = { threads: number; contexts: number };

export function validAnalysisDecoder(value: unknown): value is AnalysisDecoderSettings {
  if (!value || typeof value !== 'object') return false;
  const { threads, contexts } = value as AnalysisDecoderSettings;
  return Number.isInteger(threads) && threads >= 1 && threads <= MAX_ANALYSIS_THREADS &&
    Number.isInteger(contexts) && contexts >= 1 && contexts <= threads;
}
