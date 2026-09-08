import { MediaOpenError } from './media-errors.ts';

/** Synchronous Blob AVIO adapter. Allocation size is independent of the fixed
 * transport window; only the decoder worker blocks on each bounded transfer. */
export function rangeBlobReader(shared: SharedArrayBuffer, size: number,
  request: (message: { type: string; offset: number; length: number }) => void) {
  const control = new Int32Array(shared, 0, 4), data = new Uint8Array(shared, 16);
  const fail = (message: string): never => { throw new MediaOpenError('input', message); };
  return {
    blob: { slice(start: number, end: number) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return fail(`WASM Range 参数无效（offset=${start}, end=${end}, size=${size}）。`);
      return { start: Math.min(start, size), end: Math.min(end, size) };
    } },
    reader: { readAsArrayBuffer({ start, end }: { start: number; end: number }) {
      const length = end - start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || length < 0 || end > size) return fail('WASM Range 请求越界。');
      if (length > 64 * 1024 * 1024) throw new MediaOpenError('resource', `WASM 单次读取超过 64 MiB 上限（offset=${start}, bytes=${length}）。`);
      const output = new Uint8Array(length);
      for (let at = 0; at < length;) {
        if (Atomics.load(control, 0) === -2) return fail('媒体读取已取消。');
        const count = Math.min(data.length, length - at);
        // Never overwrite a cancellation arriving between the check and reset.
        const state = Atomics.load(control, 0);
        if (state === -2 || Atomics.compareExchange(control, 0, state, 0) === -2) return fail('媒体读取已取消。');
        request({ type: 'read-range', offset: start + at, length: count });
        if (Atomics.wait(control, 0, 0, 30000) === 'timed-out') return fail(`媒体 Range 读取超时（offset=${start + at}, bytes=${count}）。`);
        const status = Atomics.load(control, 0), received = Atomics.load(control, 1);
        if (status !== 1) return fail(status === -1 ? new TextDecoder().decode(data.subarray(0, Math.max(0, Math.min(received, data.length)))) : '媒体读取已取消。');
        if (received !== count) return fail(`WASM Range 响应长度错误（offset=${start + at}, expected=${count}, actual=${received}）。`);
        output.set(data.subarray(0, received), at); at += received;
      }
      return output.buffer;
    } },
  };
}
