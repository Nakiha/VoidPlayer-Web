import { RangeReader } from './range-reader.ts';
import { MediaOpenError } from './media-errors.ts';

/** FFmpeg remains synchronous inside its worker; fetch and cancellation remain async outside it. */
export function createRangeBridge(worker: Worker, url: string, size: number) {
  if (typeof SharedArrayBuffer === 'undefined') throw new MediaOpenError('resource', '此封装的 WASM 按需读取需要跨源隔离，请启用服务的 COOP / COEP 响应头。');
  const shared = new SharedArrayBuffer(16 + 256 * 1024);
  const control = new Int32Array(shared, 0, 4), data = new Uint8Array(shared, 16);
  const reader = new RangeReader({ url, size });
  let closed = false;
  const receive = async (message: { type?: string; offset: number; length: number }) => {
    if (message.type !== 'read-range' || closed) return;
    try {
      if (!Number.isSafeInteger(message.length) || message.length <= 0 || message.length > data.length) throw new MediaOpenError('input', 'WASM 请求的读取块过大。');
      const bytes = await reader.read(message.offset, message.length);
      if (closed) return;
      data.set(bytes); Atomics.store(control, 1, bytes.length); Atomics.store(control, 0, 1);
    } catch (error) {
      if (closed) return;
      const bytes = new TextEncoder().encode(error instanceof Error ? error.message : String(error));
      data.set(bytes.subarray(0, data.length)); Atomics.store(control, 1, Math.min(bytes.length, data.length)); Atomics.store(control, 0, -1);
    }
    Atomics.notify(control, 0);
  };
  // Same wire protocol in browser workers and Node's real-core regression tests.
  const browserReceive = (e: MessageEvent) => { void receive(e.data); };
  const nodeWorker = worker as unknown as { on?(type: string, fn: typeof receive): void; off?(type: string, fn: typeof receive): void };
  if (worker.addEventListener) worker.addEventListener('message', browserReceive);
  else nodeWorker.on!('message', receive);
  return { shared, close() {
    closed = true; reader.close();
    Atomics.store(control, 0, -2); Atomics.notify(control, 0);
    if (worker.removeEventListener) worker.removeEventListener('message', browserReceive);
    else nodeWorker.off!('message', receive);
  } };
}
