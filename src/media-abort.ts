/** Cancellation belongs to the load, not to the lifetime of a committed track. */
export function loadAborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
export function onLoadAbort(signal: AbortSignal | undefined, stop: () => void): () => void {
  if (signal?.aborted) { stop(); return () => {}; }
  signal?.addEventListener('abort', stop, { once: true });
  return () => signal?.removeEventListener('abort', stop);
}
/**
 * 共享取消等待：具名 handler + settled 后 removeEventListener。
 * 成功/失败/取消都清理，不依赖 { once:true } 的“abort 触发才移除”语义，
 * 避免同一长期 signal 上监听器线性累积（B3）。
 * 预取消时不挂监听器，且吞掉迟到 pending 的拒绝，避免 unhandledRejection。
 */
export function abortableWait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    // 迟到的 settle 不得产生未处理拒绝；调用方按 abort reason 处理。
    pending.then(undefined, () => {});
    return Promise.reject(signal.reason ?? new DOMException('操作已取消。', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException('操作已取消。', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
export function abortableLoad<T>(pending: Promise<T>, signal?: AbortSignal, releaseLate?: (value: T) => void): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) {
    pending.then(value => { releaseLate?.(value); }, () => {});
    return Promise.reject(signal.reason ?? new DOMException('操作已取消。', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('操作已取消。', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) releaseLate?.(value); else resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    }).catch(reject);
  });
}
