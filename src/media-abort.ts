/** Cancellation belongs to the load, not to the lifetime of a committed track. */
export function loadAborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
export function onLoadAbort(signal: AbortSignal | undefined, stop: () => void): () => void {
  if (signal?.aborted) { stop(); return () => {}; }
  signal?.addEventListener('abort', stop, { once: true });
  return () => signal?.removeEventListener('abort', stop);
}
export function abortableLoad<T>(pending: Promise<T>, signal?: AbortSignal, releaseLate?: (value: T) => void): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    pending.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) releaseLate?.(value); else resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    }).catch(reject);
  });
}
