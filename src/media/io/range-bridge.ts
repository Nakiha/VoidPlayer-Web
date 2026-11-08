import { RangeReader } from '../../../shared/media/io/range-reader.ts';
import type { RandomAccessInput } from '../../../shared/media/io/range-reader.ts';
import { MediaOpenError } from '../../../shared/media/io/media-errors.ts';

/** FFmpeg remains synchronous inside its worker; byte IO runs asynchronously outside it. */
export function createRangeBridge(worker: Worker, input: RandomAccessInput) {
  if (typeof SharedArrayBuffer === 'undefined') throw new MediaOpenError('resource', '此封装的 WASM 按需读取需要跨源隔离，请启用服务的 COOP / COEP 响应头。');
  const shared = new SharedArrayBuffer(16 + 256 * 1024);
  const control = new Int32Array(shared, 0, 4), data = new Uint8Array(shared, 16);
  const reader = new RangeReader(input);
  // Preserve the startup bytes already available to the old local Blob
  // observer, even after a full container scan evicts the initial LRU blocks.
  let prefix = new Uint8Array(Math.min(128 * 1024, reader.size)), prefixLength = 0;
  let closed = false, inputWaitMs = 0, readStarted: number | undefined;
  const receive = async (message: { type?: string; offset: number; length: number }) => {
    if (message.type !== 'read-range' || closed) return;
    try {
      if (!Number.isSafeInteger(message.length) || message.length <= 0 || message.length > data.length) throw new MediaOpenError('input', 'WASM 请求的读取块过大。');
      readStarted = performance.now();
      const bytes = await reader.read(message.offset, message.length);
      if (closed) return;
      while (prefixLength < prefix.length) {
        const cached = reader.peek(prefixLength, Math.min(65536, prefix.length - prefixLength));
        if (!cached) break;
        prefix.set(cached, prefixLength); prefixLength += cached.length;
      }
      data.set(bytes); Atomics.store(control, 1, bytes.length); Atomics.store(control, 0, 1);
    } catch (error) {
      if (closed) return;
      const bytes = new TextEncoder().encode(error instanceof Error ? error.message : String(error));
      data.set(bytes.subarray(0, data.length)); Atomics.store(control, 1, Math.min(bytes.length, data.length)); Atomics.store(control, 0, -1);
    } finally {
      if (readStarted !== undefined) inputWaitMs += performance.now() - readStarted;
      readStarted = undefined;
    }
    Atomics.notify(control, 0);
  };
  // Same wire protocol in browser workers and Node's real-core regression tests.
  const browserReceive = (e: MessageEvent) => { void receive(e.data); };
  const nodeWorker = worker as unknown as { on?(type: string, fn: typeof receive): void; off?(type: string, fn: typeof receive): void };
  if (worker.addEventListener) worker.addEventListener('message', browserReceive);
  else nodeWorker.on!('message', receive);
  const cachedWindows = () => {
    const windows = new Map(reader.cachedWindows().map(window => [window.offset, window]));
    for (let offset = 0; offset < prefixLength; offset += 65536) windows.set(offset, {offset,length:Math.min(65536,prefixLength-offset)});
    return [...windows.values()].sort((a,b) => a.offset-b.offset);
  };
  const peek = (offset: number, length: number) => reader.peek(offset,length)
    ?? (!closed && Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && length <= 65536
      && offset + length <= prefixLength ? prefix.slice(offset,offset+length) : undefined);
  return { shared, get inputWaitMs() { return inputWaitMs + (readStarted === undefined ? 0 : performance.now() - readStarted); },
    setPlaybackReadAhead: (enabled: boolean) => reader.setPlaybackReadAhead(enabled), cachedWindows, peek, close() {
    closed = true; reader.close();
    prefix = new Uint8Array(); prefixLength = 0;
    Atomics.store(control, 0, -2); Atomics.notify(control, 0);
    if (worker.removeEventListener) worker.removeEventListener('message', browserReceive);
    else nodeWorker.off!('message', receive);
  } };
}
