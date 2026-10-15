import { AnalysisFailure, RetryFullAnalysis } from './failure.ts';
import { isProduct, metadata, metadataBudgetBytes, PRODUCT_LIMIT } from './products.ts';
import type { AnalysisOutput } from './products.ts';
import { RETRY_FULL } from './execution-error.ts';

export const EXECUTION_EXPORTS = ['_vpa_execution_mode', '_vpa_execution_path', '_vpa_execution_reason', '_vpa_execution_retry_code'] as const;
export interface ExecutionPolicy { full: boolean; retries: number }
export const executionPolicy = (): ExecutionPolicy => ({ full: false, retries: 0 });

/** Legacy cores remain full; a partially installed extension is never guessed. */
export function hasExecutionExtension(core: any): boolean {
  if (typeof core._vpa_execution_abi !== 'function') {
    if (EXECUTION_EXPORTS.some(name => typeof core[name] === 'function'))
      throw new AnalysisFailure('internal-error', 'Incomplete analysis execution extension');
    return false;
  }
  if (core._vpa_execution_abi() !== 1 || EXECUTION_EXPORTS.some(name => typeof core[name] !== 'function') ||
      core._vpa_execution_retry_code() !== RETRY_FULL)
    throw new AnalysisFailure('internal-error', 'Analysis execution extension mismatch');
  return true;
}

/** One unpublished attempt. No speculative frame reaches a cache, progress
 * counter, diagram or overlay. Commit uses the existing per-frame backpressure.
 * The existing in-flight byte budget caps speculative owners; large block
 * streams choose full before decoding. No GOP-sized block array is required. */
export async function executeAnalysisAttempt<T>(options: {
  fast: boolean;
  policy: ExecutionPolicy;
  signal: AbortSignal;
  attempt(mode: 0 | 1, publish: (result: AnalysisOutput) => Promise<void>, path: (fast: boolean) => void,
    reserve: (au: number, cost: () => number) => void): Promise<T>;
  publish?: (result: AnalysisOutput) => Promise<void>;
  event?: (event: 'fast-open' | 'full-open' | 'fallback' | 'staged-bytes', bytes?: number) => void;
}): Promise<T> {
  const { signal, policy } = options;
  let fast = options.fast && !policy.full;
  for (;;) {
    signal.throwIfAborted();
    const pending: AnalysisOutput[] = [];
    const aus = new Set<number>();
    const reservations = new Map<number, number>();
    let bytes = 0, selectedFast = fast;
    let value: T;
    try {
      value = await options.attempt(fast ? 1 : 0, async result => {
        signal.throwIfAborted();
        if (!selectedFast) { await options.publish?.(result); signal.throwIfAborted(); return; }
        if (aus.has(result.picture.au)) throw new AnalysisFailure('internal-error', 'Duplicate speculative analysis AU');
        const cost = metadataBudgetBytes(isProduct(result) ? result : metadata(result)) + 40 + (isProduct(result)
          ? result.product === 'blocks' ? result.payload.byteLength : 0
          : result.blocks.length * 128);
        const reserved = reservations.get(result.picture.au);
        if (reserved === undefined || reserved < cost)
          throw new AnalysisFailure('internal-error', 'Analysis owner allocated without a sufficient reservation');
        aus.add(result.picture.au); pending.push(result);
      }, path => { selectedFast = path; options.event?.(path ? 'fast-open' : 'full-open'); }, (au, cost) => {
        signal.throwIfAborted();
        if (!selectedFast) return;
        if (!Number.isSafeInteger(au) || reservations.has(au)) throw new AnalysisFailure('internal-error', 'Invalid speculative reservation');
        const requested = cost();
        if (!Number.isSafeInteger(requested) || requested < 0) throw new AnalysisFailure('internal-error', 'Invalid analysis owner size');
        if (requested > PRODUCT_LIMIT.inFlight - bytes) throw new RetryFullAnalysis('transaction-capacity');
        bytes += requested; reservations.set(au, requested);
        options.event?.('staged-bytes', bytes);
      });
    } catch (error) {
      pending.length = 0;
      signal.throwIfAborted();
      // Only our explicit execution boundary may restart. Cancellation, corrupt
      // input, missing references, ENOMEM and consumer errors are not retries.
      if (!(error instanceof RetryFullAnalysis) || !fast || !selectedFast || policy.retries)
        throw error;
      policy.retries++; policy.full = true; fast = false;
      options.event?.('fallback');
      continue;
    }
    // Outside the retry catch: after the first publication this attempt has won.
    // A consumer cancellation/error cannot start another generation.
    signal.throwIfAborted();
    for (let i = 0; i < pending.length; i++) {
      const result = pending[i];
      await options.publish?.(result);
      pending[i] = undefined as unknown as AnalysisOutput;
      signal.throwIfAborted();
    }
    return value;
  }
}
