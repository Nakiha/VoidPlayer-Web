import { MediaOpenError } from '../media/io/media-errors.ts';
/** Validate external core pointers before TypedArray silently clips or throws. */
export function checkedHeap(heap: Uint8Array, ptr: number, size: number, operation: string): Uint8Array {
  if (!Number.isSafeInteger(ptr) || ptr <= 0 || !Number.isSafeInteger(size) || size < 0 || ptr + size > heap.byteLength) {
    throw new MediaOpenError('decode', `WASM ${operation}时内存范围无效（offset=${ptr}, bytes=${size}, heap=${heap.byteLength}），请重新载入片源。`);
  }
  return heap;
}
